"""Redis Stream index worker.

Consumes ``kh:stream:index.job.created`` with consumer group ``kh-workers``,
runs the indexing pipeline and reports progress through the Java internal
callbacks. Delivery is at-least-once: idempotency is enforced with a 24h
``SETNX`` key per ``eventId``; after ``WORKER_MAX_ATTEMPTS`` failures the message
is copied to ``kh:stream:index.job.created.dlq`` and acknowledged.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import socket
import time
from typing import Any

from knowledge_hub.config.settings import EnvSettings, Settings, load_settings
from knowledge_hub.errors import KhError, WorkerError
from knowledge_hub.rag.pipeline import IndexJobPayload, IndexPipeline, NoopReporter
from knowledge_hub.tools.logging import configure_logging
from knowledge_hub.tools.redis_factory import (
    CONSUMER_GROUP,
    STREAM_INDEX,
    create_async_redis,
    dlq_key,
    idempotency_key,
)
from knowledge_hub.worker.callbacks import JavaCallbacks

logger = logging.getLogger(__name__)

_BACKOFF_S = (0.5, 1.5)


class IndexWorker:
    def __init__(
        self,
        settings: Settings,
        *,
        redis: Any | None = None,
        pipeline: IndexPipeline | None = None,
        stream: str = STREAM_INDEX,
        group: str = CONSUMER_GROUP,
        consumer: str = "",
    ) -> None:
        self.settings = settings
        self.redis = redis
        self.pipeline = pipeline or IndexPipeline(settings)
        self.stream = stream
        self.group = group or CONSUMER_GROUP
        self.consumer = consumer or settings.env.worker.consumer or _default_consumer_name()
        self.max_attempts = max(1, int(settings.env.worker.max_attempts))
        self.idem_ttl = max(60, int(settings.env.worker.idem_ttl_seconds))
        self.block_ms = max(100, int(settings.env.worker.block_ms))
        self._owns_redis = redis is None
        self._stop = asyncio.Event()

    # ------------------------------------------------------------------ setup
    async def _redis(self):  # noqa: ANN202
        if self.redis is None:
            self.redis = await create_async_redis(
                self.settings.env, socket_timeout=self.block_ms / 1000.0 + 5
            )
        return self.redis

    async def ensure_group(self) -> None:
        redis = await self._redis()
        try:
            await redis.xgroup_create(self.stream, self.group, id="0", mkstream=True)
            logger.info("created consumer group %s on %s", self.group, self.stream)
        except Exception as exc:
            if "BUSYGROUP" in str(exc):
                return
            raise

    def reporter(self) -> JavaCallbacks | NoopReporter:
        env: EnvSettings = self.settings.env
        if env.server.backend_base_url and env.server.internal_service_token:
            return JavaCallbacks(
                env.server.backend_base_url,
                env.server.internal_service_token,
                max_attempts=2,
            )
        logger.warning(
            "BACKEND_BASE_URL/INTERNAL_SERVICE_TOKEN not configured; job callbacks are recorded locally only"
        )
        return NoopReporter()

    # ------------------------------------------------------------------- loop
    async def run_forever(self, *, once: bool = False, max_messages: int | None = None) -> int:
        await self.ensure_group()
        processed = 0
        while not self._stop.is_set():
            batch = await self.consume_once()
            processed += batch
            if max_messages is not None and processed >= max_messages:
                break
            if once:
                break
        return processed

    async def consume_once(self) -> int:
        redis = await self._redis()
        try:
            response = await redis.xreadgroup(
                self.group,
                self.consumer,
                {self.stream: ">"},
                count=max(1, int(self.settings.env.worker.batch)),
                block=self.block_ms,
            )
        except Exception as exc:  # Redis down: back off instead of crashing
            logger.warning("xreadgroup failed: %s", exc)
            await asyncio.sleep(1.0)
            return 0
        if not response:
            return 0
        handled = 0
        for _stream_name, messages in response:
            for message_id, fields in messages:
                await self.process_message(message_id, fields)
                handled += 1
        return handled

    async def process_message(self, message_id: str, fields: dict[str, Any]) -> str:
        redis = await self._redis()
        outcome = "error"
        try:
            outcome = await self.handle_fields(fields)
        except Exception:
            logger.exception("unhandled worker error for message %s", message_id)
        finally:
            try:
                await redis.xack(self.stream, self.group, message_id)
            except Exception as exc:  # pragma: no cover - redis outage
                logger.warning("xack failed for %s: %s", message_id, exc)
        return outcome

    # ------------------------------------------------------------------ handle
    async def handle_fields(self, fields: dict[str, Any]) -> str:
        event_id = str(fields.get("eventId") or "").strip()
        payload_text = fields.get("payload") or "{}"
        tenant_from_envelope = str(fields.get("tenantId") or "").strip()
        if not event_id:
            event_id = f"{self.stream}:{hashlib_sha1(payload_text)}"

        redis = await self._redis()
        key = idempotency_key(event_id)
        claimed = await redis.set(key, "1", nx=True, ex=self.idem_ttl)
        if not claimed:
            logger.info("event %s already processed; skipping", event_id)
            return "duplicate"

        try:
            payload_dict = json.loads(payload_text)
            if not isinstance(payload_dict, dict):
                raise WorkerError("payload is not a JSON object")
        except (ValueError, WorkerError) as exc:
            await redis.delete(key)
            await self._dead_letter(fields, error=f"invalid payload: {type(exc).__name__}", attempts=0)
            return "dlq"

        if tenant_from_envelope and not payload_dict.get("tenantId"):
            payload_dict["tenantId"] = tenant_from_envelope

        attempt = 0
        last_error: Exception | None = None
        while attempt < self.max_attempts:
            attempt += 1
            try:
                payload = IndexJobPayload.model_validate(payload_dict)
                outcome = await self.pipeline.run(payload, self.reporter())
                logger.info(
                    "index event %s done (chunks=%s, attempt=%s)", event_id, outcome.chunk_count, attempt
                )
                return "ok"
            except (KhError, ValueError) as exc:
                last_error = exc
                logger.warning(
                    "index event %s attempt %s/%s failed: %s",
                    event_id,
                    attempt,
                    self.max_attempts,
                    type(exc).__name__,
                )
                if attempt < self.max_attempts:
                    await asyncio.sleep(_BACKOFF_S[min(attempt - 1, len(_BACKOFF_S) - 1)])

        await redis.delete(key)
        await self._dead_letter(
            fields,
            error=type(last_error).__name__ if last_error else "unknown",
            attempts=attempt,
        )
        return "dlq"

    async def _dead_letter(self, fields: dict[str, Any], *, error: str, attempts: int) -> None:
        redis = await self._redis()
        entry = {
            "eventId": str(fields.get("eventId") or ""),
            "tenantId": str(fields.get("tenantId") or ""),
            "payload": str(fields.get("payload") or ""),
            "error": error,
            "attempts": str(attempts),
            "failedAt": str(int(time.time() * 1000)),
            "stream": self.stream,
        }
        try:
            await redis.xadd(dlq_key(self.stream), entry, maxlen=10_000, approximate=True)
            logger.error(
                "event %s moved to %s after %s attempts",
                entry["eventId"],
                dlq_key(self.stream),
                attempts,
            )
        except Exception as exc:  # pragma: no cover - redis outage
            logger.error("failed to write DLQ entry: %s", exc)

    async def aclose(self) -> None:
        self._stop.set()
        if self._owns_redis and self.redis is not None:
            try:
                await self.redis.aclose()
            except Exception:  # pragma: no cover
                pass


def hashlib_sha1(text: str) -> str:
    import hashlib

    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def _default_consumer_name() -> str:
    return f"{socket.gethostname()}-{os.getpid()}"


async def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Knowledge Hub index worker")
    parser.add_argument("--once", action="store_true", help="consume a single batch then exit")
    parser.add_argument("--max-messages", type=int, default=None, help="stop after N messages")
    args = parser.parse_args(argv)

    settings = load_settings()
    worker = IndexWorker(settings)
    try:
        processed = await worker.run_forever(once=args.once, max_messages=args.max_messages)
        logger.info("worker stopped after %s message(s)", processed)
        return processed
    finally:
        await worker.aclose()


def main(argv: list[str] | None = None) -> None:
    configure_logging()
    try:
        asyncio.run(run(argv))
    except KeyboardInterrupt:  # pragma: no cover - interactive only
        logger.info("worker interrupted")


if __name__ == "__main__":  # pragma: no cover
    main()


__all__ = ["IndexWorker", "main", "run"]

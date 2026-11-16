"""Worker: idempotency by eventId, retry, DLQ, tenant injection."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

from knowledge_hub.config.settings import Settings
from knowledge_hub.errors import KhError
from knowledge_hub.tools.redis_factory import dlq_key, idempotency_key
from knowledge_hub.worker.main import IndexWorker


class FakeRedis:
    def __init__(self) -> None:
        self.kv: dict[str, str] = {}
        self.added: dict[str, list[dict[str, Any]]] = {}
        self.acked: list[str] = []

    async def set(self, key: str, value: str, nx: bool = False, ex: int | None = None) -> bool | None:
        if nx and key in self.kv:
            return None
        self.kv[key] = value
        return True

    async def delete(self, key: str) -> int:
        return 1 if self.kv.pop(key, None) is not None else 0

    async def xadd(
        self, key: str, fields: dict[str, Any], maxlen: int | None = None, approximate: bool = False
    ) -> str:
        self.added.setdefault(key, []).append(fields)
        return f"{len(self.added[key])}-0"

    async def xack(self, stream: str, group: str, message_id: str) -> int:
        self.acked.append(message_id)
        return 1


class FakePipeline:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.payloads: list[Any] = []

    async def run(self, payload: Any, reporter: Any = None) -> Any:
        self.payloads.append(payload)
        if self.fail:
            raise KhError("pipeline exploded")
        return SimpleNamespace(chunk_count=3)


def _fields(event_id: str = "e1") -> dict[str, Any]:
    return {
        "eventId": event_id,
        "tenantId": "t_777",
        "payload": json.dumps(
            {
                "jobId": "job-1",
                "documentId": "doc-1",
                "versionId": "v1",
                "kbId": "kb_001",
                "objectKey": "docs/a.md",
                "collectionName": "kb_chunks_8",
                "embeddingDim": 8,
                "aclPrincipals": ["tenant:all"],
                "visibility": "public",
            }
        ),
    }


def _worker(settings: Settings, *, fail: bool = False) -> tuple[IndexWorker, FakePipeline, FakeRedis]:
    redis = FakeRedis()
    pipeline = FakePipeline(fail=fail)
    worker = IndexWorker(settings, redis=redis, pipeline=pipeline)  # type: ignore[arg-type]
    return worker, pipeline, redis


async def test_success_then_duplicate(settings: Settings) -> None:
    worker, pipeline, redis = _worker(settings)
    assert await worker.handle_fields(_fields()) == "ok"
    assert await worker.handle_fields(_fields()) == "duplicate"
    assert len(pipeline.payloads) == 1
    assert pipeline.payloads[0].tenant_id == "t_777"
    assert idempotency_key("e1") in redis.kv


async def test_failure_retries_then_dead_letters(settings: Settings) -> None:
    worker, pipeline, redis = _worker(settings, fail=True)
    assert settings.env.worker.max_attempts == 2
    assert await worker.handle_fields(_fields("e2")) == "dlq"
    assert len(pipeline.payloads) == 2
    entries = redis.added[dlq_key("kh:stream:index.job.created")]
    assert len(entries) == 1
    assert entries[0]["eventId"] == "e2"
    assert entries[0]["attempts"] == "2"
    assert entries[0]["error"] == "KhError"
    # The idempotency claim is released so a redelivery can be retried.
    assert idempotency_key("e2") not in redis.kv


async def test_redelivery_after_dlq_can_succeed(settings: Settings) -> None:
    worker, pipeline, redis = _worker(settings, fail=True)
    assert await worker.handle_fields(_fields("e3")) == "dlq"
    pipeline.fail = False
    assert await worker.handle_fields(_fields("e3")) == "ok"


async def test_invalid_payload_goes_to_dlq(settings: Settings) -> None:
    worker, pipeline, redis = _worker(settings)
    result = await worker.handle_fields({"eventId": "e4", "tenantId": "t_1", "payload": "{not json"})
    assert result == "dlq"
    assert pipeline.payloads == []
    assert dlq_key("kh:stream:index.job.created") in redis.added


async def test_missing_event_id_is_derived_from_payload(settings: Settings) -> None:
    worker, pipeline, redis = _worker(settings)
    fields = _fields()
    fields.pop("eventId")
    assert await worker.handle_fields(fields) == "ok"
    assert any(key.startswith("kh:worker:idem:") for key in redis.kv)


async def test_process_message_always_acks(settings: Settings) -> None:
    worker, pipeline, redis = _worker(settings, fail=True)
    result = await worker.process_message("1-0", _fields("e5"))
    assert result == "dlq"
    assert redis.acked == ["1-0"]


async def test_consumer_group_is_created(settings: Settings) -> None:
    created: list[tuple[str, str]] = []

    class GroupRedis(FakeRedis):
        async def xgroup_create(self, stream: str, group: str, **kwargs: Any) -> bool:
            created.append((stream, group))
            return True

    worker = IndexWorker(settings, redis=GroupRedis(), pipeline=FakePipeline())  # type: ignore[arg-type]
    await worker.ensure_group()
    assert created == [("kh:stream:index.job.created", "kh-workers")]

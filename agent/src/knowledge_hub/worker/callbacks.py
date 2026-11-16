"""Java internal callback client (docs/12 §4) with retry.

Uses ``X-Internal-Token`` exactly as the Spring ``InternalTokenGuard`` expects.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from knowledge_hub.errors import WorkerError

logger = logging.getLogger(__name__)


class JavaCallbacks:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout_s: float = 5.0,
        max_attempts: int = 3,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = (base_url or "").rstrip("/")
        self.token = token or ""
        self.timeout_s = timeout_s
        self.max_attempts = max(1, max_attempts)
        self._transport = transport

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["X-Internal-Token"] = self.token
        return headers

    async def _post(self, path: str, payload: dict[str, Any]) -> None:
        if not self.base_url:
            raise WorkerError("BACKEND_BASE_URL is not configured")
        url = f"{self.base_url}{path}"
        last_error: Exception | None = None
        for attempt in range(self.max_attempts):
            try:
                async with httpx.AsyncClient(
                    timeout=self.timeout_s, transport=self._transport
                ) as client:
                    resp = await client.post(url, json=payload, headers=self._headers())
                if resp.status_code < 300:
                    return
                last_error = WorkerError(f"callback {path} rejected ({resp.status_code})")
            except httpx.HTTPError as exc:
                last_error = exc
            await asyncio.sleep(0.2 * (2**attempt))
        raise WorkerError(f"callback {path} failed: {type(last_error).__name__}")

    # ------------------------------------------------------- JobReporter API
    async def start(self, job_id: str, stage: str = "parsing") -> None:
        await self._post(f"/internal/v1/index-jobs/{job_id}/start", {"stage": stage})

    async def progress(self, job_id: str, stage: str, progress: int) -> None:
        await self._post(
            f"/internal/v1/index-jobs/{job_id}/progress",
            {"stage": stage, "progress": max(0, min(100, int(progress)))},
        )

    async def chunks(self, job_id: str, chunks: list[dict[str, Any]]) -> None:
        await self._post(f"/internal/v1/index-jobs/{job_id}/chunks", {"chunks": chunks})

    async def complete(
        self,
        job_id: str,
        *,
        chunk_count: int,
        token_count: int,
        block_snapshot_key: str = "",
        chunk_snapshot_key: str = "",
    ) -> None:
        await self._post(
            f"/internal/v1/index-jobs/{job_id}/complete",
            {
                "chunkCount": chunk_count,
                "tokenCount": token_count,
                "blockSnapshotKey": block_snapshot_key,
                "chunkSnapshotKey": chunk_snapshot_key,
            },
        )

    async def fail(self, job_id: str, *, error_code: str, message: str) -> None:
        try:
            await self._post(
                f"/internal/v1/index-jobs/{job_id}/fail",
                {"errorCode": error_code, "message": message[:500]},
            )
        except WorkerError as exc:
            # The failure callback must never mask the original error.
            logger.warning("fail callback dropped for job %s: %s", job_id, exc)


__all__ = ["JavaCallbacks"]

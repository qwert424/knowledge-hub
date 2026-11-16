"""OpenSandbox client used by the agent's code-execution tools.

The sandbox server is optional: when the endpoint or API key is missing, or the
SDK is not installed, :attr:`SandboxClient.configured` is ``False`` and the
runtime simply does not advertise sandbox tools. A missing sandbox must never
break chat.

One sandbox is kept per conversation key so a multi-step task (write file ->
run it -> read output) sees its own files, and it is reused across turns.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_IMAGE = "python:3.12-slim"
_MAX_OUTPUT_CHARS = 8000


@dataclass(slots=True)
class ExecResult:
    exit_code: int
    output: str

    @property
    def ok(self) -> bool:
        return self.exit_code == 0


class SandboxUnavailable(RuntimeError):
    """The sandbox server is not configured or refused the request."""


class SandboxClient:
    def __init__(
        self,
        *,
        domain: str = "",
        api_key: str = "",
        image: str = _DEFAULT_IMAGE,
        timeout_seconds: int = 600,
        command_timeout_seconds: int = 90,
        factory: Any | None = None,
    ) -> None:
        self.domain = (domain or "").strip()
        self.api_key = (api_key or "").strip()
        self.image = image or _DEFAULT_IMAGE
        self.timeout_seconds = max(30, int(timeout_seconds))
        self.command_timeout_seconds = max(5, int(command_timeout_seconds))
        self._factory = factory
        self._sandboxes: dict[str, Any] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    @property
    def configured(self) -> bool:
        if self._factory is not None:
            return True
        return bool(self.domain and self.api_key)

    # ------------------------------------------------------------------ session
    def _lock(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    async def _create(self, key: str) -> Any:
        if self._factory is not None:
            return await self._factory(key)
        if not self.configured:
            raise SandboxUnavailable("sandbox is not configured")

        try:
            from opensandbox import Sandbox
            from opensandbox.config import ConnectionConfig
        except ImportError as exc:  # pragma: no cover - packaging guard
            raise SandboxUnavailable("opensandbox SDK is not installed") from exc

        connection = ConnectionConfig(
            domain=self.domain, api_key=self.api_key, use_server_proxy=True
        )
        return await Sandbox.create(
            image=self.image,
            connection_config=connection,
            timeout=timedelta(seconds=self.timeout_seconds),
            ready_timeout=timedelta(seconds=180),
        )

    async def _sandbox(self, key: str) -> Any:
        existing = self._sandboxes.get(key)
        if existing is not None:
            return existing
        async with self._lock(key):
            cached = self._sandboxes.get(key)
            if cached is not None:
                return cached
            sandbox = await self._create(key)
            self._sandboxes[key] = sandbox
            return sandbox

    # ------------------------------------------------------------------- tools
    async def execute(
        self, key: str, command: str, *, timeout_seconds: int | None = None
    ) -> ExecResult:
        sandbox = await self._sandbox(key)
        timeout = max(5, int(timeout_seconds or self.command_timeout_seconds))
        try:
            from opensandbox.models.execd import RunCommandOpts
        except ImportError:  # pragma: no cover - packaging guard
            RunCommandOpts = None  # type: ignore[assignment]

        opts = RunCommandOpts(timeout=timedelta(seconds=timeout)) if RunCommandOpts else None
        try:
            execution = await sandbox.commands.run(command, opts=opts)
        except Exception as exc:
            raise SandboxUnavailable(f"sandbox execute failed: {type(exc).__name__}") from exc
        return ExecResult(
            exit_code=int(getattr(execution, "exit_code", 0) or 0),
            output=str(getattr(execution, "output", execution))[:_MAX_OUTPUT_CHARS],
        )

    async def write_text(self, key: str, path: str, content: str) -> None:
        await self.write_bytes(key, path, content.encode("utf-8"))

    async def write_bytes(self, key: str, path: str, content: bytes) -> None:
        sandbox = await self._sandbox(key)
        try:
            await sandbox.files.write_file(path, content)
        except Exception as exc:
            raise SandboxUnavailable(f"sandbox write failed: {type(exc).__name__}") from exc

    async def read_text(self, key: str, path: str) -> str:
        raw = await self.read_bytes(key, path)
        return raw.decode("utf-8", errors="replace")[:_MAX_OUTPUT_CHARS]

    async def read_bytes(self, key: str, path: str, *, max_bytes: int = 6_000_000) -> bytes:
        sandbox = await self._sandbox(key)
        try:
            raw = await sandbox.files.read_bytes(path)
        except Exception as exc:
            raise SandboxUnavailable(f"sandbox read failed: {type(exc).__name__}") from exc
        if len(raw) > max_bytes:
            raise SandboxUnavailable(f"sandbox file too large ({len(raw)} bytes)")
        return raw

    async def list_files(self, key: str, path: str, *, limit: int = 200) -> list[str]:
        """Absolute file paths under ``path`` (dirs excluded), depth-bounded."""
        result = await self.execute(
            key,
            f"find {path} -maxdepth 6 -type f 2>/dev/null | head -n {max(1, int(limit))}",
            timeout_seconds=30,
        )
        return [line.strip() for line in result.output.splitlines() if line.strip()]

    async def close(self, key: str | None = None) -> None:
        for item in [key] if key else list(self._sandboxes):
            sandbox = self._sandboxes.pop(item, None)
            if sandbox is None:
                continue
            try:
                await sandbox.close()
            except Exception:  # pragma: no cover - best effort
                pass


__all__ = ["ExecResult", "SandboxClient", "SandboxUnavailable"]

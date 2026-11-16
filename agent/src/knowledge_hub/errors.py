"""Contract error codes (docs/03 §6.5) mapped to HTTP statuses.

Every failure that can reach the Java backend is expressed as a :class:`KhError`
subclass so the API layer and the SSE layer emit the same code vocabulary.
"""

from __future__ import annotations

from typing import Any


class KhError(Exception):
    """Base error carrying a contract error code."""

    code = "INTERNAL_ERROR"
    http_status = 500
    retryable = False

    def __init__(
        self,
        message: str = "",
        *,
        code: str | None = None,
        http_status: int | None = None,
        retryable: bool | None = None,
    ) -> None:
        super().__init__(message or self.code)
        self.message = message or self.code
        if code is not None:
            self.code = code
        if http_status is not None:
            self.http_status = http_status
        if retryable is not None:
            self.retryable = retryable

    def to_event(self) -> dict[str, Any]:
        """Payload for an SSE ``error`` event."""
        return {"code": self.code, "message": self.message, "retryable": self.retryable}

    def to_body(self, request_id: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"code": self.code, "message": self.message}
        if request_id:
            body["request_id"] = request_id
        return body

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"{type(self).__name__}(code={self.code!r}, message={self.message!r})"


class TicketError(KhError):
    code = "AUTH_401"
    http_status = 401


class TicketScopeError(TicketError):
    code = "AUTH_403"
    http_status = 403


class PermissionDenied(KhError):
    code = "AUTH_403"
    http_status = 403


class TenantMismatch(KhError):
    code = "TENANT_MISMATCH"
    http_status = 403


class FilterError(KhError):
    code = "INTERNAL_ERROR"
    http_status = 400


class RetrievalTimeout(KhError):
    code = "RETRIEVAL_TIMEOUT"
    http_status = 504
    retryable = True


class MilvusUnavailable(KhError):
    code = "RETRIEVAL_UNAVAILABLE"
    http_status = 503
    retryable = True


class LLMUnavailable(KhError):
    code = "MODEL_UNAVAILABLE"
    http_status = 503
    retryable = True


class LLMTimeout(LLMUnavailable):
    pass


class EmbeddingError(LLMUnavailable):
    pass


class LoaderError(KhError):
    code = "INTERNAL_ERROR"
    http_status = 500


class UnsupportedFile(LoaderError):
    code = "UNSUPPORTED_FILE"
    http_status = 415


class ParserError(LoaderError):
    pass


class ConfigError(KhError):
    pass


class WorkerError(KhError):
    pass


__all__ = [
    "ConfigError",
    "EmbeddingError",
    "FilterError",
    "KhError",
    "LLMTimeout",
    "LLMUnavailable",
    "LoaderError",
    "MilvusUnavailable",
    "ParserError",
    "PermissionDenied",
    "RetrievalTimeout",
    "TenantMismatch",
    "TicketError",
    "TicketScopeError",
    "UnsupportedFile",
    "WorkerError",
]

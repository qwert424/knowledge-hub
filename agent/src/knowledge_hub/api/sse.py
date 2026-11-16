"""SSE framing for docs/12 §3.3 (``event:`` + ``data:`` blocks)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import orjson

SSE_MEDIA_TYPE = "text/event-stream"
SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def encode_sse(event: str, data: Mapping[str, Any] | str | None = None) -> str:
    """Render a single SSE frame. ``data`` is JSON-encoded unless it is a string."""
    if data is None:
        payload = "{}"
    elif isinstance(data, str):
        payload = data
    else:
        payload = orjson.dumps(data).decode("utf-8")
    payload = payload.replace("\r", "").replace("\n", " ")
    return f"event: {event}\ndata: {payload}\n\n"


def encode_comment(text: str = "ping") -> str:
    return f": {text}\n\n"


__all__ = ["SSE_HEADERS", "SSE_MEDIA_TYPE", "encode_comment", "encode_sse"]

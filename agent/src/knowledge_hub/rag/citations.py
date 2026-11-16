"""Citation metadata helpers shared by retrieval and chat.

Rules (contract with the Portal):
* ``title`` never degrades to a block type while any real title exists;
* ``url`` is only ever the document's real ``source_url`` - no synthetic
  ``kh://`` deep links are invented (legacy rows are sanitised to ``""``);
* ``snippet`` is a short window around the query match, not the whole chunk.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

MAX_SNIPPET_CHARS = 240
_ELLIPSIS = "…"
_INTERNAL_SCHEMES = ("kh://", "minio://", "file://")
_TOKEN_SPLIT = re.compile(r"[\s,，。;；:：/|、()（）\[\]【】]+")


def clean_source_url(url: str | None) -> str:
    """Return a real document URL, or ``""`` when the stored value is internal."""
    value = (url or "").strip()
    if not value:
        return ""
    lowered = value.lower()
    if any(lowered.startswith(scheme) for scheme in _INTERNAL_SCHEMES):
        return ""
    return value


def resolve_title(
    doc_title: str | None,
    title_path: Sequence[str] | None,
    block_type: str | None,
) -> str:
    """Document title -> first non-empty title_path segment -> block type."""
    if doc_title and doc_title.strip():
        return doc_title.strip()
    for part in title_path or ():
        text = (part or "").strip()
        if text:
            return text
    block = (block_type or "").strip()
    return block or "chunk"


def trim_snippet(text: str, query: str = "", limit: int = MAX_SNIPPET_CHARS) -> str:
    """Trim ``text`` to <= ``limit`` chars, centered on the best query match."""
    normalized = re.sub(r"\s+", " ", text or "").strip()
    if len(normalized) <= limit:
        return normalized
    budget = max(20, limit - 2)  # leave room for up to two ellipses

    index = _find_match(normalized, query)
    if index < 0:
        return normalized[:budget].rstrip() + _ELLIPSIS

    start = max(0, index - budget // 4)
    end = min(len(normalized), start + budget)
    start = max(0, end - budget)

    content = normalized[start:end].strip()
    prefix = _ELLIPSIS if start > 0 else ""
    suffix = _ELLIPSIS if end < len(normalized) else ""
    result = f"{prefix}{content}{suffix}"
    return result[:limit]


def _find_match(text: str, query: str) -> int:
    query = (query or "").strip()
    if not query:
        return -1
    lowered = text.lower()
    candidates = [query]
    candidates.extend(token for token in _TOKEN_SPLIT.split(query) if len(token) >= 2)
    # CJK queries rarely contain spaces, so also try 2-char sliding windows to find partial overlap.
    for token in list(candidates):
        if _is_cjk(token) and len(token) > 2:
            candidates.extend(token[i : i + 2] for i in range(len(token) - 1))
    best = -1
    for candidate in candidates:
        position = lowered.find(candidate.lower())
        if position >= 0 and (best < 0 or position < best):
            best = position
    return best


def _is_cjk(value: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in value)


__all__ = ["MAX_SNIPPET_CHARS", "clean_source_url", "resolve_title", "trim_snippet"]

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


# ``[《文档标题》]`` / ``[《文档标题》](链接)``：模型自造的引用写法
_BOOK_TITLE_REF = re.compile(r"[\[【]\s*《([^》]{1,120})》\s*[\]】](?:\([^)\s]*\))?")
# ``[![alt](img)](link)``：图片被多包了一层链接（模型为了“带引用”常这么写）
_LINKED_IMAGE = re.compile(r"\[\s*(!\[[^\]]*\]\([^)\s]*\))\s*\]\([^)\s]*\)")
_HOLD_MAX = 160


def _plain(text: str) -> str:
    """比较用：去掉书名号/空白，只留正文。"""
    return re.sub(r"[\s《》「」【】\[\]（）()]", "", text or "")


class CitationMarker:
    """把模型自造的引用改写成契约里的 ``[cN]``，并且对流式输出安全。

    为什么需要它：文末的 ``[《PROD-002_A400产品与配置说明》]`` 在前端只是一个方括号，
    不是可点的来源（来源面板按 ``[cN]`` 关联）。与其在提示词里反复求模型，
    不如在输出侧按材料标题反查编号。
    """

    def __init__(self, titles: Sequence[str]) -> None:
        self._titles = [
            (index, plain)
            for index, title in enumerate(titles, start=1)
            if (plain := _plain(title))
        ]
        self._held = ""

    def _resolve(self, raw: str) -> str:
        needle = _plain(raw)
        if not needle:
            return ""
        for index, title in self._titles:
            if needle == title or needle in title or title in needle:
                return f"[c{index}]"
        return ""

    def _rewrite(self, text: str) -> str:
        if not text:
            return text
        text = _LINKED_IMAGE.sub(lambda match: match.group(1), text)

        def _replace(match: re.Match[str]) -> str:
            marker = self._resolve(match.group(1))
            return marker or match.group(0)

        return _BOOK_TITLE_REF.sub(_replace, text)

    def feed(self, text: str) -> str:
        """吃一段增量，返回可以安全发给前端的部分。"""
        if not text:
            return ""
        buffer = self._held + text
        cut = len(buffer)
        start = buffer.rfind("[")
        unclosed = start >= 0 and "]" not in buffer[start:] and "】" not in buffer[start:]
        if unclosed and len(buffer) - start <= _HOLD_MAX:
            cut = start
        elif buffer.endswith("!"):
            cut = len(buffer) - 1
        self._held = buffer[cut:]
        return self._rewrite(buffer[:cut])

    def flush(self) -> str:
        tail, self._held = self._held, ""
        return self._rewrite(tail)


def rewrite_citation_markers(text: str, titles: Sequence[str]) -> str:
    """非流式版本：一次把所有自造引用改写掉。"""
    marker = CitationMarker(titles)
    return marker.feed(text or "") + marker.flush()


__all__ = [
    "MAX_SNIPPET_CHARS",
    "CitationMarker",
    "clean_source_url",
    "resolve_title",
    "rewrite_citation_markers",
    "trim_snippet",
]

"""Text helpers shared by parser, splitter and prompt builder."""

from __future__ import annotations

import hashlib
import re

_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_WORD = re.compile(r"[A-Za-z0-9_]+")
_SENTENCE_SPLIT = re.compile(r"(?<=[。！？；!?;])\s*|\n+")
_NAV_HINT = re.compile(
    r"首页|上一页|下一页|返回顶部|回到顶部|登录|注册|目录|更多|阅读全文|分享|收藏|"
    r"\bHome\b|\bMenu\b|\bLogin\b|\bSign in\b|\bBack to top\b|\bSkip to content\b|"
    r"\bCopyright\b|\bAll rights reserved\b|\bRead more\b",
    re.IGNORECASE,
)
_MARKDOWN_LINK = re.compile(r"\[[^\]\n]{0,80}\]\([^)\n]{0,200}\)")


def estimate_tokens(text: str) -> int:
    """Cheap token estimate: CJK chars count 1, latin words ~1.3 tokens."""
    if not text:
        return 0
    cjk = len(_CJK.findall(text))
    words = len(_WORD.findall(text))
    return cjk + int(words * 1.3 + 0.999)


def cjk_ratio(text: str) -> float:
    if not text:
        return 0.0
    letters = [ch for ch in text if not ch.isspace()]
    if not letters:
        return 0.0
    return len(_CJK.findall(text)) / len(letters)


def detect_lang(text: str) -> str:
    return "zh" if cjk_ratio(text) >= 0.15 else "en"


def normalize_whitespace(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\u3000]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_sentences(text: str) -> list[str]:
    if not text:
        return []
    parts = [part.strip() for part in _SENTENCE_SPLIT.split(text)]
    return [part for part in parts if part]


def is_navigation_text(text: str) -> bool:
    """Heuristic for menus / breadcrumbs / footers that pollute retrieval."""
    stripped = (text or "").strip()
    if not stripped:
        return True
    if len(stripped) <= 120:
        hint_hits = len(_NAV_HINT.findall(stripped))
        if hint_hits >= 1:
            return True
    if len(stripped) <= 400:
        links = _MARKDOWN_LINK.findall(stripped)
        if len(links) >= 3 and len(links) * 25 >= len(stripped):
            return True
        hint_hits = len(_NAV_HINT.findall(stripped))
        if hint_hits >= 3:
            return True
    # Symbol-heavy strings (navigation bars, table of contents dots)
    symbols = sum(1 for ch in stripped if ch in "|>·•-—…/\\")
    if len(stripped) <= 200 and symbols >= max(8, len(stripped) // 8):
        return True
    return False


def stable_id(*parts: str, length: int = 24) -> str:
    digest = hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()
    return digest[:length]


def abbreviate(text: str, limit: int) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


__all__ = [
    "abbreviate",
    "cjk_ratio",
    "detect_lang",
    "estimate_tokens",
    "is_navigation_text",
    "normalize_whitespace",
    "split_sentences",
    "stable_id",
]

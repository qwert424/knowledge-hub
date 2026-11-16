"""会话历史压缩。

长对话不能无限塞进上下文：既贵又会把最近几轮挤出去。这里把「较早的消息」压成一段摘要，
只保留最近几轮原样，摘要按会话缓存在 Redis（同一段历史不重复总结）。

降级原则：总结失败就当没总结（返回原文），绝不让一次摘要失败把回答整条打断。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping, Sequence
from typing import Any

from knowledge_hub.rag.textutil import abbreviate

logger = logging.getLogger(__name__)

#: 原样保留最近多少条消息（4 轮问答 = 8 条）
KEEP_MESSAGES = 8
#: 少于这么多条就不压缩，省一次模型调用
MIN_MESSAGES = 14
#: 送进摘要模型的最大字符数
MAX_INPUT_CHARS = 6000
SUMMARY_CACHE_PREFIX = "kh:chat:hist:"

_SUMMARY_SYSTEM = (
    "你是对话纪要整理器。把给定的历史对话压缩成一段中文纪要，供后续问答参考。\n"
    "要求：\n"
    "1. 只保留与后续提问有关的事实：用户问过什么、已确认的结论、用户明确说过的偏好或约束；\n"
    "2. 不要编造，不要评价，不要输出'用户问'以外的角色设定；\n"
    "3. 按时间顺序，用不超过 12 条短句，总长不超过 400 字；\n"
    "4. 直接输出纪要正文，不要标题、不要前言。"
)


def _clean(history: Sequence[Mapping[str, Any]] | None) -> list[dict[str, str]]:
    cleaned: list[dict[str, str]] = []
    for item in history or []:
        role = str(item.get("role") or "").strip()
        content = str(item.get("content") or "").strip()
        if role not in {"user", "assistant"} or not content:
            continue
        cleaned.append({"role": role, "content": content})
    return cleaned


def _transcript(messages: Sequence[Mapping[str, str]]) -> str:
    lines: list[str] = []
    for item in messages:
        who = "用户" if item["role"] == "user" else "助手"
        lines.append(f"{who}：{abbreviate(item['content'], 800)}")
    return abbreviate("\n".join(lines), MAX_INPUT_CHARS)


async def compress_history(
    *,
    history: Sequence[Mapping[str, Any]] | None,
    llm: Any,
    model: str,
    conversation_id: str = "",
    redis: Any = None,
    keep: int = KEEP_MESSAGES,
) -> tuple[str, list[dict[str, str]]]:
    """返回 ``(摘要, 需要原样带上的近期消息)``。

    摘要为空字符串表示"没有摘要"（历史太短、或总结失败）。
    """
    cleaned = _clean(history)
    if len(cleaned) < max(MIN_MESSAGES, keep + 2):
        return "", cleaned

    older = cleaned[:-keep]
    recent = cleaned[-keep:]
    cache_key = f"{SUMMARY_CACHE_PREFIX}{conversation_id}" if conversation_id else ""

    if cache_key and redis is not None:
        try:
            raw = await redis.get(cache_key)
            if raw:
                cached = json.loads(raw)
                upto = int(cached.get("upto") or 0)
                summary = str(cached.get("summary") or "")
                # 缓存覆盖的是一个前缀：前缀没变就把后面的原文直接带上；
                # 但如果后面又堆了太多（> 2 倍保留量），说明该把更多历史折进摘要了。
                if summary and 0 < upto <= len(cleaned):
                    tail = cleaned[upto:]
                    if len(tail) <= keep * 2:
                        return summary, tail
        except Exception as exc:  # pragma: no cover - 缓存不可用不影响主流程
            logger.debug("history summary cache read failed: %s", exc)

    try:
        resp = await llm.chat(
            [
                {"role": "system", "content": _SUMMARY_SYSTEM},
                {"role": "user", "content": _transcript(older)},
            ],
            model=model,
            temperature=0.0,
            max_tokens=600,
            timeout_s=20.0,
        )
        summary = _extract(resp)
    except Exception as exc:  # pragma: no cover - 网络/模型问题一律降级
        logger.info("history compression skipped: %s", exc)
        return "", recent

    if not summary:
        return "", recent

    if cache_key and redis is not None:
        try:
            await redis.set(
                cache_key,
                json.dumps({"upto": len(older), "summary": summary}, ensure_ascii=False),
                ex=14 * 24 * 3600,
            )
        except Exception as exc:  # pragma: no cover
            logger.debug("history summary cache write failed: %s", exc)
    return summary, recent


def _extract(resp: Mapping[str, Any]) -> str:
    choices = resp.get("choices") or []
    if not choices:
        return ""
    message = (choices[0] or {}).get("message") or {}
    return str(message.get("content") or "").strip()


def summary_message(summary: str) -> dict[str, str]:
    """把摘要包成一条 system 消息：明确标注"可能不完整"，避免模型当成原文引用。"""
    return {
        "role": "system",
        "content": (
            "以下是本次会话较早部分的纪要（由前文压缩而来，可能不完整）：\n"
            f"{summary}\n"
            "需要精确细节时以最近几轮对话为准；纪要里没有的事实不要编造。"
        ),
    }


__all__ = ["KEEP_MESSAGES", "MIN_MESSAGES", "compress_history", "summary_message"]

"""Deterministic fallback options for ``awaiting_user``.

模型补候选靠一次额外调用，网关抖动或输出不是 JSON 时就拿不到选项——
前端只剩一句“请在下面补充”，人在回路等于失效。这里按问题里的关键词给一组
永远可用的候选，保证任何反问都有可点的按钮。
"""

from __future__ import annotations

import re
from collections.abc import Sequence

_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    (r"ppt|幻灯片|演示|课件", ("项目汇报", "产品介绍", "年度总结", "培训课件")),
    (r"复盘", ("季度复盘", "项目复盘", "月度复盘")),
    (r"周报|日报|月报|总结|汇报", ("本周进展", "本月总结", "季度复盘")),
    (r"外观|照片|图片|截图|示意图|图", ("产品外观图", "内部结构图", "接口布局图")),
    (r"差旅|报销|费用", ("国内出差", "国际出差", "费用标准")),
)

_DEFAULT: tuple[str, ...] = ("按默认方式继续", "我来补充说明")


def fallback_options(question: str, *, limit: int = 4) -> list[str]:
    """按关键词给出候选，保证至少两个。"""
    text = (question or "").strip()
    for pattern, options in _RULES:
        if re.search(pattern, text, re.I):
            return list(options[:limit])
    return list(_DEFAULT)


def as_options(values: Sequence[str] | None, question: str = "") -> list[str]:
    """模型候选不足两个时用 fallback 补齐。"""
    cleaned = [str(item).strip() for item in (values or []) if str(item).strip()]
    if len(cleaned) >= 2:
        return cleaned
    for option in fallback_options(question):
        if option not in cleaned:
            cleaned.append(option)
    return cleaned[:4]


__all__ = ["as_options", "fallback_options"]

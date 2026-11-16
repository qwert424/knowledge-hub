"""Per-request output budget.

``llm.max_tokens`` 是"一轮回答最多多少 token"的硬上限（默认 2048）。
对问答足够，但「做 10 页 PPT」「写方案/长文」这类长文请求会在第 6 页被硬切断——
用户看到的就是回答写到一半没了。这里按问题意图抬高上限，仍然保留硬顶。
"""

from __future__ import annotations

import re

#: 长文类意图：这些请求天然要写很多字
_LONG_FORM = re.compile(
    r"ppt|幻灯片|演示文稿|课件|讲稿|方案|报告|复盘|总结|文章|大纲|计划书|白皮书|"
    r"培训材料|逐页|每一页|详细展开|多写|长篇|不少于\s*\d+\s*字",
    re.I,
)

#: 长文请求的输出上限（网关实测支持到 8192）
LONG_FORM_TOKENS = 6144
#: 兜底硬顶，避免模型失控刷 token
MAX_OUTPUT_TOKENS = 8192


def output_budget(query: str, base: int, *, long_form: int = LONG_FORM_TOKENS) -> int:
    """长文请求放宽输出预算，其余保持原值。"""
    default = max(1, int(base or 1))
    if not (query or "").strip():
        return default
    if not _LONG_FORM.search(query):
        return default
    return min(MAX_OUTPUT_TOKENS, max(default, long_form))


__all__ = ["LONG_FORM_TOKENS", "MAX_OUTPUT_TOKENS", "output_budget"]

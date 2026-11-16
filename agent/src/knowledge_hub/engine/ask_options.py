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
    (r"主题|内容要点|方向", ("产品介绍", "项目汇报", "年度总结")),
    (r"受众|听众|对象|给谁看", ("管理层", "客户", "内部团队", "公开分享")),
    (r"页数|多少页|篇幅", ("10 页以内", "10-20 页", "20-30 页")),
    (r"风格|调性|配色", ("正式稳重", "科技简洁", "活泼轻松")),
    (r"复盘", ("季度复盘", "项目复盘", "月度复盘")),
    (r"周报|日报|月报|总结|汇报", ("本周进展", "本月总结", "季度复盘")),
    (r"外观|照片|图片|截图|示意图|图", ("产品外观图", "内部结构图", "接口布局图")),
    (r"差旅|报销|费用", ("国内出差", "国际出差", "费用标准")),
)

_DEFAULT: tuple[str, ...] = ("按默认方式继续", "我来补充说明")

# 「其他/自定义」这类候选不是答案，是“我要自己写”：前端点它只聚焦输入框
_CUSTOM_HINT = "其他（我来描述）"
_CUSTOM_PATTERN = re.compile(r"其他|其它|自定义|自己(写|描述|填)|我来(写|描述|补充|填)|不限定")
# 模型常把整句要求塞进选项里，按钮会变得很长很啰嗦
_TOO_LONG_OPTION = 16


def _clean_option(text: str) -> str:
    """把「其他主题（请补充说明主题、受众和大致页数）」压成「其他（我来描述）」。"""
    value = (text or "").strip()
    if not value:
        return ""
    if _CUSTOM_PATTERN.search(value):
        return _CUSTOM_HINT
    if len(value) > _TOO_LONG_OPTION:
        # 长句子多半是解释而不是选项：去掉括号补充说明，仍超长就丢掉
        short = re.split(r"[（(]", value)[0].strip()
        return short if 0 < len(short) <= _TOO_LONG_OPTION else ""
    return value


def fallback_options(question: str, *, limit: int = 4) -> list[str]:
    """按关键词给出候选，保证至少两个。"""
    text = (question or "").strip()
    for pattern, options in _RULES:
        if re.search(pattern, text, re.I):
            return list(options[:limit])
    return list(_DEFAULT)


def as_options(values: Sequence[str] | None, question: str = "") -> list[str]:
    """清洗模型候选：去重、压短，并保证末尾有一个“我来描述”的自由输入项。"""
    cleaned: list[str] = []
    for item in values or []:
        option = _clean_option(str(item))
        if option and option not in cleaned:
            cleaned.append(option)
    if len(cleaned) < 2:
        for option in fallback_options(question):
            if option not in cleaned:
                cleaned.append(option)
    cleaned = [option for option in cleaned if option != _CUSTOM_HINT][:3]
    # 永远留一个自由输入项：任何反问都可能需要用户自己写
    return [*cleaned, _CUSTOM_HINT]


# 「1）主题…2）受众…3）页数…」这类一次问多件事的写法
_INDEX_MARK = re.compile(r"[1-9１-９][）).、]|[①-⑨]")
_MULTI_SPLIT = re.compile(r"[；;]|\n")
_TRAILING_PAREN = re.compile(r"[（(][^（）()]*[）)]?$")


def split_questions(text: str, *, limit: int = 4) -> list[str]:
    """把「一次问三件事」拆成三个子问题；拆不出来就返回空列表。

    为什么要拆：整段倒给用户，前端只能给一组候选，用户还得自己对着三个问题打字。
    拆开后每项各自带候选，用户点三下就能答完。

    只按编号（1）2）3））、分号、换行拆——不按问号拆，否则
    「需要哪个产品的外观图？A200 还是 A400？」会被误当成两个问题。
    """
    raw = (text or "").strip()
    if not raw:
        return []
    marks = list(_INDEX_MARK.finditer(raw))
    pieces: list[str]
    if len(marks) >= 2:
        pieces = []
        for index, mark in enumerate(marks):
            end = marks[index + 1].start() if index + 1 < len(marks) else len(raw)
            pieces.append(raw[mark.end() : end])
    else:
        pieces = _MULTI_SPLIT.split(raw)
    questions: list[str] = []
    for piece in pieces:
        cleaned = _strip_index(piece).strip(" ；;，,。\n")
        cleaned = _TRAILING_PAREN.sub("", cleaned).strip(" ；;，,。）)").rstrip("？?").strip()
        if len(cleaned) >= 2 and cleaned.rstrip("？?：:").strip():
            questions.append(cleaned)
        if len(questions) >= limit:
            break
    return questions if len(questions) >= 2 else []


def _strip_index(text: str) -> str:
    return re.sub(r"^\s*(?:[1-9１-９]|[①-⑨]|[（(][1-9][）)]|[1-9][）).、])\s*", "", text or "").strip()


def build_questions(text: str, *, limit: int = 4) -> list[dict[str, object]]:
    """多问题时给每项配候选；单问题返回空列表（前端继续走单问题 UI）。"""
    parts = split_questions(text, limit=limit)
    if not parts:
        return []
    return [{"question": part, "options": as_options(None, part)} for part in parts]


__all__ = ["as_options", "build_questions", "fallback_options", "split_questions"]

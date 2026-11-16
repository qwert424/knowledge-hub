"""Canonical Intermediate Representation (CIR) produced by every parser."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class Block:
    block_id: str
    block_type: str  # heading | paragraph | table | list | code | image
    text: str
    title_path: tuple[str, ...] = ()
    level: int = 0
    meta: dict[str, Any] = field(default_factory=dict)
    #: 语义类别，供检索侧按 kind 过滤：page | heading | paragraph | table | code | image | list
    kind: str = ""
    #: 在整篇文档中的前序位置（0 起），用于还原正文顺序（不是检索排名）
    order: int = -1
    #: 最近的上级结构块 ID（飞书的 parent block），根节点为空
    block_parent_id: str = ""
    #: 结构引用：`{"id": 被引用块ID, "kind": "table|image|doc", "placeholder": 正文里的占位符}`
    references: list[dict[str, Any]] = field(default_factory=list)
    #: 类型相关的附加信息：图片 bucket/filename、代码 language、表格行列数、合并信息
    payload: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "blockId": self.block_id,
            "blockType": self.block_type,
            "text": self.text,
            "titlePath": list(self.title_path),
            "level": self.level,
            "meta": self.meta,
            "kind": self.kind or self.block_type,
            "order": self.order,
            "blockParentId": self.block_parent_id,
            "references": self.references,
            "payload": self.payload,
        }


@dataclass(slots=True)
class DocumentIR:
    title: str
    blocks: list[Block]
    lang: str = "zh"
    source_type: str = "unknown"
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "lang": self.lang,
            "sourceType": self.source_type,
            "meta": self.meta,
            "blocks": [block.to_dict() for block in self.blocks],
        }

    @property
    def char_count(self) -> int:
        return sum(len(block.text) for block in self.blocks)


class TitleTracker:
    """Maintains the heading stack used as ``title_path`` for every block."""

    def __init__(self) -> None:
        self._stack: list[tuple[int, str]] = []

    def push(self, level: int, text: str) -> tuple[str, ...]:
        level = max(1, level)
        self._stack = [(lvl, title) for lvl, title in self._stack if lvl < level]
        self._stack.append((level, text.strip()))
        return self.current()

    def current(self) -> tuple[str, ...]:
        return tuple(title for _, title in self._stack)

    def clear(self) -> None:
        self._stack.clear()


#: block_type -> kind；检索侧按 kind 判断"要不要补查父块 / 引用块"。
_KIND_BY_TYPE = {
    "heading": "heading",
    "paragraph": "paragraph",
    "list": "list",
    "table": "table",
    "code": "code",
    "image": "image",
    "page": "page",
}


def normalise_structure(ir: DocumentIR) -> DocumentIR:
    """补齐 kind / order / references 占位符的 id。

    任何解析器（飞书、Markdown、docx、PDF）产出的 IR 都过一遍这里，保证入库
    结构与检索 Agent 的字段契约一致，而不是"飞书有、其它格式没有"。
    """
    for index, block in enumerate(ir.blocks):
        if block.order < 0:
            block.order = index
        if not block.kind:
            role = str(block.meta.get("role") or "") if block.meta else ""
            block.kind = "page" if role == "page" else _KIND_BY_TYPE.get(block.block_type, block.block_type)
        if block.references:
            # 占位符里的 id 必须指向真实被引用块，否则检索侧会拿着假 ID 去查
            for ref in block.references:
                if not isinstance(ref, dict):
                    continue
                ref.setdefault("kind", "block")
                ref.setdefault("placeholder", f'<document-ref id="{ref.get("id", "")}"></document-ref>')
    return ir


__all__ = ["Block", "DocumentIR", "TitleTracker", "normalise_structure"]

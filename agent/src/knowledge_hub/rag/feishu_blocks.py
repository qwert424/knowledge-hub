"""Feishu docx blocks -> the canonical intermediate representation (CIR).

This is the missing piece for "飞书文档直接入库": Feishu returns a *tree* of
`DocxBlock` (page -> containers -> paragraphs/headings/tables/images), while the
rest of the pipeline reasons about a flat, ordered list of :class:`Block` carrying
``title_path``. Converting here keeps every downstream stage (splitter, embedding,
citation) identical for Feishu, Markdown, docx, HTML and PDF.

Rules, aligned with the reference RAG implementation:

* the block list must describe exactly one tree (unique ids, one root, every
  child listed once, ``parent_id`` consistent) - otherwise ``ValueError``;
* blocks keep document order (``children`` order is authoritative);
* heading levels 1-9 maintain a title stack, so each block knows its section;
* containers (callout / grid / grid_column / quote_container) are transparent:
  they contribute no text of their own, only their descendants;
* tables become a ``table`` block carrying ``header`` + ``rows`` so the splitter
  can repeat the header on every row chunk;
* images keep their ``token`` in ``meta`` and contribute no text (a token is not
  searchable content); attach ``describe_image`` to turn one into a caption.

Accepted input shape (dict or object with attributes)::

    {"block_id": str, "block_type": int, "parent_id": str | None,
     "children": [block_id, ...], "raw": {...}}
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from knowledge_hub.rag.cir import Block, DocumentIR, TitleTracker, normalise_structure

# Feishu block_type numbers (subset the platform returns today).
PAGE = 1
TEXT = 2
HEADING_1 = 3
HEADING_9 = 11
BULLET = 12
ORDERED = 13
CODE = 14
QUOTE = 15
EQUATION = 16
TODO = 17
CALLOUT = 19
DIVIDER = 22
GRID = 24
GRID_COLUMN = 25
IMAGE = 27
TABLE = 31
TABLE_CELL = 32
QUOTE_CONTAINER = 34

_HEADING_RANGE = (HEADING_1, HEADING_9)
_CONTAINERS = {PAGE, CALLOUT, GRID, GRID_COLUMN, QUOTE_CONTAINER, TABLE_CELL}
_TEXT_FIELDS: dict[int, str] = {
    PAGE: "page",
    TEXT: "text",
    **{level + 2: f"heading{level}" for level in range(1, 10)},
    BULLET: "bullet",
    ORDERED: "ordered",
    CODE: "code",
    QUOTE: "quote",
    EQUATION: "equation",
    TODO: "todo",
}
_LIST_TYPES = {BULLET, ORDERED, TODO}
# Types that carry no retrievable text and no children worth walking.
_IGNORED = {DIVIDER}


@dataclass(slots=True)
class _Raw:
    block_id: str
    block_type: int
    parent_id: str
    children: list[str]
    raw: Mapping[str, Any]


ImageDescriber = Callable[[str, str], Awaitable[str]]


def blocks_to_ir(
    blocks: Sequence[Any] | Iterable[Any],
    *,
    title: str = "",
    doc_id: str = "",
) -> DocumentIR:
    """Convert one Feishu document's blocks into a :class:`DocumentIR`.

    Image blocks keep their ``token`` in ``meta`` and carry no text; call
    :func:`bind_image_captions` afterwards to turn tokens into searchable captions.
    """
    parsed = [_normalise(block) for block in blocks]
    ordered = _validate_tree(parsed)
    by_id = {block.block_id: block for block in parsed}

    tracker = TitleTracker()
    out: list[Block] = []

    def emit(
        block_type: str,
        text: str,
        *,
        level: int = 0,
        meta: dict[str, Any] | None = None,
        kind: str = "",
        parent_id: str = "",
        references: list[dict[str, Any]] | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        out.append(
            Block(
                block_id=f"{doc_id or 'feishu'}-{len(out):05d}",
                block_type=block_type,
                text=text,
                title_path=tracker.current(),
                level=level,
                meta=meta or {},
                kind=kind or block_type,
                order=len(out),
                block_parent_id=parent_id,
                references=references or [],
                payload=payload or {},
            )
        )

    def walk(block: _Raw) -> None:
        kind = block.block_type
        if kind == DIVIDER:
            return

        if _HEADING_RANGE[0] <= kind <= _HEADING_RANGE[1]:
            level = kind - HEADING_1 + 1
            text, refs = _text_and_refs(block)
            title_path = tracker.push(level, text)
            out.append(
                Block(
                    block_id=f"{doc_id or 'feishu'}-{len(out):05d}",
                    block_type="heading",
                    text=text,
                    title_path=title_path,
                    level=level,
                    meta={"feishuBlockId": block.block_id, "feishuType": kind},
                    kind="heading",
                    order=len(out),
                    block_parent_id=block.parent_id,
                    references=refs,
                )
            )
            for child_id in block.children:
                walk(by_id[child_id])
            return

        if kind == TABLE:
            table_meta = _table_meta(block, by_id)
            text, refs = _table_text(block, by_id)
            emit(
                "table",
                text,
                meta=table_meta,
                kind="table",
                parent_id=block.parent_id,
                references=refs,
                payload={
                    "row_size": table_meta.get("row_size", 0),
                    "column_size": table_meta.get("column_size", 0),
                    "header_row": table_meta.get("header_row", True),
                },
            )
            return

        if kind == IMAGE:
            token = _image_token(block)
            # 后端会把视觉模型生成的描述写进 image.caption：图本身不可检索，描述可以。
            caption = _image_caption(block)
            bucket, filename = _image_object(block)
            emit(
                "image",
                caption,
                meta={"token": token, "feishuBlockId": block.block_id},
                kind="image",
                parent_id=block.parent_id,
                payload={
                    "token": token,
                    "bucket_name": bucket,
                    "bucket_filename": filename,
                    "mime": str((block.raw.get("image") or {}).get("mime") or ""),
                }
                if token
                else {},
            )
            return

        if kind == CODE:
            language = _code_language(block)
            text, refs = _text_and_refs(block)
            if text:
                emit(
                    "code",
                    text,
                    meta={"lang": language},
                    kind="code",
                    parent_id=block.parent_id,
                    references=refs,
                    payload={"language": language} if language else {},
                )
            return

        if kind in _CONTAINERS:
            # Transparent wrapper: only descendants matter.
            if kind == PAGE:
                page_text, page_refs = _text_and_refs(block)
                if page_text.strip():
                    emit(
                        "paragraph",
                        page_text,
                        meta={"role": "page"},
                        kind="page",
                        parent_id=block.parent_id,
                        references=page_refs,
                    )
            for child_id in block.children:
                walk(by_id[child_id])
            return

        text, refs = _text_and_refs(block)
        if text.strip():
            block_type = "list" if kind in _LIST_TYPES else "paragraph"
            emit(
                block_type,
                text,
                meta={"feishuType": kind},
                kind=block_type,
                parent_id=block.parent_id,
                references=refs,
            )
        for child_id in block.children:
            walk(by_id[child_id])

    walk(by_id[ordered[0].block_id])

    ir = DocumentIR(
        title=title or _first_heading(out) or "untitled",
        blocks=out,
        source_type="feishu_docx",
        meta={"docId": doc_id} if doc_id else {},
    )
    return normalise_structure(ir)


async def bind_image_captions(ir: DocumentIR, describe: ImageDescriber) -> DocumentIR:
    """Fill ``image`` blocks with a description produced from their token.

    Kept separate from :func:`blocks_to_ir` so the sync conversion stays pure and
    the (network bound) vision call is explicit at the call site.
    """
    for block in ir.blocks:
        if block.block_type != "image":
            continue
        token = str(block.meta.get("token") or "")
        if not token:
            continue
        try:
            caption = await describe(token, block.meta.get("mime") or "image/png")
        except Exception:  # a failed caption must not break indexing
            continue
        block.text = (caption or "").strip()
    return ir


# --------------------------------------------------------------------- parsing
def _normalise(block: Any) -> _Raw:
    def pick(*names: str, default: Any = "") -> Any:
        for name in names:
            if isinstance(block, Mapping) and name in block:
                return block[name]
            if hasattr(block, name):
                return getattr(block, name)
        return default

    raw = pick("raw", default={})
    if not isinstance(raw, Mapping) or not raw:
        # 真实飞书 openapi 把内容放在块的顶层（`heading1` / `text` / `table` / `image`…），
        # 只有我们自己的中间结构才包一层 `raw`。不认这种形状的话，
        # 标题全是空串、表格全是空单元格，最后整篇文档切不出任何片段。
        raw = block if isinstance(block, Mapping) else {}
    return _Raw(
        block_id=str(pick("block_id", "blockId")).strip(),
        block_type=int(pick("block_type", "blockType", default=0)),
        parent_id=str(pick("parent_id", "parentId", default="") or ""),
        children=[str(child) for child in (pick("children", default=[]) or [])],
        raw=raw if isinstance(raw, Mapping) else {},
    )


def _validate_tree(blocks: list[_Raw]) -> list[_Raw]:
    """Return a parent-before-child order; raise on any structural defect."""
    if not blocks:
        raise ValueError("至少需要一个 DocxBlock")

    by_id: dict[str, _Raw] = {}
    for block in blocks:
        if not block.block_id:
            raise ValueError("block_id 不能为空")
        if block.block_id in by_id:
            raise ValueError(f"重复的 block_id：{block.block_id!r}")
        by_id[block.block_id] = block

    roots = [block for block in blocks if not block.parent_id]
    if len(roots) != 1:
        raise ValueError(f"必须有且只有一个根节点，实际为 {len(roots)} 个")

    owners: dict[str, str] = {}
    for block in blocks:
        if block.parent_id and block.parent_id not in by_id:
            raise ValueError(f"块 {block.block_id!r} 的父块 {block.parent_id!r} 不存在")
        for child_id in block.children:
            if child_id not in by_id:
                raise ValueError(f"块 {block.block_id!r} 的子块 {child_id!r} 不存在")
            if child_id in owners:
                raise ValueError(f"子块 {child_id!r} 被重复引用")
            if by_id[child_id].parent_id != block.block_id:
                raise ValueError(
                    f"子块 {child_id!r} 的 parent_id 与父块 {block.block_id!r} 不一致"
                )
            owners[child_id] = block.block_id

    for block in blocks:
        if block.parent_id and block.block_id not in owners:
            raise ValueError(
                f"块 {block.block_id!r} 未列在父块 {block.parent_id!r} 的 children 中"
            )

    ordered: list[_Raw] = []
    pending = [roots[0]]
    while pending:
        block = pending.pop()
        ordered.append(block)
        pending.extend(by_id[child_id] for child_id in reversed(block.children))

    if len(ordered) != len(blocks):
        reached = {block.block_id for block in ordered}
        unreachable = next(block.block_id for block in blocks if block.block_id not in reached)
        raise ValueError(f"存在环，块 {unreachable!r} 无法从根节点到达")
    return ordered


def _text_of(block: _Raw) -> str:
    """Concatenate the inline elements of a text-like block."""
    text, _refs = _text_and_refs(block)
    return text


_REF_ELEMENT_KINDS = {"mention_doc": "doc", "link_preview": "link"}


def _text_and_refs(block: _Raw) -> tuple[str, list[dict[str, Any]]]:
    """正文 + 结构引用。

    飞书正文里可以内嵌对其它文档/块的引用：这些位置在检索时是"占位符"，模型必须
    再用 `milvus_query` 把被引用块读回来，才不算把占位符当成已取得的正文。
    """
    field = _TEXT_FIELDS.get(block.block_type)
    if field is None:
        return "", []
    data = block.raw.get(field, {})
    if not isinstance(data, Mapping):
        return "", []
    elements = data.get("elements", [])
    if not isinstance(elements, list):
        return "", []
    parts: list[str] = []
    refs: list[dict[str, Any]] = []
    for element in elements:
        if not isinstance(element, Mapping) or len(element) != 1:
            continue
        kind, value = next(iter(element.items()))
        if not isinstance(value, Mapping):
            continue
        if kind in {"text_run", "equation"}:
            content = value.get("content")
        elif kind == "mention_doc":
            token = str(value.get("token") or value.get("obj_token") or "")
            title = str(value.get("title") or value.get("url") or token)
            if token:
                placeholder = f'<document-ref id="{token}">{title}</document-ref>'
                refs.append({"id": token, "kind": "doc", "placeholder": placeholder, "title": title})
                parts.append(placeholder)
                continue
            content = title
        elif kind in {"link_preview", "mention_user"}:
            content = value.get("title") or value.get("url") or value.get("user_id")
        else:
            content = None
        if isinstance(content, str) and content:
            parts.append(content)
    return "".join(parts), refs


def _image_token(block: _Raw) -> str:
    image = block.raw.get("image")
    token = image.get("token") if isinstance(image, Mapping) else None
    return token if isinstance(token, str) else ""


def _image_object(block: _Raw) -> tuple[str, str]:
    """图片在对象存储里的位置（导入侧写入），检索侧靠它换可直接访问的 URL。"""
    image = block.raw.get("image")
    if not isinstance(image, Mapping):
        return "", ""
    bucket = image.get("bucket_name") or image.get("bucketName") or ""
    filename = image.get("bucket_filename") or image.get("bucketFilename") or ""
    return str(bucket), str(filename)


def _image_caption(block: _Raw) -> str:
    """图片描述由导入侧（视觉模型）写入 ``image.caption``，这里只取文本。"""
    image = block.raw.get("image")
    caption = image.get("caption") if isinstance(image, Mapping) else None
    return caption.strip() if isinstance(caption, str) else ""


def _code_language(block: _Raw) -> str:
    code = block.raw.get("code")
    style = code.get("style") if isinstance(code, Mapping) else None
    language = style.get("language") if isinstance(style, Mapping) else None
    return str(language) if language is not None else ""


def _table_meta(block: _Raw, by_id: Mapping[str, _Raw]) -> dict[str, Any]:
    """Grid of cell texts plus the declared shape (``header`` + ``rows``)."""
    table = block.raw.get("table")
    properties = table.get("property") if isinstance(table, Mapping) else None
    columns = int(properties.get("column_size") or 0) if isinstance(properties, Mapping) else 0
    rows = int(properties.get("row_size") or 0) if isinstance(properties, Mapping) else 0

    cells = [by_id[child_id] for child_id in block.children if child_id in by_id]
    texts = [_cell_text(cell, by_id) for cell in cells]
    width = columns or (len(texts) if rows <= 1 else 0)

    grid: list[list[str]] = []
    if width > 0:
        for start in range(0, len(texts), width):
            grid.append(texts[start : start + width])
    elif texts:
        grid = [texts]

    header = grid[0] if grid else []
    return {
        "header": header,
        "rows": grid[1:] if len(grid) > 1 else [],
        "column_size": width,
        "row_size": rows or len(grid),
        "header_row": bool(properties.get("header_row", True)) if isinstance(properties, Mapping) else True,
    }


def _cell_text(cell: _Raw, by_id: Mapping[str, _Raw]) -> str:
    parts: list[str] = []
    for child_id in cell.children:
        child = by_id.get(child_id)
        if child is None:
            continue
        text = _text_of(child)
        if text.strip():
            parts.append(text.strip())
        else:
            for grandchild_id in child.children:
                grandchild = by_id.get(grandchild_id)
                if grandchild is not None and _text_of(grandchild).strip():
                    parts.append(_text_of(grandchild).strip())
    return " ".join(parts)


def _table_text(block: _Raw, by_id: Mapping[str, _Raw]) -> tuple[str, list[dict[str, Any]]]:
    """表格正文 + 每个单元格里出现的结构引用。"""
    meta = _table_meta(block, by_id)
    lines = [" | ".join(meta["header"])] if meta["header"] else []
    lines.extend(" | ".join(row) for row in meta["rows"])
    refs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for cell in (by_id[child_id] for child_id in block.children if child_id in by_id):
        for child_id in cell.children:
            child = by_id.get(child_id)
            if child is None:
                continue
            _text, cell_refs = _text_and_refs(child)
            for ref in cell_refs:
                if ref["id"] not in seen:
                    seen.add(ref["id"])
                    refs.append(ref)
    return "\n".join(line for line in lines if line.strip()), refs


def _first_heading(blocks: Sequence[Block]) -> str:
    for block in blocks:
        if block.block_type == "heading" and block.text.strip():
            return block.text.strip()
    return ""


__all__ = ["bind_image_captions", "blocks_to_ir"]

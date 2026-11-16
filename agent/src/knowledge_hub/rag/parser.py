"""Document parsers: pdf / docx / markdown / txt / html -> CIR.

Every parser produces :class:`DocumentIR` with deterministic block ids so that
re-indexing the same document version yields identical ``chunk_id`` values.
"""

from __future__ import annotations

import io
import logging
import re
from pathlib import Path
from typing import Any

from knowledge_hub.errors import ParserError, UnsupportedFile
from knowledge_hub.rag.cir import Block, DocumentIR, TitleTracker, normalise_structure
from knowledge_hub.rag.feishu_blocks import blocks_to_ir
from knowledge_hub.rag.textutil import (
    detect_lang,
    normalize_whitespace,
    stable_id,
)

logger = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {
    ".pdf",
    ".docx",
    ".md",
    ".markdown",
    ".txt",
    ".text",
    ".html",
    ".htm",
}

_HEADING_STYLE = re.compile(r"^(?:Heading|标题)\s*([1-6])$", re.IGNORECASE)
_MD_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_MD_LIST = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
_MD_TABLE_SEP = re.compile(r"^\s*\|?[\s:\-|]{3,}\|?\s*$")
_MD_IMAGE = re.compile(r"^!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)$")


def parse_document(filename: str, data: bytes, *, title: str = "") -> DocumentIR:
    """Parse raw bytes, dispatching on extension and falling back to sniffing."""
    if not data:
        raise ParserError("empty document")
    suffix = Path(filename or "").suffix.lower()
    if suffix == ".pdf" or data[:4] == b"%PDF":
        doc = _parse_pdf(data)
    elif suffix == ".docx" or data[:2] == b"PK":
        doc = _parse_docx(data)
    elif suffix in {".html", ".htm"}:
        doc = _parse_html(data)
    elif suffix in {".md", ".markdown"}:
        doc = _parse_markdown(data)
    elif suffix in {".json", ".feishu"} or data[:1] in (b"[", b"{"):
        doc = _parse_feishu_or_text(filename, data)
    elif suffix in {".txt", ".text", ""}:
        doc = _parse_text(data)
    else:
        raise UnsupportedFile(f"unsupported document type: {suffix or 'unknown'}")

    if title:
        doc.title = title
    if not doc.title:
        doc.title = _first_heading(doc) or (Path(filename).stem if filename else "untitled")
    doc.meta.setdefault("filename", filename)
    doc.lang = detect_lang(" ".join(block.text for block in doc.blocks[:20]))
    # 所有格式统一补齐 kind / order / 引用占位符：检索侧的字段契约不能只有飞书满足
    return normalise_structure(doc)


# --------------------------------------------------------------------------- text
def _parse_feishu_or_text(filename: str, data: bytes) -> DocumentIR:
    """Feishu docx ``blocks`` export -> tree-aware CIR; anything else -> plain text.

    Two accepted shapes: a bare list of blocks, or ``{"blocks": [...]}``.
    A JSON file that is not Feishu blocks is not silently mangled: it is parsed
    as text so the operator can still see what was indexed.
    """
    import json as _json

    try:
        payload = _json.loads(_decode(data))
    except ValueError:
        return _parse_text(data)

    blocks = payload.get("blocks") if isinstance(payload, dict) else payload
    if not isinstance(blocks, list) or not blocks:
        return _parse_text(data)
    if not all(isinstance(block, dict) and block.get("block_id") for block in blocks):
        return _parse_text(data)

    doc_id = ""
    if isinstance(payload, dict):
        doc_id = str(payload.get("document_id") or payload.get("documentId") or "")
    try:
        return blocks_to_ir(blocks, title="", doc_id=doc_id)
    except ValueError as exc:
        raise ParserError(f"invalid feishu block tree: {exc}") from exc


def _parse_text(data: bytes) -> DocumentIR:
    text = _decode(data)
    blocks: list[Block] = []
    tracker = TitleTracker()
    for index, chunk in enumerate(re.split(r"\n\s*\n", normalize_whitespace(text))):
        chunk = chunk.strip()
        if not chunk:
            continue
        blocks.append(
            Block(
                block_id=f"b{index:05d}",
                block_type="paragraph",
                text=chunk,
                title_path=tracker.current(),
            )
        )
    return DocumentIR(title="", blocks=blocks, source_type="txt")


# ----------------------------------------------------------------------- markdown
def _parse_markdown(data: bytes) -> DocumentIR:
    text = _decode(data).replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    tracker = TitleTracker()
    blocks: list[Block] = []
    buffer: list[str] = []
    buffer_type = "paragraph"
    in_code = False
    code_lines: list[str] = []
    code_lang = ""

    def flush() -> None:
        nonlocal buffer, buffer_type
        joined = normalize_whitespace("\n".join(buffer))
        if joined:
            blocks.append(
                Block(
                    block_id=f"b{len(blocks):05d}",
                    block_type=buffer_type,
                    text=joined,
                    title_path=tracker.current(),
                )
            )
        buffer = []
        buffer_type = "paragraph"

    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        if in_code:
            if stripped.startswith("```"):
                blocks.append(
                    Block(
                        block_id=f"b{len(blocks):05d}",
                        block_type="code",
                        text="\n".join(code_lines).strip(),
                        title_path=tracker.current(),
                        meta={"lang": code_lang},
                    )
                )
                code_lines = []
                in_code = False
            else:
                code_lines.append(line)
            index += 1
            continue

        if stripped.startswith("```"):
            flush()
            in_code = True
            code_lang = stripped[3:].strip()
            index += 1
            continue

        heading = _MD_HEADING.match(stripped)
        if heading:
            flush()
            level = len(heading.group(1))
            title_text = heading.group(2).strip()
            title_path = tracker.push(level, title_text)
            blocks.append(
                Block(
                    block_id=f"b{len(blocks):05d}",
                    block_type="heading",
                    text=title_text,
                    title_path=title_path,
                    level=level,
                )
            )
            index += 1
            continue

        if not stripped:
            flush()
            index += 1
            continue

        if stripped.startswith("|") and index + 1 < len(lines) and _MD_TABLE_SEP.match(lines[index + 1]):
            flush()
            table_lines = [stripped]
            index += 2
            while index < len(lines) and lines[index].strip().startswith("|"):
                table_lines.append(lines[index].strip())
                index += 1
            blocks.append(
                Block(
                    block_id=f"b{len(blocks):05d}",
                    block_type="table",
                    text="\n".join(_clean_table_row(row) for row in table_lines),
                    title_path=tracker.current(),
                    meta=_table_cells(table_lines),
                )
            )
            continue

        if _MD_LIST.match(line):
            if buffer_type != "list":
                flush()
                buffer_type = "list"
            buffer.append(stripped)
            index += 1
            continue

        image = _MD_IMAGE.match(stripped)
        if image:
            flush()
            alt, src = image.group(1).strip(), image.group(2).strip()
            blocks.append(
                Block(
                    block_id=f"b{len(blocks):05d}",
                    block_type="image",
                    # 图本身不可检索；alt 文本是唯一可检索内容，没有 alt 就只留引用信息
                    text=alt,
                    title_path=tracker.current(),
                    kind="image",
                    payload={"url": src, "alt": alt},
                )
            )
            index += 1
            continue

        if buffer_type == "list":
            flush()
        buffer.append(stripped)
        index += 1

    if in_code and code_lines:
        blocks.append(
            Block(
                block_id=f"b{len(blocks):05d}",
                block_type="code",
                text="\n".join(code_lines).strip(),
                title_path=tracker.current(),
                meta={"lang": code_lang},
            )
        )
    flush()
    return DocumentIR(title="", blocks=blocks, source_type="markdown")


def _clean_table_row(row: str) -> str:
    cells = [cell.strip() for cell in row.strip().strip("|").split("|")]
    return " | ".join(cells)


def _table_cells(table_lines: list[str]) -> dict[str, Any]:
    """Structured header/rows so the splitter can repeat the header per row.

    ``table_lines`` already excludes the ``|---|`` separator line.
    """
    rows = [
        [cell.strip() for cell in line.strip().strip("|").split("|")] for line in table_lines
    ]
    if not rows:
        return {}
    width = max(len(row) for row in rows)
    normalised = [row + [""] * (width - len(row)) for row in rows]
    return {
        "header": normalised[0],
        "rows": normalised[1:],
        "column_size": width,
        "row_size": len(normalised),
        "header_row": True,
    }


# ---------------------------------------------------------------------------- html
def _parse_html(data: bytes) -> DocumentIR:
    try:
        from bs4 import BeautifulSoup
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise ParserError("beautifulsoup4 is required for html parsing") from exc

    try:
        soup = BeautifulSoup(data, "lxml")
    except Exception:  # pragma: no cover - lxml fallback
        soup = BeautifulSoup(data, "html.parser")

    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    tracker = TitleTracker()
    blocks: list[Block] = []
    title = ""
    page_title = soup.title.get_text(strip=True) if soup.title else ""

    tags = soup.find_all(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "table", "pre", "blockquote"])
    for tag in tags:
        name = tag.name
        text = tag.get_text("\n" if name == "table" else " ", strip=True)
        text = normalize_whitespace(text)
        if not text:
            continue
        if name.startswith("h") and len(name) == 2:
            level = int(name[1])
            path = tracker.push(level, text)
            if not title:
                title = text
            blocks.append(
                Block(
                    block_id=f"b{len(blocks):05d}",
                    block_type="heading",
                    text=text,
                    title_path=path,
                    level=level,
                )
            )
            continue
        block_type = {
            "li": "list",
            "table": "table",
            "pre": "code",
            "blockquote": "paragraph",
        }.get(name, "paragraph")
        blocks.append(
            Block(
                block_id=f"b{len(blocks):05d}",
                block_type=block_type,
                text=text,
                title_path=tracker.current(),
            )
        )
    return DocumentIR(title=title or page_title, blocks=blocks, source_type="html")


# ---------------------------------------------------------------------------- docx
def _parse_docx(data: bytes) -> DocumentIR:
    try:
        import docx  # type: ignore[import-untyped]
        from docx.table import Table
        from docx.text.paragraph import Paragraph
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise ParserError("python-docx is required for docx parsing") from exc

    try:
        document = docx.Document(io.BytesIO(data))
    except Exception as exc:
        raise ParserError("docx could not be opened") from exc

    tracker = TitleTracker()
    blocks: list[Block] = []
    title = ""

    body = document.element.body
    for child in body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            paragraph = Paragraph(child, document)
            text = normalize_whitespace(paragraph.text)
            if not text:
                continue
            style = (paragraph.style.name or "") if paragraph.style is not None else ""
            match = _HEADING_STYLE.match(style)
            if match:
                level = int(match.group(1))
                path = tracker.push(level, text)
                if not title:
                    title = text
                blocks.append(
                    Block(
                        block_id=f"b{len(blocks):05d}",
                        block_type="heading",
                        text=text,
                        title_path=path,
                        level=level,
                    )
                )
            else:
                blocks.append(
                    Block(
                        block_id=f"b{len(blocks):05d}",
                        block_type="paragraph",
                        text=text,
                        title_path=tracker.current(),
                    )
                )
        elif tag == "tbl":
            table = Table(child, document)
            grid = [[normalize_whitespace(cell.text) for cell in row.cells] for row in table.rows]
            grid = [row for row in grid if any(cell for cell in row)]
            text = "\n".join(" | ".join(row) for row in grid)
            if text:
                # 带 header/rows 结构，切片器才能按"表头 + 一行"切；否则整张表当一段正文
                blocks.append(
                    Block(
                        block_id=f"b{len(blocks):05d}",
                        block_type="table",
                        text=text,
                        title_path=tracker.current(),
                        meta={
                            "header": grid[0] if grid else [],
                            "rows": grid[1:] if len(grid) > 1 else [],
                            "row_size": len(grid),
                            "column_size": max((len(row) for row in grid), default=0),
                        },
                    )
                )
    # 图片：docx 把图片放在 inline shape 里，正文是空的；登记关系 ID 供后续取图
    try:
        for rel_id, relationship in document.part.rels.items():
            if "image" not in relationship.reltype:
                continue
            target_part = getattr(relationship, "target_part", None)
            blocks.append(
                Block(
                    block_id=f"b{len(blocks):05d}",
                    block_type="image",
                    text="",
                    title_path=tracker.current(),
                    kind="image",
                    payload={
                        "relation_id": rel_id,
                        "target": str(relationship.target_ref),
                        "partname": str(getattr(target_part, "partname", "") or ""),
                    },
                )
            )
    except Exception:  # pragma: no cover - 关系表异常不该阻断解析
        pass
    return DocumentIR(title=title, blocks=blocks, source_type="docx")


# ----------------------------------------------------------------------------- pdf
def _parse_pdf(data: bytes) -> DocumentIR:
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise ParserError("pypdf is required for pdf parsing") from exc

    try:
        reader = PdfReader(io.BytesIO(data))
        if getattr(reader, "is_encrypted", False):
            try:
                reader.decrypt("")
            except Exception as exc:
                raise ParserError("pdf is encrypted") from exc
        pages = list(reader.pages)
    except ParserError:
        raise
    except Exception as exc:
        raise ParserError("pdf could not be opened") from exc

    tracker = TitleTracker()
    blocks: list[Block] = []
    meta_title = ""
    try:
        meta_title = (reader.metadata or {}).get("/Title") or ""
    except Exception:  # pragma: no cover - malformed metadata
        meta_title = ""

    for page_number, page in enumerate(pages, start=1):
        try:
            page_text = page.extract_text() or ""
        except Exception as exc:  # pragma: no cover - corrupt page
            logger.warning("pdf page %s unreadable: %s", page_number, exc)
            continue
        page_text = normalize_whitespace(page_text)
        if not page_text:
            continue
        blocks.append(
            Block(
                block_id=f"b{len(blocks):05d}",
                block_type="paragraph",
                text=page_text,
                title_path=tracker.current(),
                meta={"page": page_number},
            )
        )
    return DocumentIR(
        title=str(meta_title).strip(),
        blocks=blocks,
        source_type="pdf",
        meta={"pages": len(pages)},
    )


def _decode(data: bytes) -> str:
    # utf-8-sig first so a leading BOM never leaks into the first block's text.
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _first_heading(doc: DocumentIR) -> str:
    for block in doc.blocks:
        if block.block_type == "heading" and block.text.strip():
            return block.text.strip()
    return ""


__all__ = ["SUPPORTED_EXTENSIONS", "parse_document", "stable_id"]

"""Structure-aware splitting from CIR blocks into retrieval chunks.

Guarantees:
* a heading never becomes an orphan chunk - headings are carried as a prefix on
  the chunks of their section;
* every emitted chunk stays <= ``chunk_size`` characters (a single over-long
  paragraph is segmented on sentence boundaries with ``chunk_overlap``);
* deterministic chunk ids so re-indexing the same version is idempotent;
* quality flags computed from config (``chunking.quality``) instead of ad hoc.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from knowledge_hub.config.settings import ChunkingSection
from knowledge_hub.rag.cir import DocumentIR
from knowledge_hub.rag.textutil import (
    estimate_tokens,
    is_navigation_text,
    split_sentences,
    stable_id,
)

logger = logging.getLogger(__name__)

#: Block types that are emitted verbatim: splitting them would destroy meaning.
_ATOMIC_TYPES = {"code", "image"}


@dataclass(slots=True)
class Chunk:
    chunk_index: int
    text: str
    block_id: str
    block_type: str
    title_path: list[str]
    token_count: int
    quality_flags: list[str] = field(default_factory=list)
    chunk_id: str = ""
    parent_pk: str = ""
    dropped: bool = False
    meta: dict[str, Any] = field(default_factory=dict)
    #: 结构字段：与检索 Agent 的契约一致，缺了这些 "按 block_id 补查上下文" 就没法做
    kind: str = "paragraph"
    block_order: int = -1
    block_parent_id: str = ""
    references: list[dict[str, Any]] = field(default_factory=list)
    payload: dict[str, Any] = field(default_factory=dict)
    #: 同一结构块内的切片总数（从 0 开始的 chunk_index 的兄弟数）
    chunk_count: int = 1
    #: 这一片是否由多个块合并而成（合并片的 block_id 只代表"起始块"，不算某块的第 N 片）
    merged: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "chunkId": self.chunk_id,
            "chunkIndex": self.chunk_index,
            "chunkCount": self.chunk_count,
            "blockId": self.block_id,
            "blockType": self.block_type,
            "blockParentId": self.block_parent_id,
            "kind": self.kind,
            "order": self.block_order,
            "titlePath": self.title_path,
            "tokenCount": self.token_count,
            "qualityFlags": ",".join(self.quality_flags),
            "references": self.references,
            "payload": self.payload,
            "text": self.text,
            "dropped": self.dropped,
            **({"tableRowIndex": self.meta["table_row_index"]} if "table_row_index" in self.meta else {}),
        }


@dataclass(slots=True)
class SplitResult:
    chunks: list[Chunk]
    dropped: list[Chunk]
    total_tokens: int

    @property
    def chunk_count(self) -> int:
        return len(self.chunks)


class Splitter:
    def __init__(self, chunking: ChunkingSection) -> None:
        self.config = chunking
        self.chunk_size = max(80, int(chunking.chunk_size))
        self.overlap = max(0, min(int(chunking.chunk_overlap), self.chunk_size // 2))
        self.min_chars = max(0, int(chunking.min_chunk_chars))

    # ------------------------------------------------------------------ public
    def split(self, doc: DocumentIR, *, doc_key: str = "") -> SplitResult:
        state = _BuilderState()
        emitted: list[Chunk] = []
        prefix = ""

        def flush(carry_over: bool) -> None:
            nonlocal prefix
            if not state.buffer:
                state.reset()
                return
            body = "\n".join(state.buffer)
            text = f"{prefix}\n{body}".strip() if prefix else body.strip()
            if text:
                chunk = self._make_chunk(
                    len(emitted),
                    text,
                    body,
                    state.block_id,
                    state.block_type,
                    list(state.title_path),
                    doc_key,
                    block=state.block_last or state.block,
                )
                # 多个块被拼进同一片：它不代表某一个块的"第 N 片"
                chunk.merged = state.block_count > 1
                emitted.append(chunk)
            last_block_id = state.block_id_last or state.block_id
            last_title_path = list(state.title_path_last or state.title_path)
            last_block = state.block_last or state.block
            carry = ""
            if carry_over and self.overlap > 0 and state.block_type in {"paragraph", "list", "table"}:
                carry = _tail(body, self.overlap)
            state.reset()
            if carry:
                state.buffer = [carry]
                state.block_type = "paragraph"
                state.block_id = last_block_id
                state.title_path = last_title_path
                state.block = last_block

        for block in doc.blocks:
            if block.block_type == "heading":
                flush(carry_over=False)
                prefix = f"{'#' * max(1, block.level or 1)} {block.text}".strip()
                state.title_path = block.title_path or state.title_path
                continue

            if block.block_type == "table":
                flush(carry_over=False)
                table_chunks = self._split_table(block, prefix, len(emitted), doc_key)
                if table_chunks:
                    emitted.extend(table_chunks)
                    continue
                # No structured cells (e.g. a table recovered from PDF text):
                # fall through and split it as ordinary text.

            if block.block_type in _ATOMIC_TYPES:
                # Code and image must never be cut: a half snippet is worse than a
                # slightly over-budget chunk, and a truncated image caption is noise.
                flush(carry_over=False)
                text = block.text.strip()
                if not text and block.block_type == "image":
                    # 图片没有描述（视觉模型没跑 / 飞书没给 caption）也要留一条切片：
                    # 否则这一节在文档详情里"没有图片"，检索 Agent 也不知道这里有一张图。
                    text = _image_placeholder(block, prefix)
                if text:
                    chunk_text = f"{prefix}\n{text}".strip() if prefix else text
                    emitted.append(
                        self._make_chunk(
                            len(emitted),
                            chunk_text,
                            text,
                            block.block_id,
                            block.block_type,
                            list(block.title_path),
                            doc_key,
                            block=block,
                        )
                    )
                continue

            text = block.text.strip()
            if not text:
                continue

            available = max(40, self.chunk_size - len(prefix) - 1)
            if len(text) > available:
                flush(carry_over=False)
                for segment in self._segment(text, available):
                    if prefix:
                        chunk_text = f"{prefix}\n{segment}"
                    else:
                        chunk_text = segment
                    emitted.append(
                        self._make_chunk(
                            len(emitted),
                            chunk_text,
                            segment,
                            block.block_id,
                            block.block_type,
                            list(block.title_path),
                            doc_key,
                            block=block,
                        )
                    )
                state.reset()
                continue

            projected = len(prefix) + 1 + sum(len(part) + 1 for part in state.buffer) + len(text)
            if state.buffer and projected > self.chunk_size:
                flush(carry_over=True)
            if not state.buffer:
                state.block_id = block.block_id
                state.block_type = block.block_type
                state.title_path = list(block.title_path)
                state.block = block
                state.block_count = 1
            elif block.block_id != state.block_id_last:
                state.block_count += 1
            state.buffer.append(text)
            state.block_id_last = block.block_id
            state.title_path_last = list(block.title_path)
            state.block_last = block

        flush(carry_over=False)

        kept, dropped = self._post_process(emitted)
        total_tokens = sum(chunk.token_count for chunk in kept)
        if dropped:
            logger.debug("splitter dropped %s chunk(s) (quality)", len(dropped))
        return SplitResult(chunks=kept, dropped=dropped, total_tokens=total_tokens)

    # ---------------------------------------------------------------- internals
    def _split_table(
        self, block: Any, prefix: str, start_index: int, doc_key: str
    ) -> list[Chunk]:
        """One chunk per data row, with the header repeated (a row alone is useless).

        Falls back to plain text splitting when the block has no structured cells
        (e.g. a table parsed from PDF where only text survives).
        """
        meta = block.meta or {}
        header = [str(cell) for cell in (meta.get("header") or [])]
        rows = [[str(cell) for cell in row] for row in (meta.get("rows") or [])]
        if not header or not rows:
            return []

        header_line = " | ".join(header)
        chunks: list[Chunk] = []
        for row_index, row in enumerate(rows, start=1):
            body = f"{header_line}\n{' | '.join(row)}".strip()
            if not body or body == header_line:
                continue
            chunk_text = f"{prefix}\n{body}".strip() if prefix else body
            chunk = self._make_chunk(
                start_index + len(chunks),
                chunk_text,
                body,
                block.block_id,
                "table",
                list(block.title_path),
                doc_key,
                block=block,
            )
            chunk.meta["table_row_index"] = row_index
            chunks.append(chunk)
        return chunks

    def _segment(self, text: str, budget: int) -> list[str]:
        sentences = split_sentences(text) or [text]
        segments: list[str] = []
        current = ""
        step = max(1, budget - min(self.overlap, budget // 2))
        for sentence in sentences:
            while len(sentence) > budget:
                if current:
                    segments.append(current)
                    current = ""
                segments.append(sentence[:budget])
                sentence = sentence[step:]
            if not current:
                current = sentence
            elif len(current) + len(sentence) + 1 <= budget:
                current = f"{current} {sentence}"
            else:
                segments.append(current)
                tail = _tail(current, self.overlap)
                current = f"{tail} {sentence}".strip() if tail else sentence
        if current:
            segments.append(current)
        return [seg.strip() for seg in segments if seg.strip()]

    def _make_chunk(
        self,
        index: int,
        text: str,
        body: str,
        block_id: str,
        block_type: str,
        title_path: list[str],
        doc_key: str,
        *,
        block: Any | None = None,
    ) -> Chunk:
        token_count = estimate_tokens(text)
        flags = self.quality_flags(body, token_count, text, block_type)
        kind = getattr(block, "kind", "") or block_type
        return Chunk(
            chunk_index=index,
            text=text,
            block_id=block_id,
            block_type=block_type,
            title_path=title_path,
            token_count=token_count,
            quality_flags=flags,
            chunk_id=stable_id(doc_key, block_id, str(index), text[:96]),
            kind=kind,
            block_order=int(getattr(block, "order", -1) if getattr(block, "order", -1) >= 0 else -1),
            block_parent_id=str(getattr(block, "block_parent_id", "") or ""),
            references=list(getattr(block, "references", []) or []),
            payload=dict(getattr(block, "payload", {}) or {}),
        )

    def quality_flags(
        self, body: str, token_count: int, full_text: str, block_type: str = ""
    ) -> list[str]:
        quality = self.config.quality
        flags: list[str] = []
        stripped = (body or "").strip()
        if not stripped:
            flags.append("empty")
            return flags
        if token_count < quality.min_tokens:
            flags.append("too_short")
        if token_count > quality.max_tokens:
            flags.append("too_long")
        # 表格/代码本身就是"符号密集 + 短行"，用导航启发式判断会把整张表误杀
        # （`| a | b |` 的竖线既像菜单也像表格，只能靠类型区分）。
        if quality.drop_pure_navigation and block_type in {"", "paragraph", "list"}:
            if is_navigation_text(stripped):
                flags.append("pure_navigation")
        symbols = sum(1 for ch in full_text if not ch.isalnum() and not ch.isspace())
        if len(full_text) >= 40 and symbols / len(full_text) > 0.45:
            flags.append("high_symbol_ratio")
        return flags

    def _post_process(self, chunks: list[Chunk]) -> tuple[list[Chunk], list[Chunk]]:
        kept: list[Chunk] = []
        dropped: list[Chunk] = []
        for chunk in chunks:
            flags = set(chunk.quality_flags)
            if "empty" in flags or "pure_navigation" in flags:
                chunk.dropped = True
                dropped.append(chunk)
                continue
            if "too_short" in flags and len(chunk.text) < self.min_chars:
                if kept and "too_long" not in set(kept[-1].quality_flags):
                    previous = kept[-1]
                    merged_text = f"{previous.text}\n{chunk.text}".strip()
                    previous.text = merged_text
                    previous.token_count = estimate_tokens(merged_text)
                    previous.quality_flags = self.quality_flags(
                        merged_text, previous.token_count, merged_text, previous.block_type
                    )
                    chunk.dropped = True
                    dropped.append(chunk)
                    continue
                chunk.dropped = True
                dropped.append(chunk)
                continue
            kept.append(chunk)

        # 同一结构块的切片数：只统计"单块切开"的片，合并片的 block_id 只代表起始块
        counts: dict[str, int] = {}
        for chunk in kept:
            if not chunk.merged:
                counts[chunk.block_id] = counts.get(chunk.block_id, 0) + 1
        # chunk_index 是「块内第几片」，不是全文档第几片。以前这里按 kept 的顺序全局重编号，
        # 于是界面出现"第 6/5 片"这种块内序号大于总数的组合。
        seen: dict[str, int] = {}
        for chunk in kept:
            if chunk.merged:
                chunk.chunk_index = 0
                chunk.chunk_count = 1
                continue
            position = seen.get(chunk.block_id, 0)
            chunk.chunk_index = position
            seen[chunk.block_id] = position + 1
            chunk.chunk_count = counts.get(chunk.block_id, 1)
        return kept, dropped


class _BuilderState:
    __slots__ = (
        "buffer",
        "block_id",
        "block_type",
        "title_path",
        "block_id_last",
        "title_path_last",
        "block",
        "block_last",
        "block_count",
    )

    def __init__(self) -> None:
        self.buffer: list[str] = []
        self.block_id = ""
        self.block_type = "paragraph"
        self.title_path: list[str] = []
        self.block_id_last = ""
        self.title_path_last: list[str] = []
        # 当前/最后一个块：为了把 kind、order、references 这些结构字段带给切片
        self.block: Any = None
        self.block_last: Any = None
        # 这一片里合并了几个块
        self.block_count = 0

    def reset(self) -> None:
        self.buffer = []
        self.block_id = ""
        self.block_type = "paragraph"
        self.title_path = []
        self.block_id_last = ""
        self.title_path_last = []
        self.block = None
        self.block_last = None
        self.block_count = 0


def _tail(text: str, limit: int) -> str:
    if limit <= 0 or len(text) <= limit:
        return text if limit > 0 else ""
    tail = text[-limit:]
    sentences = split_sentences(tail)
    if len(sentences) > 1:
        return " ".join(sentences[1:]).strip()
    return tail.strip()


def _image_placeholder(block: Any, prefix: str) -> str:
    """没有描述时的图片占位文本：至少让「这里有一张图」和所属章节留下来。

    图本身不可检索，但块类型、章节归属和 payload 里的 bucket/token 还在，
    检索 Agent 可以据此调 ``get_bucket_file_url`` 取原图。
    """
    path = list(getattr(block, "title_path", ()) or ())
    title = path[-1] if path else (prefix.lstrip("# ") if prefix else "")
    return f"[图片] {title or '图片'}"


__all__ = ["Chunk", "SplitResult", "Splitter"]

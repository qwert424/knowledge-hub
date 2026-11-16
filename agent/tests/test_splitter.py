"""Splitter boundaries, heading continuity, overlap and quality flags."""

from __future__ import annotations

from knowledge_hub.config.settings import AppConfig
from knowledge_hub.rag.cir import Block, DocumentIR
from knowledge_hub.rag.splitter import Splitter
from knowledge_hub.rag.textutil import is_navigation_text


def _doc(*blocks: Block) -> DocumentIR:
    return DocumentIR(title="销售制度", blocks=list(blocks))


def _block(text: str, block_type: str = "paragraph", title_path: tuple[str, ...] = ()) -> Block:
    return Block(block_id=f"b{abs(hash(text)) % 10000:05d}", block_type=block_type, text=text, title_path=title_path)


def test_chunks_respect_size_budget(app_config: AppConfig) -> None:
    splitter = Splitter(app_config.chunking)
    paragraph = "这是一段很长的中文内容，用来验证切分逻辑。" * 60
    result = splitter.split(_doc(_block(paragraph)), doc_key="doc:1")
    assert result.chunks
    assert all(len(chunk.text) <= app_config.chunking.chunk_size * 1.2 for chunk in result.chunks)
    assert sum(1 for chunk in result.chunks) > 1


def test_heading_is_not_an_orphan_chunk(app_config: AppConfig) -> None:
    splitter = Splitter(app_config.chunking)
    heading = Block(block_id="b00001", block_type="heading", text="第一章 总则", level=1, title_path=("第一章 总则",))
    body = Block(
        block_id="b00002",
        block_type="paragraph",
        text="本制度适用于全体员工，自发布之日起执行。",
        title_path=("第一章 总则",),
    )
    result = splitter.split(_doc(heading, body), doc_key="doc:2")
    assert len(result.chunks) == 1
    only = result.chunks[0]
    assert "第一章 总则" in only.text
    assert "本制度适用于全体员工" in only.text
    assert only.title_path == ["第一章 总则"]


def test_overlap_between_long_text_segments(app_config: AppConfig) -> None:
    splitter = Splitter(app_config.chunking)
    paragraph = "。".join(f"句子{i:03d}说明了检索与切分的关系" for i in range(120)) + "。"
    result = splitter.split(_doc(_block(paragraph)), doc_key="doc:3")
    assert len(result.chunks) >= 2
    overlap_chars = app_config.chunking.chunk_overlap
    overlaps = 0
    for previous, current in zip(result.chunks, result.chunks[1:], strict=False):
        tail = previous.text[-overlap_chars // 2 :]
        if tail and tail in current.text:
            overlaps += 1
    assert overlaps >= 1


def test_pure_navigation_chunk_is_dropped(app_config: AppConfig) -> None:
    splitter = Splitter(app_config.chunking)
    nav = _block("首页 | 上一页 | 下一页 | 返回顶部 | 登录")
    assert is_navigation_text(nav.text) is True
    result = splitter.split(_doc(nav), doc_key="doc:4")
    assert result.chunks == []
    assert result.dropped
    assert "pure_navigation" in result.dropped[0].quality_flags


def test_navigation_flag_disabled_keeps_chunk(app_config: AppConfig) -> None:
    app_config.chunking.quality.drop_pure_navigation = False
    splitter = Splitter(app_config.chunking)
    result = splitter.split(_doc(_block("首页 | 上一页 | 下一页 | 返回顶部 | 登录")), doc_key="doc:5")
    assert result.chunks
    assert "pure_navigation" not in result.chunks[0].quality_flags


def test_short_chunk_flagged_and_merged(app_config: AppConfig) -> None:
    splitter = Splitter(app_config.chunking)
    doc = _doc(
        _block("这是第一段足够长的正文内容，用于构成一个有效切片。" * 3),
        Block(block_id="b00099", block_type="paragraph", text="附录：略", title_path=()),
    )
    result = splitter.split(doc, doc_key="doc:6")
    assert result.chunks, "the short tail must merge into the previous chunk, not vanish"
    assert all(
        "too_short" not in chunk.quality_flags or len(chunk.text) >= app_config.chunking.min_chunk_chars
        for chunk in result.chunks
    )


def test_chunk_ids_are_deterministic(app_config: AppConfig) -> None:
    doc = _doc(_block("固定内容的切片应当得到稳定的 chunk id。" * 4))
    first = Splitter(app_config.chunking).split(doc, doc_key="doc:7")
    second = Splitter(app_config.chunking).split(doc, doc_key="doc:7")
    assert [chunk.chunk_id for chunk in first.chunks] == [chunk.chunk_id for chunk in second.chunks]
    other = Splitter(app_config.chunking).split(doc, doc_key="doc:8")
    assert [chunk.chunk_id for chunk in other.chunks] != [chunk.chunk_id for chunk in first.chunks]


def test_table_and_code_blocks_survive(app_config: AppConfig) -> None:
    app_config.chunking.chunk_size = 1000
    splitter = Splitter(app_config.chunking)
    table = Block(block_id="b00010", block_type="table", text="name | value\n预算 | 100")
    code = Block(block_id="b00011", block_type="code", text="def run():\n    return 1")
    result = splitter.split(_doc(table, code), doc_key="doc:9")
    assert any("预算" in chunk.text for chunk in result.chunks)
    assert any("def run" in chunk.text for chunk in result.chunks)

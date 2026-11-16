"""Document normalisation: Feishu tree -> CIR, and structure-aware splitting.

The RAG project's rule set is adopted here so every source behaves the same:
headings build a title path, tables split as "header + one row", code and images
are never cut, and the title is repeated on every chunk of its section.
"""

from __future__ import annotations

import pytest

from knowledge_hub.config.settings import AppConfig, ChunkingSection
from knowledge_hub.rag.cir import Block, DocumentIR
from knowledge_hub.rag.feishu_blocks import bind_image_captions, blocks_to_ir
from knowledge_hub.rag.splitter import Splitter


def _heading(block_id: str, level: int, text: str, parent: str) -> dict:
    return {
        "block_id": block_id,
        "block_type": 2 + level,
        "parent_id": parent,
        "children": [],
        "raw": {f"heading{level}": {"elements": [{"text_run": {"content": text}}]}},
    }


def _text(block_id: str, text: str, parent: str) -> dict:
    return {
        "block_id": block_id,
        "block_type": 2,
        "parent_id": parent,
        "children": [],
        "raw": {"text": {"elements": [{"text_run": {"content": text}}]}},
    }


def _page(block_id: str, children: list[str]) -> dict:
    return {
        "block_id": block_id,
        "block_type": 1,
        "parent_id": "",
        "children": children,
        "raw": {"page": {"elements": []}},
    }


def test_feishu_tree_builds_title_paths_and_order() -> None:
    blocks = [
        _page("root", ["h1", "p1", "h2", "p2"]),
        _heading("h1", 1, "总则", "root"),
        _text("p1", "本制度适用于全体员工。", "root"),
        _heading("h2", 2, "报销", "root"),
        _text("p2", "报销需提供发票。", "root"),
    ]

    ir = blocks_to_ir(blocks, title="差旅制度")

    assert [block.block_type for block in ir.blocks] == [
        "heading",
        "paragraph",
        "heading",
        "paragraph",
    ]
    assert ir.blocks[1].title_path == ("总则",)
    assert ir.blocks[3].title_path == ("总则", "报销")
    assert ir.title == "差旅制度"
    assert ir.source_type == "feishu_docx"


def test_feishu_nested_children_are_flattened_in_document_order() -> None:
    blocks = [
        _page("root", ["callout"]),
        {
            "block_id": "callout",
            "block_type": 19,
            "parent_id": "root",
            "children": ["p1", "p2"],
            "raw": {},
        },
        _text("p1", "第一段", "callout"),
        _text("p2", "第二段", "callout"),
    ]

    ir = blocks_to_ir(blocks)

    assert [block.text for block in ir.blocks] == ["第一段", "第二段"]


def test_feishu_table_becomes_structured_cells() -> None:
    blocks = [
        _page("root", ["table"]),
        {
            "block_id": "table",
            "block_type": 31,
            "parent_id": "root",
            "children": ["c1", "c2", "c3", "c4"],
            "raw": {"table": {"property": {"row_size": 2, "column_size": 2}}},
        },
        {"block_id": "c1", "block_type": 32, "parent_id": "table", "children": ["t1"], "raw": {}},
        {"block_id": "t1", "block_type": 2, "parent_id": "c1", "children": [],
         "raw": {"text": {"elements": [{"text_run": {"content": "城市"}}]}}},
        {"block_id": "c2", "block_type": 32, "parent_id": "table", "children": ["t2"], "raw": {}},
        {"block_id": "t2", "block_type": 2, "parent_id": "c2", "children": [],
         "raw": {"text": {"elements": [{"text_run": {"content": "住宿上限"}}]}}},
        {"block_id": "c3", "block_type": 32, "parent_id": "table", "children": ["t3"], "raw": {}},
        {"block_id": "t3", "block_type": 2, "parent_id": "c3", "children": [],
         "raw": {"text": {"elements": [{"text_run": {"content": "北京"}}]}}},
        {"block_id": "c4", "block_type": 32, "parent_id": "table", "children": ["t4"], "raw": {}},
        {"block_id": "t4", "block_type": 2, "parent_id": "c4", "children": [],
         "raw": {"text": {"elements": [{"text_run": {"content": "600"}}]}}},
    ]

    ir = blocks_to_ir(blocks)
    table = next(block for block in ir.blocks if block.block_type == "table")

    assert table.meta["header"] == ["城市", "住宿上限"]
    assert table.meta["column_size"] == 2


def test_feishu_image_keeps_token_without_fake_text() -> None:
    blocks = [
        _page("root", ["img"]),
        {
            "block_id": "img",
            "block_type": 27,
            "parent_id": "root",
            "children": [],
            "raw": {"image": {"token": "boxcn-abc"}},
        },
    ]

    ir = blocks_to_ir(blocks)
    image = ir.blocks[0]

    assert image.block_type == "image"
    assert image.text == ""
    assert image.meta["token"] == "boxcn-abc"


@pytest.mark.asyncio
async def test_image_caption_becomes_searchable_text() -> None:
    blocks = [
        _page("root", ["img"]),
        {
            "block_id": "img",
            "block_type": 27,
            "parent_id": "root",
            "children": [],
            "raw": {"image": {"token": "boxcn-abc"}},
        },
    ]
    ir = blocks_to_ir(blocks)

    async def describe(token: str, mime: str) -> str:
        assert token == "boxcn-abc"
        return "报销流程示意图：提交、审批、打款"

    await bind_image_captions(ir, describe)

    assert ir.blocks[0].text == "报销流程示意图：提交、审批、打款"


def test_prefilled_image_caption_is_indexed_directly() -> None:
    """导入侧已经调用过视觉模型时，caption 直接写进 image.caption，解析阶段不必再联网。"""
    blocks = [
        _page("root", ["img"]),
        {
            "block_id": "img",
            "block_type": 27,
            "parent_id": "root",
            "children": [],
            "raw": {"image": {"token": "boxcn-abc", "caption": "制度变更对比表：旧标准 200 元，新标准 300 元"}},
        },
    ]

    ir = blocks_to_ir(blocks)

    assert ir.blocks[0].block_type == "image"
    assert ir.blocks[0].text == "制度变更对比表：旧标准 200 元，新标准 300 元"
    assert ir.blocks[0].meta["token"] == "boxcn-abc"


def test_feishu_tree_rejects_broken_structure() -> None:
    with pytest.raises(ValueError, match="根节点"):
        blocks_to_ir([_text("p1", "孤立段落", "missing")])

    duplicated = [_page("root", ["a", "a"]), _text("a", "重复引用", "root")]
    with pytest.raises(ValueError, match="重复引用"):
        blocks_to_ir(duplicated)


def test_feishu_json_upload_is_parsed_as_a_tree() -> None:
    import json

    from knowledge_hub.rag.parser import parse_document

    payload = {
        "document_id": "doxcn-1",
        "blocks": [
            _page("root", ["h1", "p1"]),
            _heading("h1", 1, "报销制度", "root"),
            _text("p1", "报销需要发票。", "root"),
        ],
    }

    ir = parse_document("policy.json", json.dumps(payload).encode("utf-8"))

    assert ir.source_type == "feishu_docx"
    assert [block.block_type for block in ir.blocks] == ["heading", "paragraph"]
    assert ir.blocks[1].title_path == ("报销制度",)
    assert ir.title == "报销制度"


def test_feishu_json_without_extension_is_still_a_tree() -> None:
    """飞书导入落盘的 objectKey 用的是文档标题，没有扩展名。
    之前按后缀分发会走 _parse_text，整篇 JSON 变成 1 个 paragraph 切片，
    于是 kind 全是 paragraph、表格/图片结构全丢。"""
    import json

    from knowledge_hub.rag.parser import parse_document

    payload = {
        "blocks": [
            _page("root", ["h1", "p1"]),
            _heading("h1", 1, "报销制度", "root"),
            _text("p1", "报销需要发票。", "root"),
        ]
    }

    ir = parse_document("PROD-001_A200产品与配置说明", json.dumps(payload).encode("utf-8"))

    assert ir.source_type == "feishu_docx"
    assert [block.kind for block in ir.blocks] == ["heading", "paragraph"]


def test_feishu_openapi_shape_reads_content_from_block_top_level() -> None:
    """真实 openapi 把内容放在块顶层（heading1 / text / table），不套 `raw`。
    之前只认 `raw`：标题变空串、表格变空单元格，整篇文档切出 0 个片段直接入库失败。"""
    blocks = [
        {
            "block_id": "root",
            "block_type": 1,
            "children": ["h1", "p1"],
        },
        {
            "block_id": "h1",
            "block_type": 3,
            "parent_id": "root",
            "heading1": {"elements": [{"text_run": {"content": "报销制度"}}]},
        },
        {
            "block_id": "p1",
            "block_type": 2,
            "parent_id": "root",
            "text": {"elements": [{"text_run": {"content": "报销需要发票。"}}]},
        },
    ]

    ir = blocks_to_ir(blocks)

    assert [block.block_type for block in ir.blocks] == ["heading", "paragraph"]
    assert ir.blocks[0].text == "报销制度"
    assert ir.blocks[1].text == "报销需要发票。"
    assert ir.blocks[1].title_path == ("报销制度",)


def test_image_without_caption_still_produces_a_chunk() -> None:
    """没有描述的图片也要留一条切片：否则「产品外观与内部照片」这种节里
    既看不到图、块类型也不显示图片，检索侧更不知道这里有一张图。"""
    doc = DocumentIR(
        title="A200",
        source_type="feishu_docx",
        blocks=[
            Block(
                block_id="img1",
                block_type="image",
                text="",
                title_path=("A200", "产品外观与内部照片"),
                payload={"token": "LGwWb4dmfoVkaFxbyzwcFUqyn4B", "bucket_name": "kh", "bucket_filename": "a.png"},
            )
        ],
    )

    result = _splitter().split(doc, doc_key="doc1")

    assert len(result.chunks) == 1
    chunk = result.chunks[0]
    assert chunk.kind == "image"
    assert chunk.text == "[图片] 产品外观与内部照片"
    assert chunk.payload["token"] == "LGwWb4dmfoVkaFxbyzwcFUqyn4B"


def test_table_rows_are_not_dropped_as_navigation() -> None:
    """`| a | b |` 的竖线既像菜单也像表格：表格不能被导航启发式误杀。"""
    doc = DocumentIR(
        title="差旅",
        source_type="feishu_docx",
        blocks=[
            Block(
                block_id="t1",
                block_type="table",
                text="城市 | 上限\n北京 | 600",
                title_path=("差旅",),
                meta={"header": ["城市", "上限"], "rows": [["北京", "600"]]},
            )
        ],
    )

    result = _splitter().split(doc, doc_key="doc1")

    assert len(result.chunks) == 1
    assert result.chunks[0].block_type == "table"
    assert result.chunks[0].kind == "table"


def test_json_that_is_not_feishu_blocks_falls_back_to_text() -> None:
    import json

    from knowledge_hub.rag.parser import parse_document

    ir = parse_document("config.json", json.dumps({"a": 1}).encode("utf-8"))

    assert ir.source_type == "txt"
    assert "a" in " ".join(block.text for block in ir.blocks)


def _splitter(chunk_size: int = 400) -> Splitter:
    config = AppConfig().chunking
    return Splitter(
        ChunkingSection(
            chunk_size=chunk_size,
            chunk_overlap=40,
            min_chunk_chars=1,
            quality=config.quality,
        )
    )


def test_table_splits_header_plus_one_row_per_chunk() -> None:
    doc = DocumentIR(
        title="差旅",
        source_type="feishu_docx",
        blocks=[
            Block(
                block_id="t1",
                block_type="table",
                text="",
                title_path=("差旅", "标准"),
                meta={
                    "header": ["城市", "上限"],
                    "rows": [["北京", "600"], ["上海", "500"], ["广州", "450"]],
                },
            )
        ],
    )

    result = _splitter().split(doc, doc_key="doc1")

    assert len(result.chunks) == 3
    assert "北京 | 600" in result.chunks[0].text
    assert result.chunks[0].meta["table_row_index"] == 1
    assert result.chunks[2].meta["table_row_index"] == 3
    # every row chunk carries the header, otherwise a row is meaningless
    assert all("城市 | 上限" in chunk.text for chunk in result.chunks)
    # chunkIndex 是「块内第几片」：表里 3 行 => 0/1/2，总数 3。
    # 以前这里被全局重编号覆盖，界面上会出现"第 6/5 片"这种序号大于总数的组合。
    assert [chunk.chunk_index for chunk in result.chunks] == [0, 1, 2]
    assert all(chunk.chunk_count == 3 for chunk in result.chunks)


def test_chunk_index_stays_within_its_block() -> None:
    """表格后面还有正文时，表格的片号不能被全文档序号顶掉。"""
    doc = DocumentIR(
        title="差旅",
        source_type="feishu_docx",
        blocks=[
            Block(block_id="p1", block_type="paragraph", text="报销说明" * 20, title_path=("差旅",)),
            Block(
                block_id="t1",
                block_type="table",
                text="",
                title_path=("差旅", "标准"),
                meta={"header": ["城市", "上限"], "rows": [["北京", "600"], ["上海", "500"]]},
            ),
        ],
    )

    result = _splitter().split(doc, doc_key="doc1")

    table_chunks = [chunk for chunk in result.chunks if chunk.block_id == "t1"]
    assert [chunk.chunk_index for chunk in table_chunks] == [0, 1]
    assert all(chunk.chunk_count == 2 for chunk in table_chunks)
    assert all(chunk.chunk_index < chunk.chunk_count for chunk in result.chunks)


def test_code_block_is_never_split() -> None:
    code = "\n".join(f"line {index} of a long code sample" for index in range(60))
    doc = DocumentIR(
        title="示例",
        blocks=[Block(block_id="c1", block_type="code", text=code, title_path=("示例",))],
    )

    result = _splitter(chunk_size=200).split(doc, doc_key="doc1")

    assert len(result.chunks) == 1
    assert result.chunks[0].text.endswith("line 59 of a long code sample")


def test_markdown_table_keeps_structure_for_the_splitter(settings) -> None:
    from knowledge_hub.rag.parser import parse_document

    markdown = (
        "## 标准\n\n"
        "| 城市 | 上限 |\n"
        "| --- | --- |\n"
        "| 北京 | 600 |\n"
        "| 上海 | 500 |\n"
    ).encode()

    ir = parse_document("travel.md", markdown)
    table = next(block for block in ir.blocks if block.block_type == "table")

    assert table.meta["header"] == ["城市", "上限"]
    assert table.meta["rows"] == [["北京", "600"], ["上海", "500"]]

    result = _splitter().split(ir, doc_key="doc1")
    table_chunks = [chunk for chunk in result.chunks if chunk.block_type == "table"]
    assert len(table_chunks) == 2
    assert all("城市 | 上限" in chunk.text for chunk in table_chunks)

def test_feishu_doc_reference_becomes_placeholder_and_reference() -> None:
    """内嵌文档引用要变成占位符 + references，检索侧才知道"这段正文还没读"。
    之前 mention_doc 只拼了个标题，占位符丢失，模型会把没读过的内容当成已读到。"""
    blocks = [
        _page("root", ["p1"]),
        {
            "block_id": "p1",
            "block_type": 2,
            "parent_id": "root",
            "children": [],
            "raw": {
                "text": {
                    "elements": [
                        {"text_run": {"content": "详见"}},
                        {"mention_doc": {"token": "doc-9", "title": "报销细则"}},
                    ]
                }
            },
        },
    ]

    ir = blocks_to_ir(blocks)
    block = ir.blocks[0]

    assert '<document-ref id="doc-9">报销细则</document-ref>' in block.text
    assert block.references == [
        {
            "id": "doc-9",
            "kind": "doc",
            "placeholder": '<document-ref id="doc-9">报销细则</document-ref>',
            "title": "报销细则",
        }
    ]


def test_split_chunks_carry_structure_fields_and_chunk_count() -> None:
    """切片必须带 kind/order/block_parent_id/references/payload/chunk_count：
    缺了这些，检索 Agent 的"按 block_id 补父块、按 chunk_count 判断是否读全"就是空转。"""
    doc = DocumentIR(
        title="差旅制度",
        blocks=[
            Block(
                block_id="b1",
                block_type="table",
                text="城市 | 上限\n北京 | 600",
                title_path=("住宿",),
                kind="table",
                order=4,
                block_parent_id="page-1",
                references=[{"id": "blk-9", "kind": "doc", "placeholder": "<document-ref id=\"blk-9\"></document-ref>"}],
                payload={"row_size": 2, "column_size": 2},
                meta={"header": ["城市", "上限"], "rows": [["北京", "600"]]},
            )
        ],
    )

    split = _splitter().split(doc, doc_key="doc1")
    chunk = split.chunks[0]

    assert chunk.kind == "table"
    assert chunk.block_order == 4
    assert chunk.block_parent_id == "page-1"
    assert chunk.references and chunk.references[0]["id"] == "blk-9"
    assert chunk.payload == {"row_size": 2, "column_size": 2}
    assert chunk.chunk_count == 1
    assert chunk.to_dict()["order"] == 4
    assert chunk.to_dict()["tableRowIndex"] == 1


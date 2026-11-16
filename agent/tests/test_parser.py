"""Parser coverage: markdown / html / txt / docx -> CIR."""

from __future__ import annotations

import io

import pytest

from knowledge_hub.errors import ParserError, UnsupportedFile
from knowledge_hub.rag.parser import parse_document

MARKDOWN = """# 客户管理规范

本规范描述客户主数据的维护流程。

## 一、客户创建

- 销售提交申请
- 主管审批

| 字段 | 必填 |
| --- | --- |
| 名称 | 是 |

```sql
select 1;
```
"""


def test_markdown_structure() -> None:
    doc = parse_document("客户管理.md", MARKDOWN.encode("utf-8"))
    assert doc.title == "客户管理规范"
    types = [block.block_type for block in doc.blocks]
    assert "heading" in types
    assert "table" in types
    assert "code" in types
    assert "list" in types
    table_block = next(block for block in doc.blocks if block.block_type == "table")
    assert "必填" in table_block.text
    paragraph = next(block for block in doc.blocks if block.block_type == "paragraph")
    assert paragraph.title_path == ("客户管理规范",)


def test_markdown_nested_title_path() -> None:
    text = "# 一级\n\n正文一\n\n## 二级\n\n正文二\n"
    doc = parse_document("a.md", text.encode("utf-8"))
    second_level_blocks = [b for b in doc.blocks if b.title_path == ("一级", "二级")]
    assert second_level_blocks
    assert "正文二" in second_level_blocks[-1].text


def test_html_parsing() -> None:
    html = "<html><head><title>制度汇编</title></head><body><h1>考勤</h1><p>每天九点上班。</p><table><tr><td>迟到</td><td>扣款</td></tr></table></body></html>"
    doc = parse_document("policy.html", html.encode("utf-8"))
    assert doc.title == "考勤"
    assert any(block.block_type == "table" and "扣款" in block.text for block in doc.blocks)
    assert any(block.block_type == "paragraph" and "九点" in block.text for block in doc.blocks)


def test_txt_parsing_and_language_detection() -> None:
    doc = parse_document("note.txt", "第一段内容。\n\n第二段内容。".encode())
    assert doc.lang == "zh"
    assert len(doc.blocks) == 2


def test_docx_parsing() -> None:
    docx = pytest.importorskip("docx")
    document = docx.Document()
    document.add_heading("报销制度", level=1)
    document.add_paragraph("差旅报销需提供发票。")
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "项目"
    table.cell(0, 1).text = "上限"
    table.cell(1, 0).text = "住宿"
    table.cell(1, 1).text = "500"
    buffer = io.BytesIO()
    document.save(buffer)

    parsed = parse_document("报销.docx", buffer.getvalue())
    assert parsed.title == "报销制度"
    assert any(block.block_type == "heading" for block in parsed.blocks)
    assert any("发票" in block.text for block in parsed.blocks)
    assert any(block.block_type == "table" and "住宿" in block.text for block in parsed.blocks)


def test_unsupported_extension_rejected() -> None:
    with pytest.raises(UnsupportedFile):
        parse_document("data.xlsx", b"plain spreadsheet bytes")


def test_empty_document_rejected() -> None:
    with pytest.raises(ParserError):
        parse_document("empty.txt", b"")


def test_utf8_bom_and_gb18030() -> None:
    assert parse_document("a.txt", "\ufeff带 BOM".encode("utf-8")).blocks[0].text == "带 BOM"
    assert "中文" in parse_document("b.txt", "中文编码".encode("gb18030")).blocks[0].text

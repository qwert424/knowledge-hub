"""Citation metadata: title resolution matrix, URL sanitising, snippet trimming."""

from __future__ import annotations

import pytest

from knowledge_hub.rag.citations import (
    MAX_SNIPPET_CHARS,
    clean_source_url,
    resolve_title,
    trim_snippet,
)


@pytest.mark.parametrize(
    ("doc_title", "title_path", "block_type", "expected"),
    [
        # document title wins when known
        ("客户管理规范", ["一、流程", "1.1 创建"], "paragraph", "客户管理规范"),
        # otherwise the first non-empty title_path segment
        ("", ["客户管理规范", "一、流程"], "paragraph", "客户管理规范"),
        ("", ["", "二、附件"], "table", "二、附件"),
        # block type only when nothing else exists
        ("", [], "paragraph", "paragraph"),
        ("", ["", "  "], "code", "code"),
        # last-resort placeholder, never empty
        ("", [], "", "chunk"),
    ],
)
def test_resolve_title_matrix(
    doc_title: str, title_path: list[str], block_type: str, expected: str
) -> None:
    assert resolve_title(doc_title, title_path, block_type) == expected


def test_title_is_never_block_type_when_a_title_exists() -> None:
    title = resolve_title("", ["", "报销制度"], "paragraph")
    assert title == "报销制度"
    assert title != "paragraph"


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://wiki.example.com/a/b", "https://wiki.example.com/a/b"),
        ("http://intranet/doc?id=3", "http://intranet/doc?id=3"),
        # internal/legacy pseudo-URIs must never surface as citation links
        ("kh://kb_001/doc_1", ""),
        ("minio://knowledge-hub/docs/a.md", ""),
        ("file:///D:/tmp/a.md", ""),
        ("", ""),
        ("   ", ""),
    ],
)
def test_clean_source_url(url: str, expected: str) -> None:
    assert clean_source_url(url) == expected


def test_snippet_short_text_is_untouched() -> None:
    text = "差旅报销需要提供发票。"
    assert trim_snippet(text, "报销") == text


def test_snippet_is_trimmed_around_match() -> None:
    text = ("无关内容" * 200) + "差旅报销需要提供发票与行程单" + ("尾部内容" * 200)
    snippet = trim_snippet(text, "发票与行程单")
    assert len(snippet) <= MAX_SNIPPET_CHARS
    assert "发票与行程单" in snippet
    assert snippet.startswith("…") and snippet.endswith("…")


def test_snippet_without_query_takes_head() -> None:
    text = "甲" * 500
    snippet = trim_snippet(text, "")
    assert len(snippet) <= MAX_SNIPPET_CHARS
    assert snippet.endswith("…")
    assert not snippet.startswith("…")


def test_snippet_match_near_end_keeps_leading_ellipsis_only() -> None:
    text = ("前言" * 150) + "结尾关键词"
    snippet = trim_snippet(text, "关键词")
    assert "关键词" in snippet
    assert snippet.startswith("…")
    assert not snippet.endswith("…")
    assert len(snippet) <= MAX_SNIPPET_CHARS


def test_snippet_whitespace_is_normalised() -> None:
    text = "第一行\n\n第二行    第三行"
    assert trim_snippet(text) == "第一行 第二行 第三行"

def test_citation_marker_rewrites_book_title_reference() -> None:
    """模型写的 [《文档名》] 必须变成 [cN]，否则前端来源面板挂不上。"""
    from knowledge_hub.rag.citations import rewrite_citation_markers

    titles = ["A400 推理一体机产品与配置说明", "差旅报销管理办法"]
    text = "内存 512 GB[《A400 推理一体机产品与配置说明》]，住宿上限 600 元[《差旅报销管理办法》](http://x/y)。"
    out = rewrite_citation_markers(text, titles)
    assert "[c1]" in out
    assert "[c2]" in out
    assert "《" not in out


def test_citation_marker_keeps_unknown_bracket_text() -> None:
    from knowledge_hub.rag.citations import rewrite_citation_markers

    text = "见[《不存在的文档》]。"
    assert rewrite_citation_markers(text, ["A400 推理一体机产品与配置说明"]) == text


def test_citation_marker_collapses_double_wrapped_image() -> None:
    """[![图](url)](url) 要还原成单个图片，渲染器才不会套一层链接。"""
    from knowledge_hub.rag.citations import rewrite_citation_markers

    url = "http://127.0.0.1:9002/knowledge-hub/a400.png?sign=1"
    text = f"[![]({url})]({url})"
    out = rewrite_citation_markers(text, [])
    assert out == f"![]({url})"


def test_citation_marker_streaming_holds_partial_bracket() -> None:
    """流式输出时，被切断的 [《… 不能先发出去再补救。"""
    from knowledge_hub.rag.citations import CitationMarker

    marker = CitationMarker(["A400 推理一体机产品与配置说明"])
    assert marker.feed("内存 512 GB[") == "内存 512 GB"
    assert marker.feed("《A400 推理一") == ""
    assert marker.feed("体机产品与配置说明》]") == "[c1]"
    assert marker.flush() == ""

"""工具契约：标量查询的租户隔离、批量抓取、以及工具名与 reference 项目对齐。"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from knowledge_hub.config.settings import Settings
from knowledge_hub.runtime.tools import ToolContext, build_toolset
from knowledge_hub.security.tickets import RetrievalTicket


def _ticket(kb_ids: tuple[str, ...] = ("kb_001",)) -> RetrievalTicket:
    return RetrievalTicket(
        tenant_id="t_001",
        user_id="u_1",
        principals=("user:u_1",),
        kb_ids=kb_ids,
    )


class FakeStore:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, int, int]] = []

    def query_scalar(self, collection: str, expr: str, *, limit: int, offset: int, dim: int) -> list[dict[str, Any]]:
        self.calls.append((collection, expr, limit, offset))
        return [
            {
                "kb_id": "kb_001",
                "doc_id": "doc-1",
                "chunk_id": "c-1",
                "chunk_index": 3,
                "doc_title": "差旅制度",
                "title_path": ["住宿"],
                "text": "一线城市每晚不超过 600 元",
            }
        ]


@pytest.mark.asyncio
async def test_milvus_query_scopes_to_tenant_and_kb(settings: Settings) -> None:
    store = FakeStore()
    ctx = ToolContext(
        settings=settings,
        ticket=_ticket(),
        kb_ids=["kb_001"],
        session_key="s",
        store=store,
        kb_collections={"kb_001": "kh_demo_1024"},
        embedding_dim=1024,
    )
    toolset = build_toolset(["milvus_query"], ctx)
    out = await toolset.tools["milvus_query"].handler(
        filter='doc_id == "doc-1"', limit=10, offset=0, ctx=ctx
    )

    collection, expr, limit, offset = store.calls[0]
    assert collection == "kh_demo_1024"
    # 租户与知识库约束由服务端拼接，模型只能收窄
    assert 'tenant_id == "t_001"' in expr
    assert 'kb_id == "kb_001"' in expr
    assert 'doc_id == "doc-1"' in expr
    assert (limit, offset) == (10, 0)
    assert json.loads(out.splitlines()[0])["chunk_index"] == 3


@pytest.mark.asyncio
async def test_milvus_query_rejects_kb_outside_ticket(settings: Settings) -> None:
    store = FakeStore()
    ctx = ToolContext(
        settings=settings,
        ticket=_ticket(("kb_001",)),
        kb_ids=["kb_999"],
        session_key="s",
        store=store,
        kb_collections={"kb_999": "kh_other_1024"},
        embedding_dim=1024,
    )
    toolset = build_toolset(["milvus_query"], ctx)
    out = await toolset.tools["milvus_query"].handler(filter="", ctx=ctx)
    assert "没有可查询" in out
    assert store.calls == []


@pytest.mark.asyncio
async def test_fetch_url_supports_multiple_urls(settings: Settings) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=f"<html><body><p>{request.url}</p></body></html>",
                              headers={"content-type": "text/html"})

    ctx = ToolContext(
        settings=settings,
        ticket=_ticket(),
        fetch_transport=httpx.MockTransport(handler),
    )
    toolset = build_toolset(["fetch_url"], ctx)
    out = await toolset.tools["fetch_url"].handler(
        urls=["https://a.example/x", "https://b.example/y"], ctx=ctx
    )
    assert "https://a.example/x" in out and "https://b.example/y" in out


@pytest.mark.asyncio
async def test_fetch_url_rejects_non_http(settings: Settings) -> None:
    ctx = ToolContext(settings=settings, ticket=_ticket())
    toolset = build_toolset(["fetch_url"], ctx)
    assert "只支持" in await toolset.tools["fetch_url"].handler(url="file:///etc/passwd", ctx=ctx)
    assert "请提供" in await toolset.tools["fetch_url"].handler(ctx=ctx)


def test_spec_tool_names_are_all_available(settings: Settings) -> None:
    """reference 项目的 8 个工具名，本实现都要能解析出来（否则会被标 skipped）。"""
    ctx = ToolContext(settings=settings, ticket=_ticket(), session_key="s")
    names = [
        "ask_user_question",
        "deploy",
        "fetch_url",
        "get_bucket_file_url",
        "get_current_time",
        "milvus_query",
        "milvus_search",
        "web_search",
    ]
    toolset = build_toolset(names, ctx)
    skipped = set(toolset.skipped)
    # 依赖外部能力的（milvus/web/sandbox）在无依赖时应被明确跳过，而不是伪造
    assert "get_current_time" in toolset
    assert "ask_user_question" in toolset
    assert skipped <= {"deploy", "milvus_query", "milvus_search", "web_search"}

@pytest.mark.asyncio
async def test_milvus_query_exposes_structure_contract(settings: Settings) -> None:
    """标量查询必须给出结构字段（kind/order/chunk_count/references/payload），
    否则检索 Agent 的"按 block_id 补查父块/引用块"没法做。"""
    store = FakeStore()
    ctx = ToolContext(
        settings=settings,
        ticket=_ticket(),
        kb_ids=["kb_001"],
        session_key="s",
        store=store,
        kb_collections={"kb_001": "kh_demo_1024"},
        embedding_dim=1024,
    )
    toolset = build_toolset(["milvus_query"], ctx)
    out = await toolset.tools["milvus_query"].handler(filter="", limit=5, offset=0, ctx=ctx)
    row = json.loads(out.strip().splitlines()[0])
    for field in ("id", "block_id", "block_parent_id", "kind", "order", "chunk_count", "references", "payload"):
        assert field in row, f"缺少字段 {field}"


@pytest.mark.asyncio
async def test_graph_search_tool_available_only_when_graph_wired(settings: Settings) -> None:
    """图检索必须真的能挂到检索 Agent 上（之前 graph 根本没有对应的工具）。"""

    class FakeGraph:
        enabled = True

        async def query(self, **_kwargs: Any) -> Any:
            class _Result:
                degraded = False
                reason = "ok"
                hits: list[Any] = []
                entities = [{"name": "差旅标准"}]
                relations: list[Any] = []
                communities: list[Any] = []

            return _Result()

    ctx = ToolContext(settings=settings, ticket=_ticket(), session_key="s")
    assert "graph_search" not in build_toolset(["graph_search"], ctx)

    ctx.graph = FakeGraph()
    toolset = build_toolset(["graph_search"], ctx)
    assert "graph_search" in toolset
    out = await toolset.tools["graph_search"].handler(query="差旅", hops=2, ctx=ctx)
    assert "差旅标准" in out


@pytest.mark.asyncio
async def test_graph_search_is_added_to_retrieval_toolset(settings: Settings) -> None:
    """检索类 Agent 只要图已启用就自动拿到 graph_search，
    不用为了一个工具去改 Nacos agentspec（那要走草稿/审核/上线）。"""

    class FakeGraph:
        enabled = True

    ctx = ToolContext(settings=settings, ticket=_ticket(), session_key="s")
    ctx.retriever = object()
    ctx.graph = FakeGraph()

    toolset = build_toolset(["milvus_search"], ctx)
    assert "graph_search" in toolset
    assert "graph_search" not in toolset.skipped


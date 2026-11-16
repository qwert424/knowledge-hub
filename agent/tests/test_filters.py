"""ACL filter: tenant + principals + status always present; injection cannot alter it."""

from __future__ import annotations

import pytest

from knowledge_hub.config.settings import EnvSettings
from knowledge_hub.errors import FilterError, PermissionDenied
from knowledge_hub.rag.filters import build_filter, is_visible, sanitize_ident
from knowledge_hub.rag.retriever import RetrievedChunk, fuse_rrf
from knowledge_hub.rag.store import Hit
from knowledge_hub.security.tickets import RetrievalTicket, TicketVerifier
from tests.conftest import make_ticket


def _ticket(env: EnvSettings, **kwargs) -> RetrievalTicket:
    return TicketVerifier.from_env(env).verify(make_ticket(env, **kwargs))


def test_filter_always_contains_tenant_status_principals(env_settings: EnvSettings) -> None:
    ticket = _ticket(env_settings)
    expr = build_filter(ticket, ["kb_001", "kb_002"])
    assert 'tenant_id == "t_001"' in expr
    assert "(kb_id in [\"kb_001\", \"kb_002\"])" in expr
    assert 'status == "active"' in expr
    assert "acl_principals" in expr
    assert 'visibility == "public"' in expr
    assert "user:u_123" in expr and "tenant:all" in expr


def test_filter_requires_principals(env_settings: EnvSettings) -> None:
    ticket = _ticket(env_settings, principals=())
    with pytest.raises(PermissionDenied):
        build_filter(ticket, ["kb_001"])


def test_filter_rejects_injection_in_kb_id(env_settings: EnvSettings) -> None:
    ticket = _ticket(env_settings)
    malicious = 'kb_001" or tenant_id != "other'
    with pytest.raises(FilterError):
        build_filter(ticket, [malicious])


def test_filter_rejects_injection_in_principal(env_settings: EnvSettings) -> None:
    token = make_ticket(env_settings)
    ticket = RetrievalTicket(
        tenant_id="t_001",
        user_id="u_1",
        principals=('user:x"]) or (tenant_id != "y',),
        kb_ids=("kb_001",),
    )
    with pytest.raises(FilterError):
        build_filter(ticket, ["kb_001"])
    # The genuine token still produces a clean predicate.
    expr = build_filter(TicketVerifier.from_env(env_settings).verify(token), ["kb_001"])
    assert "t_999" not in expr
    assert "user:x" not in expr


def test_filter_ignores_query_text(env_settings: EnvSettings) -> None:
    """build_filter has no query parameter: query text cannot influence the predicate."""
    ticket = _ticket(env_settings)
    baseline = build_filter(ticket, ["kb_001"])
    injected_query = '随便写 " or tenant_id == "t_999" or "'
    assert injected_query not in baseline
    assert build_filter(ticket, ["kb_001"]) == baseline


def test_empty_kb_ids_rejected(env_settings: EnvSettings) -> None:
    ticket = _ticket(env_settings)
    with pytest.raises(FilterError):
        build_filter(ticket, [])


def test_tag_filter_only_narrows(env_settings: EnvSettings) -> None:
    """标签是可选的额外 AND 条件：不会替换 ACL，注入的标签直接拒绝。"""
    ticket = _ticket(env_settings)
    baseline = build_filter(ticket, ["kb_001"])
    with_tags = build_filter(ticket, ["kb_001"], tags=["财务", "制度-2026"])
    assert 'ARRAY_CONTAINS_ANY(tags, ["财务", "制度-2026"])' in with_tags
    # ACL 子句与基线一致，标签只是多了一个 AND
    assert "acl_principals" in with_tags and 'tenant_id == "t_001"' in with_tags
    assert with_tags.startswith('(tenant_id == "t_001") and (kb_id in ["kb_001"]) and (status == "active")')
    assert with_tags.endswith(
        '((visibility == "public") or (ARRAY_CONTAINS_ANY(acl_principals, ["user:u_123", "tenant:all"])))'
    )

    for bad in ('财务" or tenant_id != "x', "a b", "x" * 100, ""):
        with pytest.raises(FilterError):
            build_filter(ticket, ["kb_001"], tags=[bad])

    assert build_filter(ticket, ["kb_001"], tags=[]) == baseline


def test_sanitize_ident() -> None:
    assert sanitize_ident("t_001", "tenant") == "t_001"
    assert sanitize_ident("user:u-1.2_x", "principal") == "user:u-1.2_x"
    for bad in ("", 'a"b', "a b", "a;b", "a\\b", "x" * 200):
        with pytest.raises(FilterError):
            sanitize_ident(bad, "tenant")


def test_is_visible_checks_tenant_and_acl() -> None:
    ticket = RetrievalTicket(
        tenant_id="t_001", user_id="u_1", principals=("user:u_1",), kb_ids=("kb_001",)
    )
    assert is_visible(
        {"tenant_id": "t_001", "visibility": "public", "status": "active", "acl_principals": []},
        ticket,
    )
    assert is_visible(
        {
            "tenant_id": "t_001",
            "visibility": "private",
            "status": "active",
            "acl_principals": ["user:u_1"],
        },
        ticket,
    )
    assert not is_visible(
        {
            "tenant_id": "t_002",
            "visibility": "public",
            "status": "active",
            "acl_principals": ["user:u_1"],
        },
        ticket,
    )
    assert not is_visible(
        {
            "tenant_id": "t_001",
            "visibility": "private",
            "status": "active",
            "acl_principals": ["user:someone-else"],
        },
        ticket,
    )


def test_fuse_rrf_orders_by_reciprocal_rank() -> None:
    dense = [Hit(pk="a", text="a", score=0.9), Hit(pk="b", text="b", score=0.8)]
    sparse = [Hit(pk="b", text="b", score=5.0), Hit(pk="c", text="c", score=4.0)]
    fused = fuse_rrf(dense, sparse, k=60)
    assert [hit.pk for hit in fused] == ["b", "a", "c"]
    assert fused[0].score > fused[1].score > 0
    # 裸列表按位置套默认 lane
    assert [hit.matched_by for hit in fused] == [["dense", "sparse"], ["dense"], ["sparse"]]


def test_fuse_rrf_uses_explicit_lanes_for_multiple_kbs() -> None:
    """多知识库时 dense/sparse 都是多份列表：必须按 lane 打标签。

    以前按位置硬套 dense/sparse/graph，第二个库的稠密结果被标成"稀疏"、
    稀疏结果被标成"图谱"，界面上每条都显示三路来源。
    """
    kb1_dense = [Hit(pk="a", text="a", score=0.9)]
    kb2_dense = [Hit(pk="b", text="b", score=0.9)]
    kb1_sparse = [Hit(pk="a", text="a", score=5.0)]
    kb2_sparse = [Hit(pk="c", text="c", score=4.0)]
    fused = fuse_rrf(
        ("dense", kb1_dense),
        ("dense", kb2_dense),
        ("sparse", kb1_sparse),
        ("sparse", kb2_sparse),
        ("graph", []),
        k=60,
    )
    lanes = {hit.pk: hit.matched_by for hit in fused}
    assert lanes["a"] == ["dense", "sparse"]
    assert lanes["b"] == ["dense"]
    assert lanes["c"] == ["sparse"]
    assert "graph" not in {lane for hits in lanes.values() for lane in hits}


def test_retrieved_chunk_contract_shape() -> None:
    chunk = RetrievedChunk(
        chunk_id="c1",
        doc_id="d1",
        title="T",
        title_path=["T"],
        text="hello",
        score=0.1234567,
        source_url="kh://x",
        block_type="paragraph",
    )
    body = chunk.to_contract()
    assert set(body) == {
        "chunk_id",
        "doc_id",
        "title",
        "title_path",
        "text",
        "score",
        "source_url",
        "block_type",
        "kind",
        "chunk_count",
        "table_row_index",
        "matched_by",
        "image_url",
        "highlights",
    }
    assert body["score"] == 0.123457
    # kind 缺省回落到 block_type：老数据没有 kind 字段也不能变成空
    assert body["kind"] == "paragraph"
    assert body["chunk_count"] == 1

"""Retriever collection resolution: kb_collections -> profile -> kb_chunks_{dim}.

Also covers the "collection missing" degradation: skip the kb, never 500.
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from knowledge_hub.config.settings import Settings
from knowledge_hub.errors import MilvusUnavailable
from knowledge_hub.rag.retriever import Retriever, RetrieveResult, fuse_weighted
from knowledge_hub.rag.store import Hit
from knowledge_hub.security.tickets import RetrievalTicket


class FakeEmbedder:
    async def embed_query(self, text: str) -> list[float]:
        return [0.1] * 8


class FakeStore:
    def __init__(self, existing: dict[str, bool], hits: dict[str, list[Hit]] | None = None) -> None:
        self.existing = existing
        self.hits = hits or {}
        self.dense_calls: list[str] = []
        self.sparse_calls: list[str] = []
        self.filters: list[str] = []

    def existing_collections(self, names: Sequence[str]) -> dict[str, bool]:
        return {name: self.existing.get(name, False) for name in names}

    def search_dense(
        self,
        collection: str,
        vector: Sequence[float],
        filter_expr: str,
        *,
        limit: int,
        dim: int,
    ) -> list[Hit]:
        self.dense_calls.append(collection)
        self.filters.append(filter_expr)
        return list(self.hits.get(collection, []))

    def search_sparse(
        self,
        collection: str,
        query: str,
        filter_expr: str,
        *,
        limit: int,
        dim: int,
    ) -> list[Hit]:
        self.sparse_calls.append(collection)
        return []

    def supports_sparse(self, collection: str) -> bool:
        return False


def _hit(pk: str, collection: str, text: str = "报销需要发票。") -> Hit:
    return Hit(
        pk=pk,
        text=text,
        score=0.9,
        doc_id=f"doc-{pk}",
        kb_id="kb_001",
        tenant_id="t_001",
        version_id="v1",
        title_path=["制度"],
        visibility="public",
        status="active",
    )


def _ticket(kb_ids: tuple[str, ...] = ("kb_001", "kb_002")) -> RetrievalTicket:
    return RetrievalTicket(
        tenant_id="t_001",
        user_id="u_1",
        principals=("user:u_1", "tenant:all"),
        kb_ids=kb_ids,
    )


def _retriever(settings: Settings, store: FakeStore) -> Retriever:
    return Retriever(settings, store=store, embedder=FakeEmbedder())  # type: ignore[arg-type]


def test_collection_precedence(settings: Settings) -> None:
    retriever = _retriever(settings, FakeStore({}))
    explicit = retriever.resolve_collections(
        ["kb_001"], {"collectionName": "profile_coll"}, {"kb_001": "kh_demo_8"}
    )
    assert explicit == [("kb_001", "kh_demo_8")]

    from_profile = retriever.resolve_collections(["kb_001"], {"collectionName": "profile_coll"}, {})
    assert from_profile == [("kb_001", "profile_coll")]

    fallback = retriever.resolve_collections(["kb_001"], None, None)
    assert fallback == [("kb_001", "kb_chunks_8")]


def test_kb_collections_do_not_leak_across_kbs(settings: Settings) -> None:
    retriever = _retriever(settings, FakeStore({}))
    targets = retriever.resolve_collections(["kb_002"], None, {"kb_001": "kh_demo_8"})
    assert targets == [("kb_002", "kb_chunks_8")]


def test_profile_retrieve_nested_collection(settings: Settings) -> None:
    retriever = _retriever(settings, FakeStore({}))
    targets = retriever.resolve_collections(["kb_001"], {"retrieve": {"collectionName": "c1"}}, {})
    assert targets == [("kb_001", "c1")]


async def test_retrieval_uses_mapped_collection(settings: Settings) -> None:
    store = FakeStore({"kh_demo_8": True}, {"kh_demo_8": [_hit("c1", "kh_demo_8")]})
    retriever = _retriever(settings, store)
    result = await retriever.retrieve(
        ticket=_ticket(("kb_001",)),
        kb_ids=["kb_001"],
        query="报销",
        kb_collections={"kb_001": "kh_demo_8"},
    )
    assert [chunk.chunk_id for chunk in result.chunks] == ["c1"]
    assert store.dense_calls == ["kh_demo_8"]
    assert result.debug["collections"] == ["kh_demo_8"]
    assert result.debug["skipped_kbs"] == []
    assert 'tenant_id == "t_001"' in store.filters[0]


async def test_missing_collection_is_skipped(settings: Settings) -> None:
    store = FakeStore({"coll_a": True, "coll_b": False}, {"coll_a": [_hit("c1", "coll_a")]})
    retriever = _retriever(settings, store)
    result: RetrieveResult = await retriever.retrieve(
        ticket=_ticket(),
        kb_ids=["kb_001", "kb_002"],
        query="报销",
        kb_collections={"kb_001": "coll_a", "kb_002": "coll_b"},
    )
    assert [chunk.chunk_id for chunk in result.chunks] == ["c1"]
    assert result.debug["skipped_kbs"] == [
        {"kb_id": "kb_002", "collection": "coll_b", "reason": "collection_missing"}
    ]
    assert result.debug["collections"] == ["coll_a"]
    assert "all_collections_missing" not in result.debug
    assert store.dense_calls == ["coll_a"]


async def test_all_collections_missing_returns_empty(settings: Settings) -> None:
    retriever = _retriever(settings, FakeStore({"coll_a": False, "coll_b": False}))
    result = await retriever.retrieve(
        ticket=_ticket(),
        kb_ids=["kb_001", "kb_002"],
        query="报销",
        kb_collections={"kb_001": "coll_a", "kb_002": "coll_b"},
    )
    assert result.chunks == []
    assert result.debug["all_collections_missing"] is True
    assert result.debug["reason"] == "no_kb_collection"
    assert {item["kb_id"] for item in result.debug["skipped_kbs"]} == {"kb_001", "kb_002"}


async def test_kb_not_in_ticket_is_never_queried(settings: Settings) -> None:
    store = FakeStore({"kh_secret_8": True})
    retriever = _retriever(settings, store)
    result = await retriever.retrieve(
        ticket=_ticket(("kb_001",)),
        kb_ids=["kb_001", "kb_evil"],
        query="报销",
        kb_collections={"kb_evil": "kh_secret_8"},
    )
    assert result.chunks == []
    assert result.debug["collections"] == []
    assert store.dense_calls == []
    assert {item["kb_id"] for item in result.debug["skipped_kbs"]} == {"kb_001"}


def test_collection_for_helper(settings: Settings) -> None:
    retriever = _retriever(settings, FakeStore({}))
    assert retriever.collection_for({"collectionName": "x"}) == "x"
    assert retriever.collection_for(None) == "kb_chunks_8"

class _BreakerSession:
    def __init__(self) -> None:
        self.failures = 0
        self.successes = 0

    def note_failure(self) -> None:
        self.failures += 1

    def note_success(self) -> None:
        self.successes += 1


class BreakerStore(FakeStore):
    """向量库不可用/正常可切换的 store，用来验证熔断信号是否上报。"""

    def __init__(self) -> None:
        super().__init__({"kb_chunks_8": True})
        self.session = _BreakerSession()
        self.failing = True

    def existing_collections(self, names: Sequence[str]) -> dict[str, bool]:
        if self.failing:
            raise MilvusUnavailable("milvus unreachable")
        return super().existing_collections(names)


async def test_retrieval_failure_trips_store_breaker(settings: Settings) -> None:
    store = BreakerStore()
    retriever = _retriever(settings, store)

    with pytest.raises(MilvusUnavailable):
        await retriever.retrieve(ticket=_ticket(), kb_ids=["kb_001"], query="报销怎么办")
    assert store.session.failures == 1

    store.failing = False
    await retriever.retrieve(ticket=_ticket(), kb_ids=["kb_001"], query="报销怎么办")
    assert store.session.successes == 1


def test_milvus_session_backs_off_after_failure(settings: Settings) -> None:
    from knowledge_hub.tools.milvus import MilvusSession

    session = MilvusSession(settings.env)
    session.note_failure()
    # 熔断窗口内直接失败，不再发起真实连接（否则会把检索预算耗光）
    with pytest.raises(MilvusUnavailable):
        session.connect()

    session.note_success()
    assert session._fail_until == 0.0


async def test_fusion_model_mode_enables_rerank(settings: Settings, monkeypatch) -> None:
    """融合策略选模型模式时，即使重排开关没开也要走重排。"""
    store = FakeStore({"kh_demo_8": True}, {"kh_demo_8": [_hit("c1", "kh_demo_8")]})
    retriever = _retriever(settings, store)
    calls: list[int] = []

    async def fake_rerank(query, hits, *, top_n, model=None):  # noqa: ANN001, ANN202
        calls.append(top_n)
        return list(hits)

    monkeypatch.setattr(retriever, "_rerank", fake_rerank)
    result = await retriever.retrieve(
        ticket=_ticket(("kb_001",)),
        kb_ids=["kb_001"],
        query="报销",
        profile={"fusion": "model", "rerank": {"enabled": False, "top_n": 3}},
        include_debug=True,
        kb_collections={"kb_001": "kh_demo_8"},
    )
    assert result.debug["fusion"] == "model"
    assert calls == [3]
    assert [chunk.chunk_id for chunk in result.chunks] == ["c1"]


async def test_fusion_rrf_keeps_rerank_off(settings: Settings, monkeypatch) -> None:
    store = FakeStore({"kh_demo_8": True}, {"kh_demo_8": [_hit("c1", "kh_demo_8")]})
    retriever = _retriever(settings, store)
    calls: list[int] = []

    async def fake_rerank(query, hits, *, top_n, model=None):  # noqa: ANN001, ANN202
        calls.append(top_n)
        return list(hits)

    monkeypatch.setattr(retriever, "_rerank", fake_rerank)
    result = await retriever.retrieve(
        ticket=_ticket(("kb_001",)),
        kb_ids=["kb_001"],
        query="报销",
        profile={"fusion": "rrf", "rerank": {"enabled": False, "top_n": 8}},
        include_debug=True,
        kb_collections={"kb_001": "kh_demo_8"},
    )
    assert result.debug["fusion"] == "rrf"
    assert calls == []


async def test_fusion_weighted_uses_weights(settings: Settings) -> None:
    """权重模式：把 dense 权重调到 1、sparse 调到 0，只有稠密命中的那条应该排第一。"""
    dense_hits = [_hit("d1", "kh_demo_8", "稠密"), _hit("d2", "kh_demo_8", "稠密 2")]
    sparse_hits = [_hit("s1", "kh_demo_8", "稀疏")]
    dense_hits[0].score = 0.4
    dense_hits[1].score = 0.2
    sparse_hits[0].score = 0.9

    fused = fuse_weighted(
        ("dense", dense_hits), ("sparse", sparse_hits), weights={"dense": 1.0, "sparse": 0.0}
    )
    assert fused[0].pk == "d1"
    assert fused[0].matched_by == ["dense"]

    fused_sparse = fuse_weighted(
        ("dense", dense_hits), ("sparse", sparse_hits), weights={"dense": 0.0, "sparse": 1.0}
    )
    assert fused_sparse[0].pk == "s1"
    assert fused_sparse[0].matched_by == ["sparse"]


async def test_blank_profile_values_do_not_break(settings: Settings) -> None:
    """Nacos 里某些字段留空（"" 或 null）不能把检索搞崩：按默认值走。"""
    store = FakeStore({"kh_demo_8": True}, {"kh_demo_8": [_hit("c1", "kh_demo_8")]})
    retriever = _retriever(settings, store)
    result = await retriever.retrieve(
        ticket=_ticket(("kb_001",)),
        kb_ids=["kb_001"],
        query="报销",
        profile={
            "fusion": "",
            "fusion_k": None,
            "dense_weight": None,
            "sparse_weight": "",
            "dense_top_k": None,
            "sparse_top_k": "",
            "top_k": None,
            "timeout_ms": None,
            "rerank": {"enabled": False, "model": "", "top_n": None},
            "graph": {"enabled": False, "hops": None},
        },
        include_debug=True,
        kb_collections={"kb_001": "kh_demo_8"},
    )
    assert [chunk.chunk_id for chunk in result.chunks] == ["c1"]
    assert result.debug["fusion"] == "rrf"


async def test_image_chunk_gets_presigned_url(settings: Settings, monkeypatch) -> None:
    """图片块要带上直连地址，否则模型只能描述图片、给不出图。"""
    hit = _hit("img1", "kh_demo_8", "产品外观与接口照片")
    hit.kind = "image"
    hit.block_type = "image"
    hit.payload = {"bucket_name": "feishu-images", "bucket_filename": "a.png"}
    store = FakeStore({"kh_demo_8": True}, {"kh_demo_8": [hit]})
    retriever = _retriever(settings, store)

    monkeypatch.setattr(
        "knowledge_hub.rag.objectstore.presigned_get",
        lambda *args, **kwargs: "http://127.0.0.1:9000/feishu-images/a.png?sig=1",
    )
    # HEAD 存在性检查不走真网络
    monkeypatch.setattr("knowledge_hub.rag.objectstore.object_exists", lambda *a, **k: True)
    result = await retriever.retrieve(
        ticket=_ticket(("kb_001",)),
        kb_ids=["kb_001"],
        query="产品外观",
        kb_collections={"kb_001": "kh_demo_8"},
    )
    assert result.chunks[0].image_url.startswith("http://127.0.0.1:9000/")


async def test_text_chunk_has_no_image_url(settings: Settings) -> None:
    store = FakeStore({"kh_demo_8": True}, {"kh_demo_8": [_hit("c1", "kh_demo_8")]})
    retriever = _retriever(settings, store)
    result = await retriever.retrieve(
        ticket=_ticket(("kb_001",)),
        kb_ids=["kb_001"],
        query="报销",
        kb_collections={"kb_001": "kh_demo_8"},
    )
    assert result.chunks[0].image_url == ""

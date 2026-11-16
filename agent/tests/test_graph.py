"""GraphRAG: Neo4j store filters, extraction build, and dense/sparse/graph fusion."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import pytest

from knowledge_hub.config.settings import Settings
from knowledge_hub.rag.graph import GraphService, parse_extraction_json
from knowledge_hub.rag.graph_store import GraphStoreError, Neo4jGraphStore
from knowledge_hub.rag.retriever import Retriever
from knowledge_hub.rag.store import Hit
from knowledge_hub.security.tickets import RetrievalTicket


class _Record:
    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def data(self) -> dict[str, Any]:
        return self._data


class _Result:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows

    def __iter__(self):
        return iter([_Record(row) for row in self._rows])

    def consume(self) -> None:
        return None


class FakeSession:
    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.rows = rows or []
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def run(self, statement: str, **params: Any) -> _Result:
        self.calls.append((statement, params))
        return _Result(self.rows)

    def __enter__(self) -> FakeSession:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


class FakeEmbedder:
    async def embed_query(self, text: str) -> list[float]:
        return [0.2] * 8

    async def embed_texts(self, texts: Sequence[str]) -> list[list[float]]:
        return [[0.3] * 8 for _ in texts]


class FakeLLM:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        self.calls = 0

    async def chat_json(self, messages: Sequence[Any], **kwargs: Any) -> dict[str, Any]:
        self.calls += 1
        return self.payload


class FakeGraph:
    enabled = True

    def __init__(self, hits: list[Hit]) -> None:
        self.hits = hits
        self.calls: list[dict[str, Any]] = []

    async def search(self, **kwargs: Any) -> list[Hit]:
        self.calls.append(kwargs)
        return list(self.hits)


class FakeDenseStore:
    def __init__(self, dense: list[Hit], sparse: list[Hit]) -> None:
        self.dense = dense
        self.sparse = sparse

    def existing_collections(self, names: Sequence[str]) -> dict[str, bool]:
        return {name: True for name in names}

    def search_dense(self, collection, vector, filter_expr, *, limit, dim):  # noqa: ANN001
        return list(self.dense)

    def search_sparse(self, collection, query, filter_expr, *, limit, dim):  # noqa: ANN001
        return list(self.sparse)

    def supports_sparse(self, collection: str) -> bool:
        return True


def _ticket() -> RetrievalTicket:
    return RetrievalTicket(
        tenant_id="t_001",
        user_id="u_1",
        principals=("user:u_1",),
        kb_ids=("kb_001",),
    )


def _hit(pk: str, *, text: str = "制度正文", source: str = "dense") -> Hit:
    return Hit(
        pk=pk,
        text=text,
        score=0.5,
        doc_id=f"doc-{pk}",
        kb_id="kb_001",
        tenant_id="t_001",
        version_id="v1",
        title_path=["制度"],
        visibility="public",
        status="active",
        source=source,
    )


def _graph_settings(settings: Settings) -> Settings:
    settings.retrieval.graph.enabled = True
    settings.retrieval.dense.enabled = True
    settings.retrieval.sparse.enabled = True
    return settings


# ---------------------------------------------------------------------- store
def test_graph_search_filters_tenant_kb_and_acl(settings: Settings) -> None:
    session = FakeSession(rows=[])
    store = Neo4jGraphStore(settings, session_factory=lambda: session)

    store.search(
        [0.1] * 8,
        tenant_id="t_001",
        kb_ids=["kb_001"],
        principals=["user:u_1"],
        hops=2,
        limit=5,
    )

    statement, params = session.calls[0]
    assert "seed.tenant_id = $tenant_id" in statement
    assert "seed.kb_id IN $kb_ids" in statement
    assert "c.status = 'active'" in statement
    assert "c.visibility = 'public'" in statement
    assert "principal IN c.acl_principals" in statement
    assert "*1..2" in statement
    assert params["tenant_id"] == "t_001"
    assert params["kb_ids"] == ["kb_001"]
    assert params["principals"] == ["user:u_1"]


def test_graph_search_clamps_hops(settings: Settings) -> None:
    session = FakeSession()
    store = Neo4jGraphStore(settings, session_factory=lambda: session)
    store.search([0.1], tenant_id="t", kb_ids=["kb"], principals=["p"], hops=99, limit=5)
    assert "*1..3" in session.calls[0][0]


def test_graph_search_requires_principals(settings: Settings) -> None:
    session = FakeSession()
    store = Neo4jGraphStore(settings, session_factory=lambda: session)
    assert store.search([0.1], tenant_id="t", kb_ids=["kb"], principals=[], limit=5) == []
    assert session.calls == []


def test_graph_search_maps_rows_to_hits(settings: Settings) -> None:
    session = FakeSession(
        rows=[
            {
                "chunk_id": "c1",
                "doc_id": "doc1",
                "kb_id": "kb_001",
                "tenant_id": "t_001",
                "text": "差旅标准见附表",
                "title_path": ["差旅", "标准"],
                "block_type": "paragraph",
                "doc_title": "差旅制度",
                "source_url": "",
                "version_id": "v1",
                "acl_principals": ["user:u_1"],
                "visibility": "private",
                "status": "active",
                "score": 0.91,
                "support": 2,
            }
        ]
    )
    store = Neo4jGraphStore(settings, session_factory=lambda: session)
    hits = store.search(
        [0.1], tenant_id="t_001", kb_ids=["kb_001"], principals=["user:u_1"], limit=5
    )

    assert len(hits) == 1
    assert hits[0].pk == "c1"
    assert hits[0].source == "graph"
    assert hits[0].title_path == ["差旅", "标准"]
    assert hits[0].acl_principals == ["user:u_1"]


def test_graph_store_without_credentials_is_not_configured(env_settings, app_config) -> None:
    env = env_settings.replace(neo4j__uri="")
    settings = Settings(env, app_config, nacos_ok=True, source="test")
    store = Neo4jGraphStore(settings)
    assert store.configured is False
    assert store.health() is False


# -------------------------------------------------------------------- service
@pytest.mark.asyncio
async def test_build_writes_extracted_entities_with_acl(
    settings: Settings, env_settings, app_config
) -> None:
    session = FakeSession()
    store = Neo4jGraphStore(settings, session_factory=lambda: session)
    llm = FakeLLM(
        {
            "entities": [{"name": "差旅标准", "type": "制度", "description": "差旅报销标准"}],
            "relations": [
                {"source": "差旅标准", "target": "未知实体", "type": "PART_OF", "description": ""}
            ],
        }
    )
    graph = GraphService(_graph_settings(settings), store=store, llm=llm, embedder=FakeEmbedder())

    rows = [
        {
            "pk": "c1",
            "doc_id": "doc1",
            "kb_id": "kb_001",
            "tenant_id": "t_001",
            "text": "差旅标准为每日 500 元。",
            "title_path": ["差旅"],
            "acl_principals": ["user:u_1"],
            "visibility": "private",
            "status": "active",
        }
    ]
    result = await graph.build(
        kb_id="kb_001",
        document_ids=["doc1"],
        mode="incremental",
        tenant_id="t_001",
        documents=[{"doc_id": "doc1", "chunks": rows}],
    )

    assert result["status"] == "ok"
    assert result["chunk_count"] == 1
    # Relations pointing at entities that were not extracted are dropped.
    entity_write = [call for call in session.calls if "MERGE (e:Entity" in call[0]]
    assert entity_write and entity_write[0][1]["entities"][0]["name"] == "差旅标准"
    assert entity_write[0][1]["entities"][0]["embedding"] == [0.3] * 8
    relation_write = [call for call in session.calls if "MERGE (a)-[r:RELATED" in call[0]]
    assert relation_write[0][1]["relations"] == []
    chunk_write = [call for call in session.calls if "MERGE (c:Chunk" in call[0]]
    assert chunk_write[0][1]["chunks"][0]["acl_principals"] == ["user:u_1"]
    assert chunk_write[0][1]["chunks"][0]["entities"] == ["差旅标准"]


@pytest.mark.asyncio
async def test_build_without_payload_is_honest(settings: Settings) -> None:
    store = Neo4jGraphStore(settings, session_factory=FakeSession)
    graph = GraphService(_graph_settings(settings), store=store, llm=FakeLLM({}), embedder=FakeEmbedder())

    result = await graph.build(kb_id="kb_001", document_ids=["doc1"], mode="full")

    assert result["accepted"] is False
    assert result["reason"] == "documents_payload_required"


@pytest.mark.asyncio
async def test_build_rejected_when_graph_disabled(settings: Settings) -> None:
    settings.retrieval.graph.enabled = False
    store = Neo4jGraphStore(settings, session_factory=FakeSession)
    graph = GraphService(settings, store=store, llm=FakeLLM({}), embedder=FakeEmbedder())

    result = await graph.build(kb_id="kb_001", document_ids=["doc1"], mode="full")

    assert result["reason"] == "graph_disabled_by_config"


@pytest.mark.asyncio
async def test_query_degrades_when_disabled(settings: Settings) -> None:
    settings.retrieval.graph.enabled = False
    store = Neo4jGraphStore(settings, session_factory=FakeSession)
    graph = GraphService(settings, store=store, llm=FakeLLM({}), embedder=FakeEmbedder())

    result = await graph.query(
        ticket=_ticket(), kb_ids=["kb_001"], query="差旅标准", hops=2, include_communities=True
    )

    assert result.degraded is True
    assert result.reason == "graph_disabled_by_config"


@pytest.mark.asyncio
async def test_graph_search_error_does_not_break_retrieval(settings: Settings) -> None:
    class BoomStore(Neo4jGraphStore):
        def search(self, *args: Any, **kwargs: Any) -> list[Hit]:
            raise GraphStoreError("neo4j down")

    graph = GraphService(
        _graph_settings(settings),
        store=BoomStore(settings, session_factory=FakeSession),
        llm=FakeLLM({}),
        embedder=FakeEmbedder(),
    )

    assert (
        await graph.search(
            query="差旅", tenant_id="t_001", kb_ids=["kb_001"], principals=["user:u_1"], hops=2
        )
        == []
    )


# ------------------------------------------------------------------- fusion
@pytest.mark.asyncio
async def test_retriever_fuses_graph_hits_with_dense_and_sparse(settings: Settings) -> None:
    settings = _graph_settings(settings)
    store = FakeDenseStore(dense=[_hit("dense-1")], sparse=[_hit("sparse-1")])
    graph = FakeGraph([_hit("graph-1", text="图谱召回的差旅条款", source="graph")])
    retriever = Retriever(
        settings, store=store, embedder=FakeEmbedder(), graph=graph  # type: ignore[arg-type]
    )

    result = await retriever.retrieve(ticket=_ticket(), kb_ids=["kb_001"], query="差旅标准")

    ids = [chunk.chunk_id for chunk in result.chunks]
    assert "graph-1" in ids
    assert result.debug["graph_hits"] == 1
    assert graph.calls[0]["tenant_id"] == "t_001"
    assert graph.calls[0]["kb_ids"] == ("kb_001",)
    assert graph.calls[0]["principals"] == ("user:u_1",)


@pytest.mark.asyncio
async def test_retriever_survives_graph_returning_nothing(settings: Settings) -> None:
    settings = _graph_settings(settings)
    store = FakeDenseStore(dense=[_hit("dense-1")], sparse=[])
    retriever = Retriever(
        settings, store=store, embedder=FakeEmbedder(), graph=FakeGraph([])  # type: ignore[arg-type]
    )

    result = await retriever.retrieve(ticket=_ticket(), kb_ids=["kb_001"], query="差旅标准")

    assert [chunk.chunk_id for chunk in result.chunks] == ["dense-1"]


# --------------------------------------------------------------------- helper
def test_parse_extraction_json_tolerates_fences() -> None:
    assert parse_extraction_json('```json\n{"entities": []}\n```') == {"entities": []}
    assert parse_extraction_json("not json") == {}

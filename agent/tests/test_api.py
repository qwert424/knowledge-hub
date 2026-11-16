"""HTTP contract: /health, /v1/retrieve, /v1/index/jobs, /v1/chat/stream, graph, reload."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import pytest
from fastapi.testclient import TestClient

from knowledge_hub.api.container import Container
from knowledge_hub.api.main import create_app
from knowledge_hub.config.settings import Settings
from knowledge_hub.rag.retriever import RetrievedChunk, RetrieveResult
from tests.conftest import make_ticket


@dataclass
class FakeRetriever:
    result: RetrieveResult
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def retrieve(self, **kwargs: Any) -> RetrieveResult:
        self.calls.append(kwargs)
        return self.result


@dataclass
class FakeChat:
    events: list[tuple[str, dict[str, Any]]]

    async def stream(self, request: Any, *, ticket: Any) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        for event in self.events:
            yield event


@pytest.fixture
def client(settings: Settings, monkeypatch: pytest.MonkeyPatch):
    container = Container(settings)

    async def offline() -> bool:
        return False

    async def online() -> bool:
        return True

    container.probe_milvus = offline  # type: ignore[method-assign]
    container.probe_nacos = offline  # type: ignore[method-assign]
    container.probe_redis = online  # type: ignore[method-assign]
    container.retriever = FakeRetriever(  # type: ignore[assignment]
        RetrieveResult(
            chunks=[
                RetrievedChunk(
                    chunk_id="c1",
                    doc_id="d1",
                    title="制度",
                    title_path=["制度"],
                    text="报销需要发票。",
                    score=0.8,
                    source_url="kh://kb/d1",
                )
            ],
            debug={"dense_ms": 3, "sparse_ms": 2, "rerank_ms": 0, "filtered": 0},
        )
    )
    container.chat = FakeChat(  # type: ignore[assignment]
        [
            ("status", {"stage": "retrieve"}),
            ("token", {"delta": "答"}),
            ("done", {"usage": {"model": "gpt-x", "input_tokens": 1, "output_tokens": 1}}),
        ]
    )
    container.reload = lambda: settings  # type: ignore[method-assign,assignment]

    app = create_app(container=container)
    with TestClient(app) as test_client:
        yield test_client


def test_health_degraded_reports_json(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["milvus"] is False
    assert body["nacos"] is False
    assert body["redis"] is True
    assert "version" in body and "errors" in body


def test_health_ok_when_dependencies_are_up(client: TestClient) -> None:
    container = client.app.state.container

    async def online() -> bool:
        return True

    container.probe_milvus = online
    container.probe_nacos = online
    body = client.get("/health").json()
    assert body["status"] == "ok"


def test_retrieve_requires_valid_ticket(client: TestClient) -> None:
    response = client.post(
        "/v1/retrieve", json={"ticket": "not-a-jwt", "kb_ids": ["kb_001"], "query": "报销"}
    )
    assert response.status_code == 401
    assert response.json()["code"] == "AUTH_401"


def test_retrieve_rejects_tenant_mismatch(client: TestClient, settings: Settings) -> None:
    response = client.post(
        "/v1/retrieve",
        json={
            "ticket": make_ticket(settings.env),
            "tenant_id": "t_999",
            "kb_ids": ["kb_001"],
            "query": "报销",
        },
    )
    assert response.status_code == 403
    assert response.json()["code"] == "TENANT_MISMATCH"


def test_retrieve_returns_contract_with_jev_debug(client: TestClient, settings: Settings) -> None:
    response = client.post(
        "/v1/retrieve",
        json={
            "ticket": make_ticket(settings.env),
            "kb_ids": ["kb_001"],
            "query": "报销流程",
            "top_k": 8,
            "debug": True,
            "kb_collections": {"kb_001": "kh_demo_1024"},
            "filters": {"doc_ids": ["injected"]},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["chunks"][0]["chunk_id"] == "c1"
    assert body["debug"]["jev"]["choice"] in {"retrieve", "direct"}
    assert body["debug"]["dense_ms"] == 3
    retriever = client.app.state.container.retriever
    assert retriever.calls[0]["kb_ids"] == ["kb_001"]
    assert retriever.calls[0]["kb_collections"] == {"kb_001": "kh_demo_1024"}


def test_retrieve_all_collections_missing_reports_no_kb(client: TestClient, settings: Settings) -> None:
    container = client.app.state.container
    container.retriever = FakeRetriever(  # type: ignore[assignment]
        RetrieveResult(
            chunks=[],
            debug={
                "dense_ms": 0,
                "sparse_ms": 0,
                "rerank_ms": 0,
                "filtered": 0,
                "skipped_kbs": [
                    {"kb_id": "kb_001", "collection": "kh_demo_1024", "reason": "collection_missing"}
                ],
                "all_collections_missing": True,
                "reason": "no_kb_collection",
            },
        )
    )
    response = client.post(
        "/v1/retrieve",
        json={
            "ticket": make_ticket(settings.env),
            "kb_ids": ["kb_001"],
            "query": "报销流程",
            "debug": True,
            "kb_collections": {"kb_001": "kh_demo_1024"},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["chunks"] == []
    assert body["debug"]["jev"]["choice"] == "no_kb"
    assert body["debug"]["skipped_kbs"][0]["reason"] == "collection_missing"


def test_index_job_returns_202(client: TestClient) -> None:
    response = client.post(
        "/v1/index/jobs",
        json={
            "jobId": "job-1",
            "documentId": "doc-1",
            "versionId": "v1",
            "kbId": "kb_001",
            "objectKey": "docs/a.md",
            "collectionName": "",
            "embeddingDim": 1024,
            "aclPrincipals": ["tenant:all"],
            "visibility": "public",
        },
    )
    assert response.status_code == 202
    body = response.json()
    assert body["jobId"] == "job-1"
    assert body["status"] == "accepted"
    assert body["collectionName"] == "kb_chunks_1024"


def test_index_job_requires_document_id(client: TestClient) -> None:
    response = client.post("/v1/index/jobs", json={"kbId": "kb_001"})
    assert response.status_code == 422


def test_chat_stream_sse(client: TestClient, settings: Settings) -> None:
    response = client.post(
        "/v1/chat/stream",
        json={
            "tenant_id": "t_001",
            "query": "报销",
            "kb_ids": ["kb_001"],
            "ticket": make_ticket(settings.env),
            "conversation_id": "conv-1",
            "trace_id": "trace-1",
        },
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    text = response.text
    assert "event: status" in text
    assert "event: token" in text
    assert text.rstrip().endswith('data: {"usage":{"model":"gpt-x","input_tokens":1,"output_tokens":1}}')


def test_chat_stream_bad_ticket(client: TestClient) -> None:
    response = client.post("/v1/chat/stream", json={"ticket": "", "query": "x"})
    assert response.status_code == 401


def test_graph_query_returns_stub_contract(client: TestClient, settings: Settings) -> None:
    response = client.post(
        "/v1/graph/query",
        json={"ticket": make_ticket(settings.env), "kb_ids": ["kb_001"], "query": "谁负责", "hops": 2},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["entities"] == [] and body["relations"] == []
    assert body["degraded"] is True
    assert body["reason"]


def test_graph_build_returns_202(client: TestClient) -> None:
    response = client.post(
        "/v1/graph/build", json={"kb_id": "kb_001", "document_ids": ["d1"], "mode": "full"}
    )
    assert response.status_code == 202
    assert response.json()["degraded"] is True


def test_admin_reload(client: TestClient) -> None:
    response = client.post("/v1/admin/reload")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "config" in body
    assert "litellm_api_key" not in json.dumps(body)


def test_error_body_contains_code_and_request_id(client: TestClient) -> None:
    response = client.post(
        "/v1/retrieve",
        json={"ticket": "bad", "query": "q"},
        headers={"X-Request-Id": "req-123"},
    )
    body = response.json()
    assert body["code"] == "AUTH_401"
    assert body["request_id"] == "req-123"

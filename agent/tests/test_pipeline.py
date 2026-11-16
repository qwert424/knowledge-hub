"""Index pipeline row metadata: no synthetic URLs, document title seeds title_path."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from knowledge_hub.config.settings import Settings
from knowledge_hub.rag.loader import LoadedDocument
from knowledge_hub.rag.pipeline import IndexJobPayload, IndexPipeline

MARKDOWN = "# 报销制度\n\n## 一、差旅\n\n差旅报销需要提供发票与行程单。\n\n## 二、住宿\n\n住宿标准为每晚五百元。\n"


class FakeLoader:
    def __init__(self, data: bytes, filename: str = "policy.md") -> None:
        self.data = data
        self.filename = filename

    def load(
        self,
        *,
        object_key: str = "",
        local_path: str = "",
        filename: str = "",
        job_id: str = "",
    ) -> LoadedDocument:
        return LoadedDocument(filename=self.filename, data=self.data, origin="local")


class FakeLLM:
    async def embed(self, inputs: list[str], **kwargs: Any) -> list[list[float]]:
        return [[0.1] * 8 for _ in inputs]


class FakeStore:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.collection = ""
        self.purged: list[tuple[str, str]] = []

    def ensure_collection(self, name: str, dim: int) -> bool:
        self.collection = name
        return True

    def delete_doc_version(self, name: str, doc_id: str, version_id: str, *, dim: int) -> None:
        return None

    def delete_other_versions(self, name: str, doc_id: str, keep_version_id: str, *, dim: int) -> None:
        self.purged.append((doc_id, keep_version_id))
        return None

    def insert(self, name: str, rows: list[dict[str, Any]], *, dim: int) -> list[str]:
        self.rows = list(rows)
        return [row["pk"] for row in rows]


def _pipeline(settings: Settings, store: FakeStore, data: bytes) -> IndexPipeline:
    return IndexPipeline(
        settings,
        store=store,  # type: ignore[arg-type]
        loader=FakeLoader(data),  # type: ignore[arg-type]
        llm=FakeLLM(),  # type: ignore[arg-type]
    )


def _payload(**overrides: Any) -> IndexJobPayload:
    base = {
        "jobId": "job-1",
        "documentId": "doc-1",
        "versionId": "v1",
        "kbId": "kb_001",
        "collectionName": "kh_demo_8",
        "embeddingDim": 8,
        "aclPrincipals": ["tenant:all"],
        "visibility": "public",
    }
    base.update(overrides)
    return IndexJobPayload.model_validate(base)


async def test_rows_never_fabricate_kh_urls(settings: Settings) -> None:
    store = FakeStore()
    outcome = await _pipeline(settings, store, MARKDOWN.encode("utf-8")).run(_payload())
    assert outcome.chunk_count == len(store.rows) >= 1
    for row in store.rows:
        assert row["source_url"] == ""
        assert not row["source_url"].startswith("kh://")
        assert row["title_path"], "document title must seed title_path for citation resolution"
        assert row["title_path"][0] == "报销制度"


async def test_rows_keep_real_source_url(settings: Settings) -> None:
    store = FakeStore()
    await _pipeline(settings, store, MARKDOWN.encode("utf-8")).run(
        _payload(sourceUrl="https://wiki.example.com/policy/1")
    )
    assert all(
        row["source_url"] == "https://wiki.example.com/policy/1" for row in store.rows
    )


async def test_document_without_headings_still_gets_title_path(settings: Settings) -> None:
    store = FakeStore()
    await _pipeline(settings, store, "纯文本内容，没有任何标题。".encode()).run(
        _payload(title="手工标题")
    )
    assert store.rows[0]["title_path"] == ["手工标题"]
    assert store.rows[0]["source_url"] == ""


async def test_rows_carry_acl_and_tenant(settings: Settings) -> None:
    store = FakeStore()
    await _pipeline(settings, store, MARKDOWN.encode("utf-8")).run(
        _payload(tenantId="t_777", aclPrincipals=["user:u_1", "tenant:all"])
    )
    for row in store.rows:
        assert row["tenant_id"] == "t_777"
        assert row["acl_principals"] == ["user:u_1", "tenant:all"]
        assert row["status"] == "active"
        assert row["visibility"] == "public"


def test_payload_requires_document_id() -> None:
    with pytest.raises(ValidationError):
        IndexJobPayload.model_validate({"kbId": "kb_001"})

async def test_reindex_purges_previous_versions(settings: Settings) -> None:
    """重索引会生成新版本：旧版本的行必须一起删掉。
    检索侧不按版本过滤，留着旧行 = 同一段内容被命中两次、旧版本永远引用得到。"""
    store = FakeStore()
    await _pipeline(settings, store, MARKDOWN.encode("utf-8")).run(_payload())
    assert store.purged == [("doc-1", "v1")]


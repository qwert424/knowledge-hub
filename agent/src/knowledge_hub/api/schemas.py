"""HTTP request/response schemas (docs/12 §3)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class RetrieveRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    ticket: str = ""
    kb_ids: list[str] = Field(default_factory=list)
    query: str = ""
    profile: dict[str, Any] = Field(default_factory=dict)
    top_k: int | None = None
    debug: bool = False
    trace_id: str = ""
    tenant_id: str = ""
    # Per-kb target collection, e.g. {"<kb_id>": "kh_demo_1024"} as issued by Java.
    kb_collections: dict[str, str] = Field(default_factory=dict)
    # Accepted for forward-compatibility with docs/03 §6.3 but intentionally unused:
    # ACL/row filters are derived from the ticket only.
    filters: dict[str, Any] | None = None

    @field_validator("top_k")
    @classmethod
    def _check_top_k(cls, value: int | None) -> int | None:
        if value is None:
            return None
        return max(1, min(value, 100))


class ChatStreamRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    tenant_id: str = ""
    conversation_id: str = ""
    user_message_id: str = ""
    assistant_message_id: str = ""
    query: str = ""
    kb_ids: list[str] = Field(default_factory=list)
    ticket: str = ""
    profile: dict[str, Any] = Field(default_factory=dict)
    kb_collections: dict[str, str] = Field(default_factory=dict)
    history: list[dict[str, Any]] = Field(default_factory=list)
    trace_id: str = ""
    model: str = ""
    #: 断点续传：resume=true 时把 resume_prefix（已产出的半截回答）接着写完。
    resume: bool = False
    resume_prefix: str = ""
    #: 可访问知识库的名称/简介，供路由决策判断"库里有没有这类资料"。
    available_kbs: list[dict[str, Any]] = Field(default_factory=list)


class GraphQueryRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    ticket: str = ""
    kb_ids: list[str] = Field(default_factory=list)
    query: str = ""
    hops: int = 2
    include_communities: bool = True
    tenant_id: str = ""


class GraphBuildRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    kb_id: str = ""
    document_ids: list[str] = Field(default_factory=list)
    mode: str = "incremental"
    tenant_id: str = ""
    # Chunk rows as written to Milvus, so ACL/tenant columns match between stores.
    documents: list[dict[str, Any]] = Field(default_factory=list)
    # 管理端「构建图谱」只给 kb + 文档 id：引擎自己回 Milvus 把切片捞出来。
    collection_name: str = ""

    @field_validator("mode")
    @classmethod
    def _check_mode(cls, value: str) -> str:
        return value if value in {"full", "incremental"} else "incremental"


class IndexJobResponse(BaseModel):
    jobId: str
    status: str = "accepted"
    collectionName: str = ""
    documentId: str = ""


class ReloadResponse(BaseModel):
    status: str
    source: str
    nacos_ok: bool
    errors: list[str] = Field(default_factory=list)


__all__ = [
    "ChatStreamRequest",
    "GraphBuildRequest",
    "GraphQueryRequest",
    "IndexJobResponse",
    "ReloadResponse",
    "RetrieveRequest",
]

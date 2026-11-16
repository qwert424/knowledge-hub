"""FastAPI application exposing the docs/12 §3 engine contract.

Routes: ``/health``, ``/v1/retrieve``, ``/v1/index/jobs``, ``/v1/chat/stream``,
``/v1/graph/query``, ``/v1/graph/build``, ``/v1/admin/reload``.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from knowledge_hub import __version__
from knowledge_hub.api.container import Container, build_container
from knowledge_hub.api.schemas import (
    ChatStreamRequest,
    GraphBuildRequest,
    GraphQueryRequest,
    RetrieveRequest,
)
from knowledge_hub.api.sse import SSE_HEADERS, SSE_MEDIA_TYPE, encode_sse
from knowledge_hub.config.settings import Settings, load_settings
from knowledge_hub.decision.jev import JevOption
from knowledge_hub.engine.chat import ChatRequest
from knowledge_hub.errors import KhError
from knowledge_hub.rag.pipeline import IndexJobPayload
from knowledge_hub.rag.retriever import default_collection_name
from knowledge_hub.runtime.agent import AgentRequest
from knowledge_hub.tools.logging import configure_logging

logger = logging.getLogger(__name__)

CONTRACT_VERSION = "12"


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    if getattr(app.state, "container", None) is None:
        settings = load_settings()
        app.state.container = build_container(settings)
        logger.info(
            "rag engine started (port=%s, source=%s, chat_model=%s)",
            settings.env.server.rag_engine_port,
            settings.source,
            settings.llm.chat_model,
        )
    try:
        yield
    finally:
        container: Container | None = getattr(app.state, "container", None)
        if container is not None:
            await container.aclose()


def create_app(
    *,
    settings: Settings | None = None,
    container: Container | None = None,
) -> FastAPI:
    app = FastAPI(
        title="Knowledge Hub RAG Engine",
        version=__version__,
        description="Retrieval / indexing / grounded chat / graph facade (docs/12 §3)",
        lifespan=_lifespan,
    )
    app.state.container = container or (Container(settings) if settings is not None else None)
    app.state.tasks = set()

    @app.exception_handler(KhError)
    async def _kh_error_handler(request: Request, exc: KhError) -> JSONResponse:
        logger.info("request %s failed: %s (%s)", _request_id(request), exc.code, exc.message)
        return JSONResponse(status_code=exc.http_status, content=exc.to_body(_request_id(request)))

    # ------------------------------------------------------------------ ops
    @app.get("/health")
    async def health(request: Request) -> dict[str, Any]:
        container_ = _container(request)
        body = await container_.health()
        body["contract"] = CONTRACT_VERSION
        return body

    @app.post("/v1/admin/reload")
    async def admin_reload(request: Request) -> dict[str, Any]:
        container_ = _container(request)
        settings_ = container_.reload()
        return {
            "status": "ok",
            "source": settings_.source,
            "nacos_ok": settings_.nacos_ok,
            "errors": list(settings_.errors),
            "config": settings_.public(),
        }

    # -------------------------------------------------------------- retrieval
    @app.post("/v1/retrieve")
    async def retrieve(payload: RetrieveRequest, request: Request) -> dict[str, Any]:
        container_ = _container(request)
        # 请求里的 filters 只允许收窄（标签过滤）；ACL 永远来自签名 ticket。
        requested_tags = _requested_tags(payload.filters)
        ticket = container_.verifier.verify(
            payload.ticket, expected_tenant=payload.tenant_id or None
        )
        result = await container_.retriever.retrieve(
            ticket=ticket,
            kb_ids=payload.kb_ids,
            query=payload.query,
            profile=payload.profile,
            top_k=payload.top_k,
            include_debug=payload.debug,
            kb_collections=payload.kb_collections,
            tags=requested_tags,
        )
        body = result.to_contract()
        debug = body.setdefault("debug", {})
        if requested_tags:
            debug["tags"] = list(requested_tags)
        decision = await container_.jev.decide(
            "router",
            {
                "kb_ids": list(ticket.effective_kb_ids(payload.kb_ids or None)),
                "query_length": len(payload.query.strip()),
                "chunk_count": len(result.chunks),
                "empty_retrieval": not result.chunks,
                "no_kb_collections": bool(debug.get("all_collections_missing")),
                "skipped_kbs": debug.get("skipped_kbs") or [],
            },
            [
                JevOption("retrieve", "检索命中了可用切片"),
                JevOption("direct", "无需检索或没有可用证据"),
                JevOption("no_kb", "所有授权知识库的向量集合都不存在"),
            ],
            {"fallback": "retrieve", "allow_model": False},
        )
        debug["jev"] = decision.to_dict()
        debug["request_id"] = _request_id(request)
        if not payload.debug:
            debug.pop("kb_ids", None)
        return body

    # --------------------------------------------------------------- indexing
    @app.post("/v1/index/jobs", status_code=202)
    async def submit_index_job(payload: IndexJobPayload, request: Request) -> JSONResponse:
        container_ = _container(request)
        dim = int(payload.embedding_dim or container_.settings.embedding.dimensions)
        collection = payload.collection_name or default_collection_name(dim)
        expected = default_collection_name(dim)
        if payload.collection_name and payload.collection_name != expected:
            logger.warning(
                "index job %s writes to %s while retrieval reads %s; set profile.collectionName "
                "on retrieval to keep them aligned",
                payload.job_id or payload.document_id,
                payload.collection_name,
                expected,
            )
        task = asyncio.create_task(
            _run_index_job(container_, payload), name=f"index-job:{payload.document_id}"
        )
        tasks: set[asyncio.Task[Any]] = request.app.state.tasks
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        return JSONResponse(
            status_code=202,
            content={
                "jobId": payload.job_id or payload.document_id,
                "status": "accepted",
                "collectionName": collection,
                "documentId": payload.document_id,
            },
        )

    # ------------------------------------------------------------------- chat
    @app.post("/v1/chat/stream")
    async def chat_stream(payload: ChatStreamRequest, request: Request) -> Response:
        container_ = _container(request)
        ticket = container_.verifier.verify(
            payload.ticket, expected_tenant=payload.tenant_id or None
        )
        chat_request = ChatRequest.from_payload(payload.model_dump())

        async def event_source() -> AsyncIterator[bytes]:
            async for event, data in container_.chat.stream(chat_request, ticket=ticket):
                yield encode_sse(event, data).encode("utf-8")

        return StreamingResponse(
            event_source(), media_type=SSE_MEDIA_TYPE, headers=dict(SSE_HEADERS)
        )

    @app.post("/v1/answer")
    async def answer(payload: ChatStreamRequest, request: Request) -> dict[str, Any]:
        """非流式回答。评测/回归需要「拿到整段答复再和期望答案比」，SSE 不适合。

        内部复用 ``/v1/chat/stream`` 的同一条链路（同样的路由、检索、引用），
        只是把 token 事件拼成一个字符串返回。
        """
        container_ = _container(request)
        ticket = container_.verifier.verify(
            payload.ticket, expected_tenant=payload.tenant_id or None
        )
        chat_request = ChatRequest.from_payload(payload.model_dump())
        parts: list[str] = []
        citations: list[dict[str, Any]] = []
        usage: dict[str, Any] = {}
        error: dict[str, Any] | None = None
        async for event, data in container_.chat.stream(chat_request, ticket=ticket):
            if event == "token":
                parts.append(str((data or {}).get("delta") or ""))
            elif event == "citation":
                citations.append(dict(data or {}))
            elif event == "done":
                usage = dict((data or {}).get("usage") or {})
            elif event == "error":
                error = dict(data or {})
        text = "".join(parts)
        return {
            "answer": text,
            "citations": citations,
            "usage": usage,
            "error": error,
            "request_id": _request_id(request),
        }

    # ------------------------------------------------------------- agent (tools)
    @app.post("/v1/agent/chat")
    async def agent_chat(payload: ChatStreamRequest, request: Request) -> Response:
        """Tool-using agent loop driven by the Nacos AgentSpec (tools/subagents/sandbox).

        ``/v1/chat/stream`` stays the deterministic grounded-RAG path; this route
        is the ``main_agent`` style agent (sandbox, skills, ``task`` delegation).
        """
        container_ = _container(request)
        ticket = container_.verifier.verify(
            payload.ticket, expected_tenant=payload.tenant_id or None
        )
        agent_request = AgentRequest(
            query=payload.query,
            history=list(payload.history or []),
            ticket=ticket,
            kb_ids=list(payload.kb_ids or []),
            kb_collections=dict(payload.kb_collections or {}),
            session_key=payload.conversation_id or payload.user_message_id,
            conversation_id=payload.conversation_id,
            tenant_id=payload.tenant_id,
        )

        async def event_source() -> AsyncIterator[bytes]:
            async for event, data in container_.agent.stream(agent_request):
                yield encode_sse(event, data).encode("utf-8")

        return StreamingResponse(
            event_source(), media_type=SSE_MEDIA_TYPE, headers=dict(SSE_HEADERS)
        )

    # ------------------------------------------------------------------ graph
    @app.post("/v1/graph/query")
    async def graph_query(payload: GraphQueryRequest, request: Request) -> dict[str, Any]:
        container_ = _container(request)
        ticket = container_.verifier.verify(
            payload.ticket, expected_tenant=payload.tenant_id or None
        )
        result = await container_.graph.query(
            ticket=ticket,
            kb_ids=payload.kb_ids,
            query=payload.query,
            hops=payload.hops,
            include_communities=payload.include_communities,
        )
        return result.to_contract()

    @app.post("/v1/graph/build", status_code=202)
    async def graph_build(payload: GraphBuildRequest, request: Request) -> JSONResponse:
        container_ = _container(request)
        documents = payload.documents or None
        if not documents:
            # 管理端只给 kb + 文档 id：切片正文在 Milvus 里，回读一次再抽。
            # 之前这里没兜底，引擎直接回 not_implemented，界面上就成了"点成功但没效果"。
            documents = await _load_documents_from_milvus(container_, payload)
        result = await container_.graph.build(
            kb_id=payload.kb_id,
            document_ids=payload.document_ids,
            mode=payload.mode,
            tenant_id=payload.tenant_id,
            documents=documents,
        )
        return JSONResponse(status_code=202, content=result)

    return app


async def _load_documents_from_milvus(
    container: Container, payload: GraphBuildRequest
) -> list[dict[str, Any]]:
    """按文档 id 从 Milvus 读回切片，形状与索引流水线写进去的一致。"""
    if not payload.document_ids:
        return []
    dim = int(container.settings.embedding.dimensions or 0)
    collection = payload.collection_name or default_collection_name(dim)
    quoted = ", ".join(
        f'"{doc_id}"' for doc_id in payload.document_ids if doc_id and '"' not in doc_id
    )
    if not quoted:
        return []
    expr = f"doc_id in [{quoted}]"
    documents: list[dict[str, Any]] = []
    try:
        rows = await asyncio.to_thread(
            container.store.query_all, collection, expr, dim=dim
        )
    except KhError as exc:
        logger.warning("graph build: cannot load chunks from %s: %s", collection, exc.code)
        return []
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(str(row.get("doc_id") or ""), []).append(dict(row))
    for doc_id, chunks in grouped.items():
        if doc_id:
            documents.append({"doc_id": doc_id, "chunks": chunks})
    return documents


async def _run_index_job(container: Container, payload: IndexJobPayload) -> None:
    try:
        outcome = await container.pipeline.run(payload)
        logger.info("index job finished: %s", outcome.to_dict())
    except KhError as exc:
        logger.warning("index job %s failed: %s", payload.document_id, exc.code)
    except Exception:  # pragma: no cover - background task safety net
        logger.exception("index job %s crashed", payload.document_id)


def _requested_tags(filters: dict[str, Any] | None) -> tuple[str, ...]:
    """Only tags may come from the request; they are an extra AND clause (narrowing)."""
    if not filters:
        return ()
    raw = filters.get("tags") if isinstance(filters, dict) else None
    if not isinstance(raw, (list, tuple)):
        return ()
    return tuple(str(tag) for tag in raw if str(tag).strip())[:16]


def _container(request: Request) -> Container:
    container = getattr(request.app.state, "container", None)
    if container is None:  # pragma: no cover - lifespan always sets this
        raise RuntimeError("application container is not initialised")
    return container


def _request_id(request: Request) -> str:
    return request.headers.get("X-Request-Id") or uuid.uuid4().hex


def run() -> None:
    import uvicorn

    configure_logging()
    settings = load_settings()
    uvicorn.run(
        "knowledge_hub.api.main:app",
        host="0.0.0.0",
        port=settings.env.server.rag_engine_port,
        log_level="info",
        proxy_headers=False,
    )


app = create_app()


__all__ = ["app", "create_app", "run"]

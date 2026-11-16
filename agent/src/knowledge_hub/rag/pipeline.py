"""Indexing pipeline shared by the HTTP route and the Redis Stream worker.

Flow: load bytes -> parse to CIR -> split -> embed -> write to Milvus ->
snapshot to MinIO -> report to Java through the injected reporter. All stages are
idempotent per ``(documentId, versionId)``: the previous version's rows are
deleted before the new rows are written and chunk ids are deterministic.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from pydantic import BaseModel, Field, field_validator

from knowledge_hub.config.settings import Settings
from knowledge_hub.errors import KhError, LoaderError, ParserError
from knowledge_hub.rag.embed import Embedder
from knowledge_hub.rag.graph import GraphService
from knowledge_hub.rag.image_caption import caption_images
from knowledge_hub.rag.loader import DocumentLoader
from knowledge_hub.rag.parser import parse_document
from knowledge_hub.rag.retriever import default_collection_name
from knowledge_hub.rag.splitter import SplitResult, Splitter
from knowledge_hub.rag.store import ChunkStore
from knowledge_hub.tools.llm import LLMClient
from knowledge_hub.tools.minio import S3Client

logger = logging.getLogger(__name__)


class IndexJobPayload(BaseModel):
    """docs/12 §3.2 payload (plus the tenant from the stream envelope)."""

    model_config = {"extra": "allow", "populate_by_name": True}

    job_id: str = Field("", alias="jobId")
    document_id: str = Field(..., alias="documentId")
    version_id: str = Field("", alias="versionId")
    kb_id: str = Field("", alias="kbId")
    object_key: str = Field("", alias="objectKey")
    content_hash: str = Field("", alias="contentHash")
    title: str = ""
    collection_name: str = Field("", alias="collectionName")
    embedding_dim: int = Field(0, alias="embeddingDim")
    acl_principals: list[str] = Field(default_factory=list, alias="aclPrincipals")
    visibility: str = "private"
    tenant_id: str = Field("", alias="tenantId")
    local_path: str = Field("", alias="localPath")
    filename: str = ""
    source_url: str = Field("", alias="sourceUrl")
    tags: list[str] = Field(default_factory=list)
    # Set by Java when the knowledge base opted into GraphRAG (curated documents only).
    graph_enabled: bool = Field(False, alias="graphEnabled")
    # 飞书来源的结构坐标：检索侧靠它们回查同一文档、同一版本的块
    space_id: str = Field("", alias="spaceId")
    node_token: str = Field("", alias="nodeToken")
    revision_id: str = Field("", alias="revisionId")

    @field_validator("visibility")
    @classmethod
    def _check_visibility(cls, value: str) -> str:
        return value if value in {"public", "private"} else "private"

    @property
    def effective_tenant(self) -> str:
        return self.tenant_id or "default"


class JobReporter(Protocol):
    async def start(self, job_id: str, stage: str = "parsing") -> None: ...
    async def progress(self, job_id: str, stage: str, progress: int) -> None: ...
    async def chunks(self, job_id: str, chunks: list[dict[str, Any]]) -> None: ...
    async def complete(
        self,
        job_id: str,
        *,
        chunk_count: int,
        token_count: int,
        block_snapshot_key: str = "",
        chunk_snapshot_key: str = "",
    ) -> None: ...
    async def fail(self, job_id: str, *, error_code: str, message: str) -> None: ...


class NoopReporter:
    """Used when the engine triggers indexing locally (no Java callbacks)."""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, Any]]] = []

    async def start(self, job_id: str, stage: str = "parsing") -> None:
        self.events.append(("start", {"job_id": job_id, "stage": stage}))

    async def progress(self, job_id: str, stage: str, progress: int) -> None:
        self.events.append(("progress", {"job_id": job_id, "stage": stage, "progress": progress}))

    async def chunks(self, job_id: str, chunks: list[dict[str, Any]]) -> None:
        self.events.append(("chunks", {"job_id": job_id, "count": len(chunks)}))

    async def complete(
        self,
        job_id: str,
        *,
        chunk_count: int,
        token_count: int,
        block_snapshot_key: str = "",
        chunk_snapshot_key: str = "",
    ) -> None:
        self.events.append(
            (
                "complete",
                {
                    "job_id": job_id,
                    "chunk_count": chunk_count,
                    "token_count": token_count,
                    "block_snapshot_key": block_snapshot_key,
                    "chunk_snapshot_key": chunk_snapshot_key,
                },
            )
        )

    async def fail(self, job_id: str, *, error_code: str, message: str) -> None:
        self.events.append(("fail", {"job_id": job_id, "error_code": error_code, "message": message}))


@dataclass(slots=True)
class IndexOutcome:
    job_id: str
    document_id: str
    version_id: str
    collection: str
    chunk_count: int
    token_count: int
    dropped_count: int
    duration_ms: int
    skipped: bool = False
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "jobId": self.job_id,
            "documentId": self.document_id,
            "versionId": self.version_id,
            "collection": self.collection,
            "chunkCount": self.chunk_count,
            "tokenCount": self.token_count,
            "droppedCount": self.dropped_count,
            "durationMs": self.duration_ms,
            "skipped": self.skipped,
            "reason": self.reason,
        }


class IndexPipeline:
    def __init__(
        self,
        settings: Settings,
        *,
        store: ChunkStore | None = None,
        loader: DocumentLoader | None = None,
        llm: LLMClient | None = None,
        s3: S3Client | None = None,
        concurrency: int | None = None,
        graph: GraphService | None = None,
    ) -> None:
        self.settings = settings
        self.store = store or ChunkStore(settings.env)
        self.s3 = s3 or S3Client.from_env(settings.env)
        self.loader = loader or DocumentLoader(settings.env, s3=self.s3)
        self.llm = llm or LLMClient(settings.llm.base_url, settings.env.llm.litellm_api_key)
        self.embedder = Embedder(self.llm, settings.embedding)
        self.splitter = Splitter(settings.chunking)
        self.graph = graph
        limit = concurrency or max(1, int(settings.index.max_concurrency))
        self._semaphore = asyncio.Semaphore(limit)

    # ------------------------------------------------------------------ public
    async def run(self, payload: IndexJobPayload, reporter: JobReporter | None = None) -> IndexOutcome:
        reporter = reporter or NoopReporter()
        async with self._semaphore:
            return await self._run(payload, reporter)

    async def _run(self, payload: IndexJobPayload, reporter: JobReporter) -> IndexOutcome:
        started = time.perf_counter()
        job_id = payload.job_id or payload.document_id
        dim = int(payload.embedding_dim or self.settings.embedding.dimensions)
        collection = payload.collection_name or default_collection_name(dim)
        if dim <= 0:
            await reporter.fail(job_id, error_code="INTERNAL_ERROR", message="embedding dim missing")
            raise LoaderError("embedding dimension is unknown")

        try:
            await reporter.start(job_id, "parsing")
            loaded = await asyncio.to_thread(
                self.loader.load,
                object_key=payload.object_key,
                local_path=payload.local_path,
                filename=payload.filename or payload.title,
                job_id=job_id,
            )
            document = await asyncio.to_thread(
                parse_document, loaded.filename, loaded.data, title=payload.title
            )
            await reporter.progress(job_id, "parsing", 20)
            if not document.blocks:
                raise ParserError("document produced no text blocks")

            await self._caption_images(document, reporter, job_id, payload)

            split: SplitResult = await asyncio.to_thread(
                self.splitter.split,
                document,
                doc_key=f"{payload.document_id}:{payload.version_id}",
            )
            if not split.chunks:
                raise ParserError("document produced no usable chunks")
            await reporter.progress(job_id, "embedding", 30)

            vectors = await self.embedder.embed_texts([chunk.text for chunk in split.chunks])
            await reporter.progress(job_id, "writing", 85)

            rows = self._build_rows(payload, document, split, vectors, dim)
            await asyncio.to_thread(
                self.store.ensure_collection, collection, dim
            )
            await asyncio.to_thread(
                self.store.delete_doc_version, collection, payload.document_id, payload.version_id, dim=dim
            )
            # 重索引会生成新版本：旧版本的行必须清掉，否则检索会命中同一内容的两份
            await asyncio.to_thread(
                self.store.delete_other_versions, collection, payload.document_id, payload.version_id, dim=dim
            )
            await asyncio.to_thread(self.store.insert, collection, rows, dim=dim)
            await reporter.progress(job_id, "reporting", 95)

            await self._report_chunks(reporter, job_id, split)
            await self._build_graph(payload, rows)
            block_key, chunk_key = await asyncio.to_thread(
                self._write_snapshots, payload, document, split
            )
            await reporter.complete(
                job_id,
                chunk_count=len(split.chunks),
                token_count=split.total_tokens,
                block_snapshot_key=block_key,
                chunk_snapshot_key=chunk_key,
            )
            outcome = IndexOutcome(
                job_id=job_id,
                document_id=payload.document_id,
                version_id=payload.version_id,
                collection=collection,
                chunk_count=len(split.chunks),
                token_count=split.total_tokens,
                dropped_count=len(split.dropped),
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
            logger.info(
                "indexed job=%s doc=%s chunks=%s tokens=%s in %sms",
                job_id,
                payload.document_id,
                outcome.chunk_count,
                outcome.token_count,
                outcome.duration_ms,
            )
            return outcome
        except KhError as exc:
            logger.warning("index job %s failed: %s (%s)", job_id, exc.code, exc.message)
            await _safe_fail(reporter, job_id, exc.code, exc.message)
            raise
        except Exception as exc:
            logger.exception("index job %s failed unexpectedly", job_id)
            await _safe_fail(reporter, job_id, "INTERNAL_ERROR", type(exc).__name__)
            raise KhError("index job failed") from exc

    # ---------------------------------------------------------------- internals
    def _build_rows(
        self,
        payload: IndexJobPayload,
        document: Any,
        split: SplitResult,
        vectors: Sequence[Sequence[float]],
        dim: int,
    ) -> list[dict[str, Any]]:
        now_ms = int(time.time() * 1000)
        principals = [str(value)[:128] for value in payload.acl_principals][:64]
        # Never fabricate kh:// URIs: the Portal deep-links with doc_id + title_path.
        source_url = payload.source_url.strip()
        fallback_path = [document.title] if getattr(document, "title", "") else []
        rows: list[dict[str, Any]] = []
        document_title = (payload.title or document.title or "").strip()
        for chunk, vector in zip(split.chunks, vectors, strict=True):
            title_path = list(chunk.title_path) or fallback_path
            rows.append(
                {
                    "pk": chunk.chunk_id,
                    "tenant_id": payload.effective_tenant,
                    "kb_id": payload.kb_id or "default",
                    "doc_id": payload.document_id,
                    "version_id": payload.version_id or "",
                    "chunk_index": chunk.chunk_index,
                    "chunk_count": int(chunk.chunk_count or 1),
                    "parent_pk": chunk.parent_pk or "",
                    "block_id": chunk.block_id,
                    "block_type": chunk.block_type,
                    "block_order": int(chunk.block_order if chunk.block_order >= 0 else 0),
                    "block_parent_id": chunk.block_parent_id[:64],
                    "kind": (chunk.kind or chunk.block_type)[:16],
                    "title_path": title_path[:10],
                    "references": chunk.references or [],
                    "payload": chunk.payload or {},
                    "table_row_index": int(chunk.meta.get("table_row_index") or -1),
                    "space_id": (payload.space_id or "")[:64],
                    "node_token": (payload.node_token or "")[:128],
                    "revision_id": (payload.revision_id or "")[:64],
                    "doc_title": document_title[:512],
                    "text": chunk.text[:65535],
                    "dense": list(vector),
                    "acl_principals": principals,
                    "visibility": payload.visibility,
                    "status": "active",
                    "source_url": source_url[:1024],
                    "source_type": document.source_type[:32],
                    "lang": document.lang[:8],
                    "tags": [str(tag)[:64] for tag in payload.tags][:32],
                    "updated_at": now_ms,
                }
            )
        return rows

    async def _report_chunks(
        self, reporter: JobReporter, job_id: str, split: SplitResult, batch_size: int = 200
    ) -> None:
        batch: list[dict[str, Any]] = []
        for chunk in split.chunks:
            batch.append(
                {
                    "chunkIndex": chunk.chunk_index,
                    "blockId": chunk.block_id,
                    "blockType": chunk.block_type,
                    "kind": chunk.kind or chunk.block_type,
                    "blockParentId": chunk.block_parent_id or None,
                    "chunkCount": int(chunk.chunk_count or 1),
                    "tableRowIndex": chunk.meta.get("table_row_index"),
                    "titlePath": json.dumps(chunk.title_path, ensure_ascii=False),
                    "contentHash": chunk.chunk_id,
                    "tokenCount": chunk.token_count,
                    "qualityFlags": ",".join(chunk.quality_flags),
                    "milvusPk": chunk.chunk_id,
                }
            )
            if len(batch) >= batch_size:
                await reporter.chunks(job_id, batch)
                batch = []
        if batch:
            await reporter.chunks(job_id, batch)

    async def _caption_images(
        self, document, reporter: JobReporter, job_id: str, payload_context: Any = None
    ) -> None:
        """图片先生成图注再切片：否则仅有「[图片] 章节名」，根本检索不到。"""
        config = getattr(self.settings, "image_parser", None)
        if config is None or not getattr(config, "enabled", False):
            return
        images = [block for block in document.blocks if getattr(block, "kind", "") == "image"]
        if not images:
            return
        prompt = getattr(self.settings, "image_caption_prompt", "") or ""
        try:
            captioned = await caption_images(
                document.blocks,
                llm=self.llm,
                minio=self.settings.env.minio,
                model=config.vl_model_name,
                prompt=prompt,
                sibling_count=int(config.sibling_count),
                bucket_default=config.bucket_name,
                fallback_bucket=self.settings.env.minio.bucket,
                tenant_id=str(getattr(payload_context, "tenant_id", "") or ""),
                document_id=str(getattr(payload_context, "document_id", "") or ""),
            )
        except Exception:  # noqa: BLE001 - 图片理解失败不能让整篇文档失败
            logger.exception("image captioning failed for %s", job_id)
            return
        if captioned:
            logger.info("index job %s captioned %s/%s image(s)", job_id, captioned, len(images))
            await reporter.progress(job_id, "chunking", 25)

    async def _build_graph(
        self, payload: IndexJobPayload, rows: list[dict[str, Any]]
    ) -> None:
        """Extract the fresh chunks into Neo4j when the KB has GraphRAG enabled.

        Best effort by design: a graph failure must never fail an index job, because
        dense + sparse retrieval still serve the document correctly.
        """
        if self.graph is None or not self.graph.enabled or not rows or not payload.graph_enabled:
            return
        try:
            result = await self.graph.build(
                kb_id=payload.kb_id,
                document_ids=[payload.document_id],
                mode="incremental",
                tenant_id=payload.effective_tenant,
                documents=[{"doc_id": payload.document_id, "chunks": rows}],
            )
        except Exception as exc:  # never fail the job for graph extraction
            logger.warning(
                "graph extraction skipped for doc=%s (%s)", payload.document_id, type(exc).__name__
            )
            return
        if result.get("degraded"):
            logger.info(
                "graph extraction degraded for doc=%s: %s",
                payload.document_id,
                result.get("reason"),
            )
        else:
            logger.info(
                "graph extracted doc=%s chunks=%s", payload.document_id, result.get("chunk_count")
            )

    def _write_snapshots(
        self, payload: IndexJobPayload, document: Any, split: SplitResult
    ) -> tuple[str, str]:
        if not self.s3.configured:
            logger.info("minio not configured; skipping snapshot upload for %s", payload.document_id)
            return "", ""
        prefix = self.settings.index.snapshot_prefix.strip("/")
        base = f"{prefix}/{payload.effective_tenant}/{payload.document_id}/{payload.version_id or 'v1'}"
        block_key = f"{base}/blocks.json"
        chunk_key = f"{base}/chunks.json"
        blocks_body = json.dumps(document.to_dict(), ensure_ascii=False).encode("utf-8")
        chunks_body = json.dumps(
            [chunk.to_dict() for chunk in split.chunks], ensure_ascii=False
        ).encode("utf-8")
        try:
            bucket = self.settings.env.minio.bucket
            self.s3.put_object(bucket, block_key, blocks_body, content_type="application/json")
            self.s3.put_object(bucket, chunk_key, chunks_body, content_type="application/json")
        except KhError as exc:
            logger.warning("snapshot upload failed: %s", exc.message)
            return "", ""
        return block_key, chunk_key


async def _safe_fail(reporter: JobReporter, job_id: str, code: str, message: str) -> None:
    try:
        await reporter.fail(job_id, error_code=code, message=message)
    except Exception:  # pragma: no cover - callback outages must not hide the real error
        logger.exception("failed to report job failure for %s", job_id)


__all__ = [
    "IndexJobPayload",
    "IndexOutcome",
    "IndexPipeline",
    "JobReporter",
    "NoopReporter",
]

"""Hybrid retrieval: dense + BM25 sparse -> RRF -> optional rerank -> ACL re-check.

The ACL predicate is built exactly once, by :func:`knowledge_hub.rag.filters.build_filter`,
from the verified ticket. Request level ``filters`` are accepted by the API but
ignored here by construction (there is no parameter for them).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from knowledge_hub.config.settings import Settings
from knowledge_hub.errors import MilvusUnavailable, RetrievalTimeout
from knowledge_hub.rag.citations import clean_source_url, resolve_title
from knowledge_hub.rag.embed import Embedder
from knowledge_hub.rag.filters import build_filter, is_visible
from knowledge_hub.rag.graph import GraphService
from knowledge_hub.rag.store import ChunkStore, Hit
from knowledge_hub.security.tickets import RetrievalTicket
from knowledge_hub.tools.llm import LLMClient

logger = logging.getLogger(__name__)


def default_collection_name(dim: int) -> str:
    """docs/03 §3 physical collection naming: ``kb_chunks_{dim}``."""
    return f"kb_chunks_{int(dim)}"


@dataclass(slots=True)
class RetrievedChunk:
    chunk_id: str
    doc_id: str
    title: str
    title_path: list[str]
    text: str
    score: float
    source_url: str = ""
    block_type: str = "paragraph"
    highlights: list[list[int]] = field(default_factory=list)
    kb_id: str = ""
    version_id: str = ""
    doc_title: str = ""
    #: 结构化字段：page/heading/paragraph/table/code/image，调试台与评测明细靠它区分块类型
    kind: str = "paragraph"
    chunk_count: int = 1
    table_row_index: int | None = None
    #: 块级定位信息：检索子 Agent 靠它继续用 milvus_query 翻上下文
    block_id: str = ""
    block_parent_id: str = ""
    block_order: int = -1
    references: list[dict[str, Any]] = field(default_factory=list)
    payload: dict[str, Any] = field(default_factory=dict)
    #: 哪几路召回命中（dense / sparse / graph），调试台据此显示来源
    matched_by: list[str] = field(default_factory=list)
    #: 图片块的直连地址（预签名）；有它模型才能在回答里真的把图带出来
    image_url: str = ""

    def to_contract(self) -> dict[str, Any]:
        return {
            "chunk_id": self.chunk_id,
            "doc_id": self.doc_id,
            "title": self.title,
            "title_path": list(self.title_path),
            "text": self.text,
            "score": round(float(self.score), 6),
            "source_url": self.source_url,
            "block_type": self.block_type,
            "kind": self.kind or self.block_type,
            "chunk_count": self.chunk_count,
            "table_row_index": self.table_row_index,
            "matched_by": list(self.matched_by),
            "image_url": self.image_url,
            "block_id": self.block_id,
            "block_parent_id": self.block_parent_id,
            "block_order": self.block_order,
            "highlights": self.highlights,
        }


@dataclass(slots=True)
class RetrieveResult:
    chunks: list[RetrievedChunk]
    debug: dict[str, Any] = field(default_factory=dict)
    answer_hint: str = ""

    def to_contract(self) -> dict[str, Any]:
        return {
            "chunks": [chunk.to_contract() for chunk in self.chunks],
            "debug": self.debug,
            "answer_hint": self.answer_hint,
        }


def _as_int(value: Any, default: int) -> int:
    """Nacos 里的数值字段可能是空串 / null / "默认"：强转失败就用默认值，不让检索报错。"""
    try:
        if value is None or (isinstance(value, str) and not value.strip()):
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float) -> float:
    try:
        if value is None or (isinstance(value, str) and not value.strip()):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


_DEFAULT_LANE_WEIGHTS = {"dense": 0.6, "sparse": 0.4, "graph": 0.3}


def fuse_rrf(
    *hit_lists: Sequence[Hit] | tuple[str, Sequence[Hit]],
    k: int = 60,
) -> list[Hit]:
    """Reciprocal rank fusion; scores are ``sum(1 / (k + rank + 1))`` per ranked list.

    融合分只反映"排名第几"，所以第一名恒为 ``1/(k+1)``（k=60 时约 0.0164）。
    它既不是相似度也不是置信度，不同轮次之间也不可比——界面上要写清楚这一点。
    同时记录每一条命中出现在哪几路召回里，方便排查"到底是稠密还是稀疏找到的"。

    入参可以是 ``(lane, hits)`` 二元组，也可以是裸的命中列表（按位置依次当作
    dense / sparse / graph）。多知识库检索时 dense 会有**多条**命中的列表，
    所以调用方必须显式给 lane——以前按位置硬套标签，第二个库的稠密结果会被
    标成"稀疏"、稀疏结果被标成"图谱"，界面上每条都显示三路来源。
    """
    merged: dict[str, Hit] = {}
    scores: dict[str, float] = {}
    sources: dict[str, list[str]] = {}
    default_lanes = ("dense", "sparse", "graph")
    for index, item in enumerate(hit_lists):
        if isinstance(item, tuple) and len(item) == 2 and isinstance(item[0], str):
            lane, source_hits = item[0], item[1]
        else:
            lane = default_lanes[index] if index < len(default_lanes) else "dense"
            source_hits = item  # type: ignore[assignment]
        for rank, hit in enumerate(source_hits):
            key = hit.pk
            if key not in merged:
                merged[key] = hit
                scores[key] = 0.0
                sources[key] = []
            scores[key] += 1.0 / (k + rank + 1)
            if lane not in sources[key]:
                sources[key].append(lane)
    for key, hit in merged.items():
        hit.score = scores[key]
        hit.matched_by = list(sources[key])
    return sorted(merged.values(), key=lambda item: (-item.score, item.pk))


def fuse_weighted(
    *hit_lists: Sequence[Hit] | tuple[str, Sequence[Hit]],
    weights: Mapping[str, float] | None = None,
    k: int = 60,
) -> list[Hit]:
    """权重融合：每路先把分数归一化到 0..1，再乘上该路的权重相加。

    和 RRF 的区别：RRF 只看排名，权重模式会保留分数的相对大小；
    因此「稠密找得很准、稀疏只是凑数」时把 dense 权重调大更合理。
    """
    lane_weights = dict(weights or {})
    merged: dict[str, Hit] = {}
    scores: dict[str, float] = {}
    sources: dict[str, list[str]] = {}
    default_lanes = ("dense", "sparse", "graph")
    for index, item in enumerate(hit_lists):
        if isinstance(item, tuple) and len(item) == 2 and isinstance(item[0], str):
            lane, source_hits = item[0], item[1]
        else:
            lane = default_lanes[index] if index < len(default_lanes) else "dense"
            source_hits = item  # type: ignore[assignment]
        if not source_hits:
            continue
        weight = float(lane_weights.get(lane, _DEFAULT_LANE_WEIGHTS.get(lane, 0.5)))
        top = max((float(hit.score) for hit in source_hits), default=0.0)
        bottom = min((float(hit.score) for hit in source_hits), default=0.0)
        span = top - bottom
        for hit in source_hits:
            key = hit.pk
            if key not in merged:
                merged[key] = hit
                scores[key] = 0.0
                sources[key] = []
            normalised = (float(hit.score) - bottom) / span if span > 0 else 1.0
            # 加上排名微调，避免平分时乱序；量级远小于主分
            scores[key] += weight * (normalised + 1.0 / (k + 40))
            if lane not in sources[key]:
                sources[key].append(lane)
    for key, hit in merged.items():
        hit.score = scores[key]
        hit.matched_by = list(sources[key])
    return sorted(merged.values(), key=lambda item: (-item.score, item.pk))


def _profile_collection(profile: Mapping[str, Any] | None) -> str:
    if not profile:
        return ""
    explicit = profile.get("collectionName") or profile.get("collection")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    retrieve = profile.get("retrieve")
    if isinstance(retrieve, Mapping):
        explicit = retrieve.get("collectionName") or retrieve.get("collection")
        if isinstance(explicit, str) and explicit.strip():
            return explicit.strip()
    return ""


class Retriever:
    def __init__(
        self,
        settings: Settings,
        *,
        store: ChunkStore | None = None,
        embedder: Embedder | None = None,
        llm: LLMClient | None = None,
        graph: GraphService | None = None,
    ) -> None:
        self.settings = settings
        self.store = store or ChunkStore(settings.env)
        self.llm = llm or LLMClient(settings.llm.base_url, settings.env.llm.litellm_api_key)
        self.embedder = embedder or Embedder(self.llm, settings.embedding)
        self.graph = graph

    def collection_for(self, profile: Mapping[str, Any] | None = None) -> str:
        return _profile_collection(profile) or default_collection_name(
            self.settings.embedding.dimensions
        )

    def resolve_collections(
        self,
        kb_ids: Sequence[str],
        profile: Mapping[str, Any] | None = None,
        kb_collections: Mapping[str, str] | None = None,
    ) -> list[tuple[str, str]]:
        """Target collection per kb: ``kb_collections[kb]`` -> profile -> fallback."""
        default_name = default_collection_name(self.settings.embedding.dimensions)
        profile_name = _profile_collection(profile)
        mapped = {
            str(key): str(value).strip()
            for key, value in (kb_collections or {}).items()
            if isinstance(value, str) and value.strip()
        }
        targets: list[tuple[str, str]] = []
        for kb_id in kb_ids:
            if kb_id in mapped:
                targets.append((kb_id, mapped[kb_id]))
            elif profile_name:
                targets.append((kb_id, profile_name))
            else:
                logger.debug(
                    "kb %s has no explicit collection; falling back to %s", kb_id, default_name
                )
                targets.append((kb_id, default_name))
        return targets

    async def retrieve(
        self,
        *,
        ticket: RetrievalTicket,
        kb_ids: Sequence[str] | None,
        query: str,
        profile: Mapping[str, Any] | None = None,
        top_k: int | None = None,
        include_debug: bool = False,
        timeout_ms: int | None = None,
        kb_collections: Mapping[str, str] | None = None,
        tags: Sequence[str] | None = None,
    ) -> RetrieveResult:
        started = time.perf_counter()
        effective_kb = ticket.effective_kb_ids(list(kb_ids) if kb_ids else None)
        debug: dict[str, Any] = {
            "dense_ms": 0,
            "sparse_ms": 0,
            "rerank_ms": 0,
            "filtered": 0,
            "skipped_kbs": [],
        }
        if not effective_kb:
            debug["reason"] = "no_kb_authorized"
            debug["total_ms"] = _ms(started)
            return RetrieveResult(chunks=[], debug=debug)

        timeout = timeout_ms or _as_int(_profile_value(profile, "timeout_ms", 8000), 8000)
        try:
            result = await asyncio.wait_for(
                self._retrieve_inner(
                    ticket=ticket,
                    kb_ids=effective_kb,
                    query=query,
                    profile=profile,
                    top_k=top_k,
                    debug=debug,
                    started=started,
                    kb_collections=kb_collections,
                    tags=tags,
                ),
                timeout=timeout / 1000.0,
            )
        except MilvusUnavailable:
            self._note_store_failure()
            raise
        except TimeoutError as exc:
            # 检索超时几乎总是向量库卡住：同样触发熔断，避免下一次请求再等满预算
            self._note_store_failure()
            raise RetrievalTimeout("retrieval exceeded the time budget") from exc
        self._note_store_success()
        return result

    def _note_store_failure(self) -> None:
        session = getattr(self.store, "session", None)
        note = getattr(session, "note_failure", None)
        if callable(note):
            note()

    def _note_store_success(self) -> None:
        session = getattr(self.store, "session", None)
        note = getattr(session, "note_success", None)
        if callable(note):
            note()

    async def _retrieve_inner(
        self,
        *,
        ticket: RetrievalTicket,
        kb_ids: tuple[str, ...],
        query: str,
        profile: Mapping[str, Any] | None,
        top_k: int | None,
        debug: dict[str, Any],
        started: float,
        kb_collections: Mapping[str, str] | None = None,
        tags: Sequence[str] | None = None,
    ) -> RetrieveResult:
        if not query.strip():
            debug["reason"] = "empty_query"
            debug["total_ms"] = _ms(started)
            return RetrieveResult(chunks=[], debug=debug)

        # Single ACL code path; raises PermissionDenied when the ticket has no principals.
        filter_expr = build_filter(ticket, kb_ids, tags=tags)

        retrieval = self.settings.retrieval
        dense_cfg = retrieval.dense
        sparse_cfg = retrieval.sparse
        # 图检索与重排的开关必须以**本次策略**为准：之前只读了引擎默认
        # （knowledge-hub.yaml 里 graph.enabled=true），所以选一条「图关」的策略也照样跑图检索。
        graph_profile = _profile_value(profile, "graph", None) or {}
        graph_enabled = bool(graph_profile.get("enabled", retrieval.graph.enabled))
        graph_hops = _as_int(graph_profile.get("hops"), int(retrieval.graph.hops))
        rerank_profile = _profile_value(profile, "rerank", None) or {}
        rerank_enabled = bool(rerank_profile.get("enabled", retrieval.rerank.enabled))
        # 融合策略：rrf 就是纯排名融合；model（模型模式）把候选池交给重排模型重新排序，
        # 所以选了模型模式即使没开重排开关也要走重排。
        fusion_strategy = str(
            _profile_value(profile, "fusion", retrieval.fusion.strategy) or "rrf"
        ).strip().lower()
        if fusion_strategy in {"model", "rerank", "rerank_model"}:
            rerank_enabled = True
        dim = int(self.settings.embedding.dimensions) or _as_int(
            _profile_value(profile, "embedding_dim", 0), 0
        )
        if dim <= 0:
            raise MilvusUnavailable("embedding dimension is not configured")

        dense_limit = _as_int(_profile_value(profile, "dense_top_k", dense_cfg.top_k), int(dense_cfg.top_k))
        sparse_limit = _as_int(
            _profile_value(profile, "sparse_top_k", sparse_cfg.top_k), int(sparse_cfg.top_k)
        )
        final_top_k = _as_int(
            _profile_value(profile, "top_k", top_k or retrieval.top_k), int(retrieval.top_k)
        )

        targets = self.resolve_collections(kb_ids, profile, kb_collections)
        grouped: dict[str, list[str]] = {}
        for kb_id, collection_name in targets:
            grouped.setdefault(collection_name, []).append(kb_id)

        existence = await asyncio.to_thread(self.store.existing_collections, list(grouped))
        active = {name: kbs for name, kbs in grouped.items() if existence.get(name)}
        skipped = [
            {"kb_id": kb_id, "collection": name, "reason": "collection_missing"}
            for name, kbs in grouped.items()
            if not existence.get(name)
            for kb_id in kbs
        ]
        debug["collections"] = list(active)
        debug["skipped_kbs"] = skipped
        if skipped:
            logger.warning(
                "retrieve skipped %s kb(s): collection_missing (%s)",
                len(skipped),
                ", ".join(item["collection"] for item in skipped),
            )
        if not active:
            debug["all_collections_missing"] = True
            debug["reason"] = "no_kb_collection"
            debug["total_ms"] = _ms(started)
            return RetrieveResult(chunks=[], debug=debug)

        vector = await self.embedder.embed_query(query)

        dense_lists: list[list[Hit]] = []
        sparse_lists: list[list[Hit]] = []
        graph_hits: list[Hit] = []
        timings: dict[str, int] = {}

        async def _dense() -> list[list[Hit]]:
            if not dense_cfg.enabled:
                return []
            return [
                await asyncio.to_thread(
                    self.store.search_dense,
                    collection_name,
                    vector,
                    filter_expr,
                    limit=dense_limit,
                    dim=dim,
                )
                for collection_name in active
            ]

        async def _sparse() -> list[list[Hit]]:
            if not sparse_cfg.enabled:
                return []
            return [
                await asyncio.to_thread(
                    self.store.search_sparse,
                    collection_name,
                    query,
                    filter_expr,
                    limit=sparse_limit,
                    dim=dim,
                )
                for collection_name in active
            ]

        async def _graph() -> list[Hit]:
            # 两道闩都要过：引擎侧总开关（knowledge-hub.yaml）+ 本次策略的 graph.enabled。
            if self.graph is None or not self.graph.enabled or not graph_enabled:
                return []
            return await self.graph.search(
                query=query,
                tenant_id=ticket.tenant_id,
                kb_ids=kb_ids,
                principals=ticket.principals,
                hops=graph_hops,
            )

        # Dense, sparse and graph run concurrently: the graph must not add latency
        # to the two vector channels the way a sequential hop would.
        started_at = time.perf_counter()
        dense_lists, sparse_lists, graph_hits = await asyncio.gather(
            _dense(), _sparse(), _graph()
        )
        timings["parallel_ms"] = _ms(started_at)
        debug["dense_ms"] = timings["parallel_ms"]
        debug["sparse_ms"] = timings["parallel_ms"]
        if graph_enabled:
            # 只有真的跑过图检索才报耗时/命中数，否则界面上的"图谱 304ms"是假的
            debug["graph_ms"] = timings["parallel_ms"]
            debug["graph_hits"] = len(graph_hits)
        if sparse_cfg.enabled and not any(self.store.supports_sparse(name) for name in active):
            logger.warning(
                "no active collection has a sparse index; running dense-only retrieval"
            )
            debug["sparse_disabled"] = True

        dense_hits = [hit for hits in dense_lists for hit in hits]
        sparse_hits = [hit for hits in sparse_lists for hit in hits]
        if not dense_hits and not sparse_hits and not graph_hits:
            debug["total_ms"] = _ms(started)
            return RetrieveResult(chunks=[], debug=debug)

        # 每条命中列表都要带上自己真实的 lane：多知识库时 dense/sparse 都是多份
        lanes = [
            *[("dense", hits) for hits in dense_lists],
            *[("sparse", hits) for hits in sparse_lists],
            ("graph", graph_hits),
        ]
        # 融合基数 k：策略里配了就用策略的（默认 60）
        fusion_k = _as_int(_profile_value(profile, "fusion_k", retrieval.fusion.k), int(retrieval.fusion.k))
        if fusion_strategy == "weighted":
            fused = fuse_weighted(
                *lanes,
                weights={
                    "dense": _as_float(_profile_value(profile, "dense_weight", 0.6), 0.6),
                    "sparse": _as_float(_profile_value(profile, "sparse_weight", 0.4), 0.4),
                    "graph": _as_float(_profile_value(profile, "graph_weight", 0.3), 0.3),
                },
                k=fusion_k,
            )
        else:
            fused = fuse_rrf(*lanes, k=fusion_k)

        rerank_cfg = retrieval.rerank
        # 重排保留数 / 重排模型优先用策略里配的，没配才回到引擎默认
        rerank_top_n = _as_int(rerank_profile.get("top_n"), int(rerank_cfg.top_n))
        rerank_model = str(rerank_profile.get("model") or "") or None
        rerank_started = time.perf_counter()
        if rerank_enabled and fused:
            fused = await self._rerank(query, fused, top_n=rerank_top_n, model=rerank_model)
        debug["fusion"] = fusion_strategy
        debug["fusion_k"] = fusion_k
        debug["rerank_model"] = rerank_model or rerank_cfg.model
        debug["rerank_ms"] = _ms(rerank_started)

        seen: set[str] = set()
        chunks: list[RetrievedChunk] = []
        filtered = 0
        for hit in fused:
            if not hit.text.strip():
                filtered += 1
                continue
            if not is_visible(hit.meta(), ticket):
                filtered += 1
                continue
            text_hash = hashlib.sha1(hit.text.encode("utf-8")).hexdigest()
            if text_hash in seen:
                filtered += 1
                continue
            seen.add(text_hash)
            title_path = [part for part in hit.title_path if part]
            chunks.append(
                RetrievedChunk(
                    chunk_id=hit.pk,
                    doc_id=hit.doc_id,
                    title=resolve_title(hit.doc_title, title_path, hit.block_type),
                    title_path=title_path,
                    text=hit.text,
                    score=hit.score,
                    source_url=clean_source_url(hit.source_url),
                    block_type=hit.block_type,
                    kb_id=hit.kb_id,
                    version_id=hit.version_id,
                    kind=hit.kind or hit.block_type,
                    chunk_count=hit.chunk_count or 1,
                    table_row_index=hit.table_row_index,
                    matched_by=list(hit.matched_by),
                    block_id=hit.block_id,
                    block_parent_id=hit.block_parent_id,
                    block_order=hit.block_order,
                    references=list(hit.references or []),
                    payload=dict(hit.payload or {}),
                    image_url=self._image_url(hit),
                )
            )
            if len(chunks) >= final_top_k:
                break

        debug["filtered"] = filtered
        debug["total_ms"] = _ms(started)
        debug["kb_ids"] = list(kb_ids)
        return RetrieveResult(chunks=chunks, debug=debug)

    def _image_url(self, hit: Hit) -> str:
        """图片块返回可直接嵌入 Markdown 的预签名地址；拿不到就留空，不猜地址。"""
        if (hit.kind or hit.block_type) != "image":
            return ""
        payload = hit.payload or {}
        try:
            from knowledge_hub.rag.image_caption import candidate_objects  # noqa: PLC0415
            from knowledge_hub.rag.objectstore import object_exists, presigned_get  # noqa: PLC0415

            minio = self.settings.env.minio
            parser = self.settings.image_parser
            # 新文档 payload 里就有桶名/key；老文档只存了飞书 token，
            # 按归档时的固定 key 推一次，存在才用，不猜链接。
            for bucket, key in candidate_objects(
                payload,
                bucket_default=parser.bucket_name,
                fallback_bucket=self.settings.env.minio.bucket,
                tenant_id=hit.tenant_id,
                document_id=hit.doc_id,
            ):
                if bucket == parser.bucket_name and key.startswith("feishu-images/"):
                    continue
                if object_exists(minio, bucket, key):
                    return presigned_get(minio, bucket, key)
        except Exception as exc:  # noqa: BLE001 - 预签名失败不能影响检索
            logger.warning("presign image failed: %s", type(exc).__name__)
        return ""

    async def _rerank(
        self, query: str, hits: list[Hit], *, top_n: int, model: str | None = None
    ) -> list[Hit]:
        model = model or self.settings.retrieval.rerank.model
        if not model:
            logger.warning("rerank enabled but no rerank model alias configured; keeping RRF order")
            return hits
        try:
            ranked = await self.llm.rerank(
                query, [hit.text for hit in hits], model=model, top_n=top_n
            )
        except Exception as exc:  # rerank must never break retrieval
            logger.warning("rerank failed (%s); keeping RRF order", type(exc).__name__)
            return hits
        if not ranked:
            return hits
        reordered = [hits[index] for index, _score in ranked if 0 <= index < len(hits)]
        for index, (_idx, score) in enumerate(ranked):
            if 0 <= _idx < len(hits):
                reordered[index].score = float(score)
        return reordered


def _ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _profile_value(profile: Mapping[str, Any] | None, key: str, default: Any) -> Any:
    if not profile:
        return default
    value = profile.get(key)
    if value is None and isinstance(profile.get("retrieve"), Mapping):
        value = profile["retrieve"].get(key)
    return default if value is None else value


__all__ = [
    "RetrieveResult",
    "RetrievedChunk",
    "Retriever",
    "default_collection_name",
    "fuse_rrf",
]

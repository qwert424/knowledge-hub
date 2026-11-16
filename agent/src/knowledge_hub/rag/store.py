"""Milvus persistence: collection bootstrap, insert, and dense/sparse search.

Schema follows docs/03 §3 (``kb_chunks_{dim}``-style physical collections are
created per job using the payload's ``collectionName`` with the payload's
dimension). Sparse BM25 search needs Milvus >= 2.5 with the analyzer/Function
feature; when collection creation with BM25 fails we transparently fall back to
dense-only and log a warning (never silently pretend sparse ran).
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from knowledge_hub.config.settings import EnvSettings
from knowledge_hub.errors import MilvusUnavailable
from knowledge_hub.tools.milvus import MilvusSession

logger = logging.getLogger(__name__)

OUTPUT_FIELDS = [
    "tenant_id",
    "kb_id",
    "doc_id",
    "version_id",
    "chunk_index",
    "chunk_count",
    "block_id",
    "block_type",
    "block_order",
    "block_parent_id",
    "kind",
    "title_path",
    "doc_title",
    "text",
    "references",
    "payload",
    "table_row_index",
    "parent_pk",
    "space_id",
    "node_token",
    "revision_id",
    "source_url",
    "source_type",
    "lang",
    "tags",
    "acl_principals",
    "visibility",
    "status",
    "updated_at",
]


@dataclass(slots=True)
class Hit:
    pk: str
    text: str
    score: float
    doc_id: str = ""
    kb_id: str = ""
    tenant_id: str = ""
    version_id: str = ""
    chunk_index: int = 0
    chunk_count: int = 1
    block_id: str = ""
    block_type: str = "paragraph"
    block_order: int = -1
    block_parent_id: str = ""
    kind: str = "paragraph"
    #: 这一条是被哪几路召回命中的：dense / sparse / graph（排查"为什么这条被排上来"用）
    matched_by: list[str] = field(default_factory=list)
    title_path: list[str] = field(default_factory=list)
    doc_title: str = ""
    source_url: str = ""
    acl_principals: list[str] = field(default_factory=list)
    visibility: str = "private"
    status: str = "active"
    source: str = "dense"
    references: list[dict[str, Any]] = field(default_factory=list)
    payload: dict[str, Any] = field(default_factory=dict)
    table_row_index: int = -1
    parent_pk: str = ""
    space_id: str = ""
    node_token: str = ""
    revision_id: str = ""

    def meta(self) -> dict[str, Any]:
        return {
            "tenant_id": self.tenant_id,
            "doc_id": self.doc_id,
            "kb_id": self.kb_id,
            "version_id": self.version_id,
            "chunk_index": self.chunk_index,
            "chunk_count": self.chunk_count,
            "block_id": self.block_id,
            "block_type": self.block_type,
            "block_order": self.block_order,
            "block_parent_id": self.block_parent_id,
            "kind": self.kind,
            "title_path": self.title_path,
            "doc_title": self.doc_title,
            "source_url": self.source_url,
            "acl_principals": self.acl_principals,
            "visibility": self.visibility,
            "status": self.status,
            "references": self.references,
            "payload": self.payload,
            "table_row_index": self.table_row_index,
            "parent_pk": self.parent_pk,
            "space_id": self.space_id,
            "node_token": self.node_token,
            "revision_id": self.revision_id,
        }


class ChunkStore:
    def __init__(self, env: EnvSettings, *, session: MilvusSession | None = None) -> None:
        self.env = env
        self.session = session or MilvusSession(env)
        self._sparse_support: dict[str, bool] = {}
        self._collections: dict[str, Any] = {}
        self._lock = threading.Lock()
        self._generation = self.session.generation

    # ------------------------------------------------------------ bootstrap
    def close(self) -> None:
        self._collections.clear()
        self.session.close()

    def health(self) -> bool:
        return self.session.health()

    def ensure_collection(self, name: str, dim: int) -> bool:
        """Create the collection when missing; returns whether sparse BM25 is usable."""
        if not name:
            raise MilvusUnavailable("collection name is empty")
        if dim <= 0:
            raise MilvusUnavailable("embedding dimension must be positive")
        with self._lock:
            self._drop_stale_handles()
            if name in self._collections:
                return self._sparse_support.get(name, False)
            self.session.connect()
            from pymilvus import utility

            try:
                exists = utility.has_collection(name, using=self.session.alias)
            except Exception as exc:
                self.session.note_failure()
                raise MilvusUnavailable(f"milvus has_collection failed: {exc}") from exc
            if not exists:
                sparse_ok = self._create_collection(name, dim)
            else:
                sparse_ok = self._detect_sparse(name)
            self._sparse_support[name] = sparse_ok
            collection = self._load(name)
            self._collections[name] = collection
            return sparse_ok

    def _build_schema(self, dim: int, *, with_sparse: bool):  # noqa: ANN202 - pymilvus types
        from pymilvus import CollectionSchema, DataType, FieldSchema

        fields = [
            FieldSchema("pk", DataType.VARCHAR, is_primary=True, max_length=64),
            FieldSchema("tenant_id", DataType.VARCHAR, max_length=64, is_partition_key=True),
            FieldSchema("kb_id", DataType.VARCHAR, max_length=64),
            FieldSchema("doc_id", DataType.VARCHAR, max_length=64),
            FieldSchema("version_id", DataType.VARCHAR, max_length=64),
            FieldSchema("chunk_index", DataType.INT64),
            FieldSchema("chunk_count", DataType.INT64),
            FieldSchema("parent_pk", DataType.VARCHAR, max_length=64),
            FieldSchema("block_id", DataType.VARCHAR, max_length=64),
            FieldSchema("block_type", DataType.VARCHAR, max_length=32),
            FieldSchema("block_order", DataType.INT64),
            FieldSchema("block_parent_id", DataType.VARCHAR, max_length=64),
            FieldSchema("kind", DataType.VARCHAR, max_length=16),
            FieldSchema("title_path", DataType.JSON),
            FieldSchema("references", DataType.JSON),
            FieldSchema("payload", DataType.JSON),
            FieldSchema("table_row_index", DataType.INT64),
            FieldSchema("space_id", DataType.VARCHAR, max_length=64),
            FieldSchema("node_token", DataType.VARCHAR, max_length=128),
            FieldSchema("revision_id", DataType.VARCHAR, max_length=64),
            FieldSchema("doc_title", DataType.VARCHAR, max_length=512),
            FieldSchema(
                "text",
                DataType.VARCHAR,
                max_length=65535,
                enable_analyzer=True,
                analyzer_params={"type": "chinese"},
            ),
            FieldSchema("dense", DataType.FLOAT_VECTOR, dim=dim),
            FieldSchema(
                "acl_principals",
                DataType.ARRAY,
                element_type=DataType.VARCHAR,
                max_capacity=64,
                max_length=128,
            ),
            FieldSchema("visibility", DataType.VARCHAR, max_length=16),
            FieldSchema("status", DataType.VARCHAR, max_length=16),
            FieldSchema("source_url", DataType.VARCHAR, max_length=1024),
            FieldSchema("source_type", DataType.VARCHAR, max_length=32),
            FieldSchema("lang", DataType.VARCHAR, max_length=8),
            FieldSchema(
                "tags",
                DataType.ARRAY,
                element_type=DataType.VARCHAR,
                max_capacity=32,
                max_length=64,
            ),
            FieldSchema("updated_at", DataType.INT64),
        ]
        functions = []
        if with_sparse:
            from pymilvus import DataType as _DT  # noqa: F401
            from pymilvus import Function, FunctionType

            fields.append(FieldSchema("sparse", _DT.SPARSE_FLOAT_VECTOR))
            functions.append(
                Function(
                    name="text_bm25",
                    function_type=FunctionType.BM25,
                    input_field_names=["text"],
                    output_field_names=["sparse"],
                )
            )
        return CollectionSchema(fields, description="knowledge hub chunks", functions=functions)

    def _create_collection(self, name: str, dim: int) -> bool:
        from pymilvus import Collection

        sparse_ok = True
        try:
            schema = self._build_schema(dim, with_sparse=True)
            collection = Collection(name=name, schema=schema, using=self.session.alias)
            self._create_indexes(collection, with_sparse=True)
            logger.info("created milvus collection %s (dim=%s, sparse=bm25)", name, dim)
            return sparse_ok
        except Exception as exc:
            logger.warning(
                "collection %s: BM25 sparse schema unsupported (%s); falling back to dense-only", name, exc
            )
            sparse_ok = False
        try:
            schema = self._build_schema(dim, with_sparse=False)
            collection = Collection(name=name, schema=schema, using=self.session.alias)
            self._create_indexes(collection, with_sparse=False)
            logger.info("created milvus collection %s (dim=%s, dense-only)", name, dim)
            return sparse_ok
        except Exception as exc:
            self.session.note_failure()
            raise MilvusUnavailable(f"milvus collection create failed: {exc}") from exc

    def _create_indexes(self, collection: Any, *, with_sparse: bool) -> None:
        collection.create_index(
            field_name="dense",
            index_params={
                "index_type": "HNSW",
                "metric_type": "COSINE",
                "params": {"M": 16, "efConstruction": 200},
            },
        )
        if with_sparse:
            collection.create_index(
                field_name="sparse",
                index_params={"index_type": "SPARSE_INVERTED_INDEX", "metric_type": "BM25"},
            )
        for field_name in ("kb_id", "doc_id", "status", "acl_principals", "version_id"):
            for index_type in ("INVERTED", "AUTOINDEX"):
                try:
                    collection.create_index(
                        field_name=field_name, index_params={"index_type": index_type}
                    )
                    break
                except Exception:  # pragma: no cover - version dependent
                    continue

    def _detect_sparse(self, name: str) -> bool:
        from pymilvus import Collection

        try:
            collection = Collection(name=name, using=self.session.alias)
            fields = getattr(collection.schema, "fields", []) or []
            return any(getattr(field, "name", "") == "sparse" for field in fields)
        except Exception as exc:
            logger.warning("collection %s schema probe failed: %s", name, exc)
            return False

    def _load(self, name: str):  # noqa: ANN202
        from pymilvus import Collection

        collection = Collection(name=name, using=self.session.alias)
        try:
            collection.load()
        except Exception as exc:  # pragma: no cover - already loaded / transient
            logger.debug("collection %s load: %s", name, exc)
        return collection

    def _drop_stale_handles(self) -> None:
        """连接被重建过就丢掉旧的 Collection 句柄。

        Milvus 重启后，缓存里的 Collection 仍绑定在已关闭的 gRPC 通道上，
        ensure_collection 又因命中缓存而不会重连，结果进程活着但检索永久不可用。
        """
        if self._generation == self.session.generation:
            return
        self._collections.clear()
        self._sparse_support.clear()
        self._generation = self.session.generation
        logger.info("milvus connection rebuilt; dropped cached collection handles")

    def _collection(self, name: str, dim: int):  # noqa: ANN202
        self.ensure_collection(name, dim)
        return self._collections[name]

    def collection_exists(self, name: str) -> bool:
        return self.existing_collections([name]).get(name, False)

    def existing_collections(self, names: Sequence[str]) -> dict[str, bool]:
        """Cheap metadata probe used to skip kbs whose collection is not created yet."""
        if not names:
            return {}
        self.session.connect()
        from pymilvus import utility

        result: dict[str, bool] = {}
        for name in names:
            try:
                result[name] = bool(utility.has_collection(name, using=self.session.alias))
            except Exception as exc:
                self.session.note_failure()
                raise MilvusUnavailable(f"milvus has_collection failed: {exc}") from exc
        return result

    # ---------------------------------------------------------------- writes
    def delete_doc_version(self, collection_name: str, doc_id: str, version_id: str, *, dim: int) -> None:
        collection = self._collection(collection_name, dim)
        expr = f'(doc_id == "{_quote(doc_id)}")'
        if version_id:
            expr += f' and (version_id == "{_quote(version_id)}")'
        try:
            collection.delete(expr)
        except Exception as exc:
            self.session.note_failure()
            raise MilvusUnavailable(f"milvus delete failed: {exc}") from exc

    def delete_other_versions(
        self, collection_name: str, doc_id: str, keep_version_id: str, *, dim: int
    ) -> None:
        """删掉同一文档的其它版本。

        检索侧只按 status/acl/kb 过滤，不按版本过滤：如果重索引后旧版本的行留着，
        同一段内容会被检索到两份，旧版本还会"阴魂不散"地被引用。
        """
        if not keep_version_id:
            return
        collection = self._collection(collection_name, dim)
        expr = (
            f'(doc_id == "{_quote(doc_id)}") '
            f'and not (version_id == "{_quote(keep_version_id)}")'
        )
        try:
            collection.delete(expr)
        except Exception as exc:
            logger.warning("purge stale versions of %s failed: %s", doc_id, exc)

    def insert(self, collection_name: str, rows: Sequence[dict[str, Any]], *, dim: int) -> list[str]:
        if not rows:
            return []
        collection = self._collection(collection_name, dim)
        # 旧集合没有新加的结构字段：只写它认识的列，并提示重索引，而不是让整批插入失败。
        allowed = self._field_names(collection)
        if allowed:
            cleaned: list[dict[str, Any]] = []
            dropped: set[str] = set()
            for row in rows:
                extra = set(row) - allowed
                if extra:
                    dropped |= {name for name in extra if name not in {"dense", "sparse", "pk"}}
                cleaned.append({key: value for key, value in row.items() if key in allowed})
            if dropped:
                logger.warning(
                    "collection %s 缺少字段 %s：本次只写入已有列；要启用结构补查请重建索引",
                    collection_name,
                    ",".join(sorted(dropped)),
                )
            rows = cleaned
        try:
            result = collection.insert(list(rows))
            collection.flush()
        except Exception as exc:
            self.session.note_failure()
            raise MilvusUnavailable(f"milvus insert failed: {exc}") from exc
        primary_keys = getattr(result, "primary_keys", None) or []
        return [str(pk) for pk in primary_keys]

    def _field_names(self, collection: Any) -> set[str]:
        try:
            fields = getattr(collection.schema, "fields", []) or []
            return {str(getattr(field, "name", "")) for field in fields if getattr(field, "name", "")}
        except Exception:  # pragma: no cover - schema probe failure must not block writes
            return set()

    def _output_fields(self, collection: Any) -> list[str]:
        """只请求集合里真实存在的列：老集合少几个新字段时也不会整条查询失败。"""
        known = self._field_names(collection)
        if not known:
            return OUTPUT_FIELDS
        return [name for name in OUTPUT_FIELDS if name in known]

    # ---------------------------------------------------------------- search
    def query_scalar(
        self,
        collection_name: str,
        filter_expr: str,
        *,
        limit: int = 20,
        offset: int = 0,
        dim: int,
    ) -> list[dict[str, Any]]:
        """按标量过滤条件读取切片（不需要向量），支持分页。

        Agent 用它做"已知 doc_id / block_id 后翻页看上下文"，
        和 reference 项目的 milvus_query 语义一致。
        """
        collection = self._collection(collection_name, dim)
        try:
            rows = collection.query(
                expr=filter_expr,
                output_fields=self._output_fields(collection),
                limit=max(1, min(int(limit), 100)),
                offset=max(0, int(offset)),
            )
        except Exception as exc:
            self.session.note_failure()
            raise MilvusUnavailable(f"milvus query failed: {exc}") from exc
        return [dict(row) for row in rows or []]

    def query_all(
        self,
        collection_name: str,
        filter_expr: str,
        *,
        dim: int,
        max_rows: int = 5000,
    ) -> list[dict[str, Any]]:
        """把符合条件的切片全部读出来（图谱重建要整篇正文）。

        Milvus 单次 query 有上限，所以按 100 一页翻；到 ``max_rows`` 就停，
        避免一篇超大文档把内存吃光。
        """
        rows: list[dict[str, Any]] = []
        offset = 0
        while len(rows) < max_rows:
            page = self.query_scalar(collection_name, filter_expr, limit=100, offset=offset, dim=dim)
            if not page:
                break
            rows.extend(page)
            if len(page) < 100:
                break
            offset += len(page)
        return rows[:max_rows]

    def search_dense(
        self,
        collection_name: str,
        vector: Sequence[float],
        filter_expr: str,
        *,
        limit: int,
        dim: int,
    ) -> list[Hit]:
        collection = self._collection(collection_name, dim)
        try:
            results = collection.search(
                data=[list(vector)],
                anns_field="dense",
                param={"metric_type": "COSINE", "params": {"ef": max(64, limit * 2)}},
                limit=limit,
                expr=filter_expr,
                output_fields=self._output_fields(collection),
            )
        except Exception as exc:
            self.session.note_failure()
            raise MilvusUnavailable(f"milvus dense search failed: {exc}") from exc
        return _to_hits(results, "dense")

    def search_sparse(
        self,
        collection_name: str,
        query_text: str,
        filter_expr: str,
        *,
        limit: int,
        dim: int,
    ) -> list[Hit]:
        if not self._sparse_support.get(collection_name, False):
            return []
        collection = self._collection(collection_name, dim)
        try:
            results = collection.search(
                data=[query_text],
                anns_field="sparse",
                param={"metric_type": "BM25"},
                limit=limit,
                expr=filter_expr,
                output_fields=self._output_fields(collection),
            )
        except Exception as exc:
            logger.warning("sparse search failed on %s, degrading to dense-only: %s", collection_name, exc)
            self._sparse_support[collection_name] = False
            return []
        return _to_hits(results, "sparse")

    def supports_sparse(self, collection_name: str) -> bool:
        return self._sparse_support.get(collection_name, False)


def _quote(value: str) -> str:
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


def _to_hits(results: Any, source: str) -> list[Hit]:
    hits: list[Hit] = []
    for batch in results or []:
        for raw in batch:
            entity = raw.entity
            get = entity.get if entity is not None else (lambda _name: None)
            title_path = get("title_path") or []
            if isinstance(title_path, str):
                title_path = [title_path]
            hits.append(
                Hit(
                    pk=str(raw.id),
                    text=str(get("text") or ""),
                    score=float(raw.score),
                    doc_id=str(get("doc_id") or ""),
                    kb_id=str(get("kb_id") or ""),
                    tenant_id=str(get("tenant_id") or ""),
                    version_id=str(get("version_id") or ""),
                    chunk_index=int(get("chunk_index") or 0),
                    chunk_count=int(get("chunk_count") or 1),
                    block_id=str(get("block_id") or ""),
                    block_type=str(get("block_type") or "paragraph"),
                    block_order=int(get("block_order") or -1),
                    block_parent_id=str(get("block_parent_id") or ""),
                    kind=str(get("kind") or "paragraph"),
                    title_path=[str(part) for part in title_path],
                    doc_title=str(get("doc_title") or ""),
                    source_url=str(get("source_url") or ""),
                    acl_principals=[str(p) for p in (get("acl_principals") or [])],
                    visibility=str(get("visibility") or "private"),
                    status=str(get("status") or "active"),
                    source=source,
                    references=_as_list(get("references")),
                    payload=_as_dict(get("payload")),
                    table_row_index=int(get("table_row_index") or -1),
                    parent_pk=str(get("parent_pk") or ""),
                    space_id=str(get("space_id") or ""),
                    node_token=str(get("node_token") or ""),
                    revision_id=str(get("revision_id") or ""),
                )
            )
    return hits


def _as_list(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    return []


def _as_dict(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


__all__ = ["ChunkStore", "Hit", "OUTPUT_FIELDS"]

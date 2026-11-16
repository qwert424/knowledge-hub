"""Neo4j-backed GraphRAG store.

Only *selected* documents are extracted into the graph (docs/05 §GraphRAG), so the
graph is a supplement to dense + sparse retrieval, never a replacement.

Security model mirrors :mod:`knowledge_hub.rag.filters`: every node carries
``tenant_id``/``kb_id`` and every chunk carries ``status``/``visibility``/
``acl_principals``. Reads filter on all of them, so the graph can never widen
what a ticket is allowed to see.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from knowledge_hub.config.settings import Settings
from knowledge_hub.rag.store import Hit

logger = logging.getLogger(__name__)

_ENTITY_LABEL = "Entity"
_CHUNK_LABEL = "Chunk"
_VECTOR_INDEX = "entity_vec"
_RELATION_LABEL = "RELATED"
_MAX_HOPS = 3


class GraphStoreError(RuntimeError):
    """Neo4j is unreachable or rejected the statement."""


@dataclass(slots=True)
class GraphEntity:
    name: str
    type: str = "entity"
    description: str = ""
    embedding: list[float] = field(default_factory=list)


@dataclass(slots=True)
class GraphRelation:
    source: str
    target: str
    type: str = "RELATED"
    description: str = ""


@dataclass(slots=True)
class GraphChunk:
    """Chunk projection written to Neo4j; ACL fields must match Milvus exactly."""

    chunk_id: str
    doc_id: str
    kb_id: str
    tenant_id: str
    text: str
    title_path: list[str] = field(default_factory=list)
    block_type: str = "paragraph"
    doc_title: str = ""
    source_url: str = ""
    version_id: str = ""
    acl_principals: list[str] = field(default_factory=list)
    visibility: str = "private"
    status: str = "active"
    entities: list[str] = field(default_factory=list)

    @classmethod
    def from_row(cls, row: Mapping[str, Any], *, entities: Sequence[str] = ()) -> GraphChunk:
        return cls(
            chunk_id=str(row.get("pk") or ""),
            doc_id=str(row.get("doc_id") or ""),
            kb_id=str(row.get("kb_id") or ""),
            tenant_id=str(row.get("tenant_id") or ""),
            text=str(row.get("text") or ""),
            title_path=[str(part) for part in (row.get("title_path") or [])],
            block_type=str(row.get("block_type") or "paragraph"),
            doc_title=str(row.get("doc_title") or ""),
            source_url=str(row.get("source_url") or ""),
            version_id=str(row.get("version_id") or ""),
            acl_principals=[str(value) for value in (row.get("acl_principals") or [])],
            visibility=str(row.get("visibility") or "private"),
            status=str(row.get("status") or "active"),
            entities=[str(name) for name in entities],
        )


class Neo4jGraphStore:
    """Small synchronous wrapper; call it via ``asyncio.to_thread`` like Milvus."""

    def __init__(
        self,
        settings: Settings,
        *,
        driver: Any | None = None,
        session_factory: Any | None = None,
    ) -> None:
        self.settings = settings
        self._driver = driver
        self._session_factory = session_factory

    # -------------------------------------------------------------- connection
    @property
    def database(self) -> str:
        return self.settings.env.neo4j.database or "neo4j"

    @property
    def configured(self) -> bool:
        return bool(
            self.settings.env.neo4j.uri
            and self.settings.env.neo4j.user
            and self.settings.env.neo4j.password
        ) or self._session_factory is not None

    def _session(self) -> Any:
        if self._session_factory is not None:
            return self._session_factory()
        if self._driver is None:
            try:
                from neo4j import GraphDatabase
            except ImportError as exc:  # pragma: no cover - packaging guard
                raise GraphStoreError("neo4j driver is not installed") from exc
            neo4j = self.settings.env.neo4j
            self._driver = GraphDatabase.driver(
                neo4j.uri,
                auth=(neo4j.user, neo4j.password),
                connection_timeout=neo4j.connection_timeout_s,
                max_connection_pool_size=neo4j.max_connection_pool_size,
            )
        return self._driver.session(database=self.database)

    def close(self) -> None:
        driver, self._driver = self._driver, None
        if driver is not None and self._session_factory is None:
            try:
                driver.close()
            except Exception:  # pragma: no cover - best effort
                pass

    def health(self) -> bool:
        if not self.configured:
            return False
        try:
            with self._session() as session:
                session.run("RETURN 1 AS ok").consume()
            return True
        except Exception as exc:
            logger.info("neo4j health probe failed: %s", type(exc).__name__)
            return False

    # ------------------------------------------------------------------ schema
    def ensure_schema(self, dim: int) -> None:
        """Constraints + the entity vector index; idempotent."""
        statements = [
            f"CREATE CONSTRAINT entity_key IF NOT EXISTS FOR (e:{_ENTITY_LABEL}) "
            "REQUIRE (e.tenant_id, e.kb_id, e.name) IS UNIQUE",
            f"CREATE CONSTRAINT chunk_key IF NOT EXISTS FOR (c:{_CHUNK_LABEL}) "
            "REQUIRE (c.tenant_id, c.chunk_id) IS UNIQUE",
        ]
        if dim > 0:
            statements.append(
                f"CREATE VECTOR INDEX {_VECTOR_INDEX} IF NOT EXISTS "
                f"FOR (e:{_ENTITY_LABEL}) ON e.embedding "
                "OPTIONS {indexConfig: {`vector.dimensions`: $dim, "
                "`vector.similarity_function`: 'cosine'}}"
            )
        with self._session() as session:
            for statement in statements:
                try:
                    session.run(statement, dim=int(dim)).consume()
                except Exception as exc:
                    # A pre-existing index with a different dimension must not break
                    # the whole job; the caller sees the warning and keeps dense search.
                    logger.warning("graph schema statement skipped: %s", type(exc).__name__)

    def describe(
        self,
        vector: Sequence[float],
        *,
        tenant_id: str,
        kb_ids: Sequence[str],
        hops: int = 1,
        seed_k: int = 8,
        limit: int = 20,
    ) -> dict[str, list[dict[str, Any]]]:
        """把「命中了什么」说清楚：种子实体 + 一跳内的关系。

        之前查询接口只返回命中的切片 id，entities/relations 永远是空数组，
        界面上看着像「图谱查询什么都没有」。这里把实体与关系一并带回。
        """
        if not vector or not kb_ids:
            return {"entities": [], "relations": []}
        depth = max(1, min(int(hops), _MAX_HOPS))
        statement = f"""
            CALL db.index.vector.queryNodes('{_VECTOR_INDEX}', $seed_k, $vector)
            YIELD node AS seed, score
            WHERE seed.tenant_id = $tenant_id AND seed.kb_id IN $kb_ids
            OPTIONAL MATCH (seed)-[r:{_RELATION_LABEL}*1..{depth}]-(n:{_ENTITY_LABEL})
            WHERE n.tenant_id = $tenant_id AND n.kb_id IN $kb_ids
            RETURN collect(DISTINCT {{
                name: seed.name,
                type: coalesce(seed.type, ''),
                description: coalesce(seed.description, ''),
                score: score,
                seed: true
            }}) + collect(DISTINCT {{
                name: n.name,
                type: coalesce(n.type, ''),
                description: coalesce(n.description, ''),
                score: 0.0,
                seed: false
            }}) AS entities,
            collect(DISTINCT CASE WHEN n IS NULL THEN null ELSE {{
                source: seed.name, target: n.name, type: coalesce(r[-1].type, '')
            }} END) AS relations
            LIMIT $limit
        """
        try:
            with self._session() as session:
                rows = [record.data() for record in session.run(
                    statement,
                    vector=list(vector),
                    tenant_id=tenant_id,
                    kb_ids=list(kb_ids),
                    seed_k=int(seed_k),
                    limit=int(limit),
                )]
        except Exception as exc:  # noqa: BLE001 - 说明性查询失败不影响命中结果
            logger.debug("graph describe skipped: %s", exc)
            return {"entities": [], "relations": []}
        entities: list[dict[str, Any]] = []
        relations: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in rows:
            for item in row.get("entities") or []:
                name = str((item or {}).get("name") or "")
                if not name or name in seen:
                    continue
                seen.add(name)
                entities.append(item)
            for item in row.get("relations") or []:
                if item and item.get("source") and item.get("target"):
                    relations.append(item)
        return {"entities": entities[:40], "relations": relations[:40]}

    # ------------------------------------------------------------------- write
    def replace_document_graph(
        self,
        *,
        tenant_id: str,
        kb_id: str,
        doc_id: str,
        chunks: Sequence[GraphChunk],
        entities: Sequence[GraphEntity],
        relations: Sequence[GraphRelation],
    ) -> int:
        """Rebuild one document's subgraph (idempotent re-index)."""
        if not chunks:
            return 0
        payload_chunks = [
            {
                "chunk_id": chunk.chunk_id,
                "doc_id": chunk.doc_id,
                "kb_id": chunk.kb_id,
                "tenant_id": chunk.tenant_id,
                "text": chunk.text[:8000],
                "title_path": chunk.title_path[:10],
                "block_type": chunk.block_type,
                "doc_title": chunk.doc_title[:512],
                "source_url": chunk.source_url[:1024],
                "version_id": chunk.version_id,
                "acl_principals": chunk.acl_principals[:64],
                "visibility": chunk.visibility,
                "status": chunk.status,
                "entities": chunk.entities[:64],
            }
            for chunk in chunks
        ]
        payload_entities = [
            {
                "name": entity.name[:256],
                "type": entity.type[:64],
                "description": entity.description[:2000],
                "embedding": list(entity.embedding),
            }
            for entity in entities
            if entity.name.strip()
        ]
        payload_relations = [
            {
                "source": relation.source[:256],
                "target": relation.target[:256],
                "type": relation.type[:64] or "RELATED",
                "description": relation.description[:1000],
            }
            for relation in relations
            if relation.source.strip() and relation.target.strip()
        ]
        with self._session() as session:
            session.run(
                f"MATCH (c:{_CHUNK_LABEL} {{tenant_id: $tenant_id, doc_id: $doc_id}}) "
                "DETACH DELETE c",
                tenant_id=tenant_id,
                doc_id=doc_id,
            ).consume()
            session.run(
                f"""
                UNWIND $chunks AS row
                MERGE (c:{_CHUNK_LABEL} {{tenant_id: row.tenant_id, chunk_id: row.chunk_id}})
                SET c.doc_id = row.doc_id, c.kb_id = row.kb_id, c.text = row.text,
                    c.title_path = row.title_path, c.block_type = row.block_type,
                    c.doc_title = row.doc_title, c.source_url = row.source_url,
                    c.version_id = row.version_id, c.acl_principals = row.acl_principals,
                    c.visibility = row.visibility, c.status = row.status
                """,
                chunks=payload_chunks,
            ).consume()
            session.run(
                f"""
                UNWIND $entities AS row
                MERGE (e:{_ENTITY_LABEL} {{tenant_id: $tenant_id, kb_id: $kb_id, name: row.name}})
                SET e.type = row.type, e.description = row.description
                FOREACH (_ IN CASE WHEN size(row.embedding) > 0 THEN [1] ELSE [] END |
                    SET e.embedding = row.embedding)
                """,
                tenant_id=tenant_id,
                kb_id=kb_id,
                entities=payload_entities,
            ).consume()
            session.run(
                f"""
                UNWIND $chunks AS row
                MATCH (c:{_CHUNK_LABEL} {{tenant_id: row.tenant_id, chunk_id: row.chunk_id}})
                UNWIND row.entities AS name
                MATCH (e:{_ENTITY_LABEL} {{tenant_id: row.tenant_id, kb_id: row.kb_id, name: name}})
                MERGE (e)-[:MENTIONS]->(c)
                """,
                chunks=payload_chunks,
            ).consume()
            session.run(
                f"""
                UNWIND $relations AS row
                MATCH (a:{_ENTITY_LABEL} {{tenant_id: $tenant_id, kb_id: $kb_id, name: row.source}})
                MATCH (b:{_ENTITY_LABEL} {{tenant_id: $tenant_id, kb_id: $kb_id, name: row.target}})
                MERGE (a)-[r:{_RELATION_LABEL} {{type: row.type}}]->(b)
                SET r.description = row.description
                """,
                tenant_id=tenant_id,
                kb_id=kb_id,
                relations=payload_relations,
            ).consume()
        return len(payload_chunks)

    # -------------------------------------------------------------------- read
    def search(
        self,
        vector: Sequence[float],
        *,
        tenant_id: str,
        kb_ids: Sequence[str],
        principals: Sequence[str],
        hops: int = 1,
        limit: int = 20,
        seed_k: int = 8,
    ) -> list[Hit]:
        """Vector-match entities, expand ``hops``, return their chunks as :class:`Hit`."""
        if not vector or not kb_ids or not principals:
            return []
        depth = max(1, min(int(hops), _MAX_HOPS))
        statement = f"""
            CALL db.index.vector.queryNodes('{_VECTOR_INDEX}', $seed_k, $vector)
            YIELD node AS seed, score
            WHERE seed.tenant_id = $tenant_id AND seed.kb_id IN $kb_ids
            OPTIONAL MATCH (seed)-[:{_RELATION_LABEL}*1..{depth}]-(n:{_ENTITY_LABEL})
            WHERE n.tenant_id = $tenant_id AND n.kb_id IN $kb_ids
            WITH collect(DISTINCT seed) + collect(DISTINCT n) AS entities, score
            UNWIND entities AS entity
            WITH entity, score WHERE entity IS NOT NULL
            MATCH (entity)-[:MENTIONS]->(c:{_CHUNK_LABEL})
            WHERE c.tenant_id = $tenant_id
              AND c.kb_id IN $kb_ids
              AND c.status = 'active'
              AND (c.visibility = 'public'
                   OR any(principal IN $principals WHERE principal IN c.acl_principals))
            RETURN c.chunk_id AS chunk_id, c.doc_id AS doc_id, c.kb_id AS kb_id,
                   c.tenant_id AS tenant_id, c.text AS text, c.title_path AS title_path,
                   c.block_type AS block_type, c.doc_title AS doc_title,
                   c.source_url AS source_url, c.version_id AS version_id,
                   c.acl_principals AS acl_principals, c.visibility AS visibility,
                   c.status AS status, max(score) AS score, count(*) AS support
            ORDER BY score DESC, support DESC
            LIMIT $limit
        """
        try:
            with self._session() as session:
                rows = [
                    record.data()
                    for record in session.run(
                        statement,
                        vector=list(vector),
                        tenant_id=tenant_id,
                        kb_ids=list(kb_ids),
                        principals=list(principals),
                        seed_k=int(seed_k),
                        limit=int(limit),
                    )
                ]
        except Exception as exc:
            message = str(exc)
            # 还没建索引（图里没有数据）不是错误：按"这次没有图召回"处理。
            if "vector" in message.lower() and "index" in message.lower():
                logger.debug("graph vector index not ready; skipping graph retrieval")
                return []
            raise GraphStoreError(f"neo4j query failed: {type(exc).__name__}") from exc
        hits: list[Hit] = []
        for row in rows:
            hits.append(
                Hit(
                    pk=str(row.get("chunk_id") or ""),
                    text=str(row.get("text") or ""),
                    score=float(row.get("score") or 0.0),
                    doc_id=str(row.get("doc_id") or ""),
                    kb_id=str(row.get("kb_id") or ""),
                    tenant_id=str(row.get("tenant_id") or ""),
                    version_id=str(row.get("version_id") or ""),
                    block_type=str(row.get("block_type") or "paragraph"),
                    title_path=[str(part) for part in (row.get("title_path") or [])],
                    doc_title=str(row.get("doc_title") or ""),
                    source_url=str(row.get("source_url") or ""),
                    acl_principals=[str(value) for value in (row.get("acl_principals") or [])],
                    visibility=str(row.get("visibility") or "private"),
                    status=str(row.get("status") or "active"),
                    source="graph",
                )
            )
        return hits


__all__ = [
    "GraphChunk",
    "GraphEntity",
    "GraphRelation",
    "GraphStoreError",
    "Neo4jGraphStore",
]

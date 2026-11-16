"""Neo4j settings (``NEO4J_*``) for the GraphRAG store.

``configured`` is False unless a URI *and* credentials are present, which is how
the engine decides to skip graph retrieval instead of failing a request.
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import SettingsConfigDict

from knowledge_hub.config.base import DomainSettings


class Neo4jSettings(DomainSettings):
    model_config = SettingsConfigDict(
        extra="ignore", case_sensitive=False, env_file=None, env_prefix="NEO4J_"
    )

    uri: str = ""
    user: str = "neo4j"
    password: str = ""
    database: str = "neo4j"
    connection_timeout_s: float = Field(default=5.0, gt=0)
    max_connection_pool_size: int = Field(default=20, gt=0)
    # Vector index on Entity.embedding (docs/03 §4).
    vector_index: str = "entity_vec"

    @property
    def configured(self) -> bool:
        return bool(self.uri and self.user and self.password)


__all__ = ["Neo4jSettings"]

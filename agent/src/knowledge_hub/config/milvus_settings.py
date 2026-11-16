"""Milvus connection and index parameters (``MILVUS_*``).

Connection values are credentials/endpoints; index parameters are physical
knobs that used to be hard-coded in :mod:`knowledge_hub.rag.store`.
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import SettingsConfigDict

from knowledge_hub.config.base import DomainSettings


class MilvusSettings(DomainSettings):
    model_config = SettingsConfigDict(
        extra="ignore", case_sensitive=False, env_file=None, env_prefix="MILVUS_"
    )

    uri: str = "http://127.0.0.1:19530"
    db_name: str = "default"
    token: str = ""
    timeout_ms: int = Field(default=2000, gt=0)

    # --- physical layout -------------------------------------------------
    collection_prefix: str = "kb_chunks"
    index_type: str = "HNSW"
    metric_type: str = "COSINE"
    hnsw_m: int = Field(default=16, gt=0)
    hnsw_ef_construction: int = Field(default=200, gt=0)
    hnsw_ef: int = Field(default=64, gt=0)

    def collection_name(self, dim: int) -> str:
        """``kb_chunks_{dim}`` (docs/03 §3 physical collection naming)."""
        return f"{self.collection_prefix}_{int(dim)}"


__all__ = ["MilvusSettings"]

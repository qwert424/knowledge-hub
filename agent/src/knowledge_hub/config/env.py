"""Environment layer as a composition of per-domain settings objects.

Each domain module (``llm_settings``, ``milvus_settings``, ``nacos_settings``,
``minio_settings``, ``neo4j_settings``, ``redis_settings``, ``server_settings``)
declares *its own* variables exactly once. :class:`EnvSettings` only wires them
together, so ``.env`` never has a second, implicit schema living in one big
class.
"""

from __future__ import annotations

import os
from typing import Any

from knowledge_hub.config.llm_settings import LLMSettings
from knowledge_hub.config.milvus_settings import MilvusSettings
from knowledge_hub.config.minio_settings import MinioSettings
from knowledge_hub.config.nacos_settings import NacosSettings
from knowledge_hub.config.neo4j_settings import Neo4jSettings
from knowledge_hub.config.redis_settings import RedisSettings
from knowledge_hub.config.server_settings import ServerSettings, WorkerSettings

_DOMAINS = ("server", "milvus", "nacos", "minio", "llm", "neo4j", "redis", "worker")


class EnvSettings:
    """Endpoint / credential / port settings, one object per domain."""

    __slots__ = _DOMAINS

    def __init__(
        self,
        env_file: str | None = None,
        *,
        server: ServerSettings | None = None,
        milvus: MilvusSettings | None = None,
        nacos: NacosSettings | None = None,
        minio: MinioSettings | None = None,
        llm: LLMSettings | None = None,
        neo4j: Neo4jSettings | None = None,
        redis: RedisSettings | None = None,
        worker: WorkerSettings | None = None,
    ) -> None:
        source: dict[str, Any] = {"_env_file": env_file}
        self.server = server or ServerSettings(**source)
        self.milvus = milvus or MilvusSettings(**source)
        self.nacos = nacos or NacosSettings(**source)
        self.minio = minio or MinioSettings(**source)
        self.llm = llm or LLMSettings(**source)
        self.neo4j = neo4j or Neo4jSettings(**source)
        self.redis = redis or RedisSettings(**source)
        self.worker = worker or WorkerSettings(**source)

    def replace(self, **overrides: Any) -> EnvSettings:
        """Copy with ``<domain>__<field>`` overrides (test/DI helper).

        >>> env.replace(nacos__server="", llm__api_key="test-key")
        """
        domains: dict[str, Any] = {name: getattr(self, name) for name in _DOMAINS}
        pending: dict[str, dict[str, Any]] = {}
        for key, value in overrides.items():
            domain, separator, field = key.partition("__")
            if not separator or not field or domain not in domains:
                raise AttributeError(f"unknown env override: {key!r}")
            pending.setdefault(domain, {})[field] = value
        for domain, patch in pending.items():
            domains[domain] = domains[domain].model_copy(update=patch)
        return EnvSettings(**domains)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"EnvSettings(app_env={self.server.app_env!r})"


def load_env(env_file: str | None = None) -> EnvSettings:
    """Read env settings. ``KH_ENV_FILE`` opts into a dotenv file (never bundled)."""
    if env_file is None:
        env_file = os.environ.get("KH_ENV_FILE") or None
    return EnvSettings(env_file)


__all__ = ["EnvSettings", "load_env"]

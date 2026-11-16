"""Nacos server + AI registry settings (``NACOS_*``).

``label`` is the publishing label used by the Nacos 3.x AI registry
(``prompt`` / ``agentspecs`` / ``skills``); production publishes under
``production``. ``ttl`` is the in-process cache TTL in seconds; ``<= 0``
disables caching so a lab deployment can always read the freshest spec.
"""

from __future__ import annotations

from pydantic import Field, field_validator
from pydantic_settings import SettingsConfigDict

from knowledge_hub.config.base import DomainSettings


class NacosSettings(DomainSettings):
    model_config = SettingsConfigDict(
        extra="ignore", case_sensitive=False, env_file=None, env_prefix="NACOS_"
    )

    server: str = "http://127.0.0.1:8848/nacos"
    namespace: str = "public"
    group: str = "DEFAULT_GROUP"
    data_id: str = "knowledge-hub.yaml"
    username: str = ""
    password: str = ""
    ttl: int = 300
    timeout_ms: int = Field(default=1500, gt=0)
    label: str = "production"

    @field_validator("server")
    @classmethod
    def _strip_trailing_slash(cls, value: str) -> str:
        return (value or "").rstrip("/")

    @property
    def configured(self) -> bool:
        return bool(self.server)

    @property
    def base_url(self) -> str:
        """``http://host:8848/nacos`` - the prefix every Nacos API lives under."""
        base = (self.server or "").rstrip("/")
        if not base:
            return ""
        if not base.endswith("/nacos"):
            base = f"{base}/nacos"
        return base

    @property
    def tenant(self) -> str | None:
        """``public`` is the default namespace and must not be sent."""
        name = (self.namespace or "").strip()
        if not name or name.lower() == "public":
            return None
        return name

    @property
    def timeout_s(self) -> float:
        return max(0.1, self.timeout_ms / 1000.0)

    @property
    def cache_ttl_s(self) -> float:
        return max(0.0, float(self.ttl))


__all__ = ["NacosSettings"]

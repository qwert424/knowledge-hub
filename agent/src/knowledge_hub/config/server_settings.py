"""HTTP server, security and worker settings.

The variables in this module have no shared prefix in ``.env`` (``APP_ENV``,
``LOG_LEVEL``, ``RAG_ENGINE_PORT``, ``BACKEND_BASE_URL``, ``JWT_*``,
``INTERNAL_SERVICE_TOKEN``), so the class deliberately declares no
``env_prefix`` and relies on the field names being the lower-case env names.
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import SettingsConfigDict

from knowledge_hub.config.base import DomainSettings


class ServerSettings(DomainSettings):
    """Process, port and inbound/outbound service identity."""

    app_env: str = "local"
    log_level: str = "INFO"

    rag_engine_port: int = 8100
    backend_base_url: str = "http://127.0.0.1:8088"
    internal_service_token: str = ""

    jwt_secret: str = ""
    jwt_private_key_path: str = ""
    jwt_public_key_path: str = ""
    jwt_issuer: str = "knowledge-hub"
    retrieval_ticket_ttl_seconds: int = Field(default=300, gt=0)

    @property
    def callbacks_enabled(self) -> bool:
        """True when Java progress callbacks can be signed and delivered."""
        return bool(self.backend_base_url and self.internal_service_token)


class WorkerSettings(DomainSettings):
    """Redis Stream consumer tuning (``WORKER_*``)."""

    model_config = SettingsConfigDict(
        extra="ignore", case_sensitive=False, env_file=None, env_prefix="WORKER_"
    )

    group: str = "kh-workers"
    consumer: str = ""
    max_attempts: int = 3
    idem_ttl_seconds: int = 86400
    block_ms: int = 5000
    batch: int = 1


__all__ = ["ServerSettings", "WorkerSettings"]

"""Redis settings (``KH_REDIS_*``) used by the stream worker and health probes."""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import SettingsConfigDict

from knowledge_hub.config.base import DomainSettings


class RedisSettings(DomainSettings):
    model_config = SettingsConfigDict(
        extra="ignore", case_sensitive=False, env_file=None, env_prefix="KH_REDIS_"
    )

    host: str = "127.0.0.1"
    port: int = Field(default=6380, gt=0)
    password: str = ""
    db: int = Field(default=0, ge=0)

    @property
    def url(self) -> str:
        """``redis://[:password@]host:port/db`` - the only place the DSN is built."""
        auth = f":{self.password}@" if self.password else ""
        return f"redis://{auth}{self.host}:{self.port}/{self.db}"


__all__ = ["RedisSettings"]

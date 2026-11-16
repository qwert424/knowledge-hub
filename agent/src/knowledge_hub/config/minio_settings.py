"""MinIO / S3 compatible object storage (``MINIO_*``).

``public_endpoint`` is intentionally *only* used when building a URL that a
browser has to reach (presigned links, citation ``source_url``); internal
downloads always go through ``endpoint`` so container DNS is never leaked into
the UI.
"""

from __future__ import annotations

from pydantic_settings import SettingsConfigDict

from knowledge_hub.config.base import DomainSettings


class MinioSettings(DomainSettings):
    model_config = SettingsConfigDict(
        extra="ignore", case_sensitive=False, env_file=None, env_prefix="MINIO_"
    )

    endpoint: str = "http://127.0.0.1:9000"
    # Browser-visible base URL; empty means "same as endpoint".
    public_endpoint: str = ""
    access_key: str = ""
    secret_key: str = ""
    bucket: str = "knowledge-hub"
    region: str = "us-east-1"
    secure: bool = False

    @property
    def configured(self) -> bool:
        return bool(self.endpoint and self.access_key and self.secret_key)

    @property
    def browser_endpoint(self) -> str:
        return (self.public_endpoint or self.endpoint).rstrip("/")

    def public_url(self, key: str, *, bucket: str = "") -> str:
        """Object URL built from ``public_endpoint`` (never from ``endpoint``)."""
        name = bucket or self.bucket
        return f"{self.browser_endpoint}/{name.lstrip('/')}/{str(key).lstrip('/')}"


__all__ = ["MinioSettings"]

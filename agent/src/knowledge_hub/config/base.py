"""Shared base class for every per-domain settings module.

Each domain module owns exactly one ``BaseSettings`` subclass, so a missing or
malformed variable can never poison an unrelated domain. Field names are the
lower-case form of the env var name (``MILVUS_URI`` -> ``MilvusSettings.uri``
with ``env_prefix="MILVUS_"``), which keeps the existing ``.env`` names intact.

Every field has a default: importing :mod:`knowledge_hub.config` must never
require a single environment variable to be present (the engine boots offline).
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class DomainSettings(BaseSettings):
    """``BaseSettings`` with the project-wide policy (ignore unknown keys)."""

    model_config = SettingsConfigDict(
        extra="ignore",
        case_sensitive=False,
        env_file=None,
        validate_default=True,
    )


__all__ = ["DomainSettings"]

"""Shared fixtures. No network is touched: Milvus/LiteLLM are stubbed per test."""

from __future__ import annotations

import time
from typing import Any

import jwt
import pytest

from knowledge_hub.config.llm_settings import LLMSettings
from knowledge_hub.config.milvus_settings import MilvusSettings
from knowledge_hub.config.nacos_settings import NacosSettings
from knowledge_hub.config.redis_settings import RedisSettings
from knowledge_hub.config.server_settings import ServerSettings, WorkerSettings
from knowledge_hub.config.settings import AppConfig, EnvSettings, Settings

ISSUER = "knowledge-hub"
TEST_SECRET = "unit-test-secret-0123456789abcdef-unit-test"


@pytest.fixture
def env_settings() -> EnvSettings:
    return EnvSettings(
        server=ServerSettings(
            app_env="test",
            backend_base_url="http://127.0.0.1:8088",
            internal_service_token="internal-test-token",
            jwt_secret=TEST_SECRET,
            jwt_issuer=ISSUER,
        ),
        milvus=MilvusSettings(uri="http://127.0.0.1:19530", db_name="default"),
        nacos=NacosSettings(server=""),
        llm=LLMSettings(
            litellm_base_url="http://127.0.0.1:4000/v1",
            litellm_api_key="test-key",
            openai_default_model="test-chat",
            openai_embedding_model="test-embed",
            embedding_dim=8,
        ),
        redis=RedisSettings(host="127.0.0.1", port=6380),
        worker=WorkerSettings(consumer="test-consumer", max_attempts=2, block_ms=100),
    )


@pytest.fixture
def app_config() -> AppConfig:
    config = AppConfig()
    config.llm.chat_model = "test-chat"
    config.embedding.dimensions = 8
    config.embedding.batch_size = 2
    config.chunking.chunk_size = 200
    config.chunking.chunk_overlap = 40
    config.chunking.min_chunk_chars = 20
    config.chunking.quality.min_tokens = 5
    config.chunking.quality.max_tokens = 400
    config.retrieval.top_k = 3
    config.retrieval.dense.top_k = 5
    config.retrieval.sparse.top_k = 5
    config.jev.timeout_ms = 500
    config.jev.min_confidence = 0.55
    return config


@pytest.fixture
def settings(env_settings: EnvSettings, app_config: AppConfig) -> Settings:
    return Settings(env_settings, app_config, nacos_ok=True, source="test")


def make_ticket(
    env: EnvSettings,
    *,
    tenant: str = "t_001",
    user: str = "u_123",
    principals: tuple[str, ...] = ("user:u_123", "tenant:all"),
    kb_ids: tuple[str, ...] = ("kb_001",),
    scope: str = "ticket",
    expires_in: int = 300,
    issuer: str = ISSUER,
    secret: str | None = None,
    algorithm: str = "HS256",
    key: Any | None = None,
    extra: dict[str, Any] | None = None,
) -> str:
    now = int(time.time())
    claims: dict[str, Any] = {
        "sub": user,
        "tid": tenant,
        "usr": "tester",
        "scope": scope,
        "principals": list(principals),
        "kb_ids": list(kb_ids),
        "roles": ["staff"],
        "iss": issuer,
        "iat": now,
        "exp": now + expires_in,
    }
    if extra:
        claims.update(extra)
    return jwt.encode(claims, key or secret or env.server.jwt_secret, algorithm=algorithm)

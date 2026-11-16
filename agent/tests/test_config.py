"""Configuration layering: placeholders, env overrides, Nacos failure tolerance."""

from __future__ import annotations

import httpx
import pytest

from knowledge_hub.config import settings as settings_module
from knowledge_hub.config.nacos import NacosClient, NacosError
from knowledge_hub.config.settings import EnvSettings, load_settings, resolve_placeholders


def test_placeholders_use_env_then_default() -> None:
    env = {"EMBEDDING_DIM": "512"}
    resolved = resolve_placeholders(
        {"dim": "${EMBEDDING_DIM:1024}", "model": "${OPENAI_DEFAULT_MODEL:gpt-4.1-mini}"}, env
    )
    assert resolved == {"dim": "512", "model": "gpt-4.1-mini"}


def test_placeholders_resolve_recursively() -> None:
    env = {"A": "${B:fallback}", "B": "final"}
    assert resolve_placeholders({"value": "${A:x}"}, env) == {"value": "final"}


def test_load_settings_defaults_without_nacos(env_settings: EnvSettings) -> None:
    env = env_settings.replace(nacos__server="")
    settings = load_settings(env=env, fetch_nacos=False, environ={})
    assert settings.llm.chat_model == "gpt-4.1-mini"
    assert settings.embedding.dimensions == 1024
    assert settings.retrieval.fusion.strategy == "rrf"
    assert settings.jev.timeout_ms == 3000
    assert settings.nacos_ok is False
    assert settings.errors


def test_env_overrides_nacos_values(env_settings: EnvSettings) -> None:
    env = env_settings.replace(nacos__server="")
    settings = load_settings(
        env=env,
        fetch_nacos=False,
        environ={"OPENAI_DEFAULT_MODEL": "custom-chat", "EMBEDDING_DIM": "512"},
    )
    assert settings.llm.chat_model == "custom-chat"
    assert settings.embedding.dimensions == 512


def test_nacos_failure_falls_back_to_defaults(
    env_settings: EnvSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    env = env_settings.replace(nacos__server="http://nacos.invalid:8848")

    def boom(self: NacosClient, data_id: str, group: str = "DEFAULT_GROUP") -> str:
        raise NacosError("nacos unreachable: ConnectError")

    monkeypatch.setattr(NacosClient, "fetch", boom)
    settings = load_settings(env=env, fetch_nacos=True, environ={})
    assert settings.nacos_ok is False
    assert any("nacos" in error for error in settings.errors)
    assert settings.llm.chat_model == "gpt-4.1-mini"


def test_nacos_values_are_merged(env_settings: EnvSettings, monkeypatch: pytest.MonkeyPatch) -> None:
    env = env_settings.replace(nacos__server="http://nacos.invalid:8848")
    remote = "chunking:\n  chunk_size: 777\nretrieval:\n  top_k: 5\n"
    monkeypatch.setattr(NacosClient, "fetch", lambda self, data_id, group="DEFAULT_GROUP": remote)
    settings = load_settings(env=env, fetch_nacos=True, environ={})
    assert settings.nacos_ok is True
    assert settings.chunking.chunk_size == 777
    assert settings.chunking.chunk_overlap == 200
    assert settings.retrieval.top_k == 5


def test_nacos_client_login_retry() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path.endswith("/v3/auth/user/login"):
            return httpx.Response(200, json={"accessToken": "token-123"})
        if request.url.path.endswith("/v3/admin/cs/config"):
            if request.headers.get("accessToken") != "token-123":
                return httpx.Response(403, text="no auth")
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "dataId": "knowledge-hub.yaml",
                        "groupName": "DEFAULT_GROUP",
                        "content": "llm:\n  temperature: 0.5\n",
                    },
                },
            )
        return httpx.Response(404, text="No endpoint")

    client = NacosClient(
        "http://nacos.local:8848",
        username="nacos",
        password="nacos",
        transport=httpx.MockTransport(handler),
    )

    assert "temperature" in client.fetch("knowledge-hub.yaml")
    assert calls[0].endswith("/v3/auth/user/login")
    assert all(path.startswith("/nacos/") for path in calls)


def test_nacos_client_falls_back_to_v2_when_v3_endpoint_missing() -> None:
    """Nacos 2.x has no /v3/admin/cs/config; the raw body comes from /v1/cs/configs."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/v3/admin/cs/config"):
            return httpx.Response(404, text='{"message":"No endpoint GET /nacos/v3/admin/cs/config"}')
        if request.url.path.endswith("/v1/cs/configs"):
            return httpx.Response(200, text="embedding:\n  dimensions: 512\n")
        return httpx.Response(404, text="No endpoint")

    client = NacosClient("http://nacos.local:8848", transport=httpx.MockTransport(handler))

    assert "dimensions: 512" in client.fetch("knowledge-hub.yaml")


def test_nacos_client_reports_missing_config() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"code": 20004, "message": "config data not exist"})

    client = NacosClient("http://nacos.local:8848", transport=httpx.MockTransport(handler))

    with pytest.raises(NacosError) as excinfo:
        client.fetch("knowledge-hub.yaml")
    assert "not found" in str(excinfo.value)


def test_nacos_client_health_uses_v3_state() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/v3/admin/core/state"):
            return httpx.Response(200, json={"code": 0, "data": {}})
        return httpx.Response(404, text="No endpoint")

    client = NacosClient("http://nacos.local:8848", transport=httpx.MockTransport(handler))

    assert client.health() is True


def test_nacos_client_reports_empty_config() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="  ")

    client = NacosClient("http://nacos.local:8848", transport=httpx.MockTransport(handler))
    with pytest.raises(NacosError):
        client.fetch("knowledge-hub.yaml")


def test_nacos_client_normalizes_base_url() -> None:
    assert NacosClient("http://127.0.0.1:8848").base_url == "http://127.0.0.1:8848/nacos"
    assert NacosClient("http://127.0.0.1:8848/nacos/").base_url == "http://127.0.0.1:8848/nacos"


def test_settings_public_hides_secrets(env_settings: EnvSettings, app_config) -> None:
    settings = settings_module.Settings(env_settings, app_config, nacos_ok=True, source="test")
    public = settings.public()
    text = repr(public)
    assert env_settings.server.jwt_secret not in text
    assert env_settings.llm.litellm_api_key not in text
    assert "litellm_api_key" not in text

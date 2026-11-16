"""Nacos AI registry: AgentSpec resolution, prompt composition, fallbacks."""

from __future__ import annotations

import json

import httpx

from knowledge_hub.config.agent_spec import AgentSpec
from knowledge_hub.config.nacos import NacosClient
from knowledge_hub.config.nacos_ai import NacosAIRegistry, resolve_agent_spec
from knowledge_hub.config.settings import EnvSettings, load_settings
from knowledge_hub.engine.prompts import build_messages, compose_system_prompt


def _registry(routes: dict[str, object]) -> NacosAIRegistry:
    def handler(request: httpx.Request) -> httpx.Response:
        for suffix, payload in routes.items():
            if request.url.path.endswith(suffix):
                if isinstance(payload, httpx.Response):
                    return payload
                return httpx.Response(200, json=payload)
        return httpx.Response(404, json={"code": 404, "message": "not found"})

    transport = httpx.MockTransport(handler)
    client = NacosClient("http://nacos.local:8848", transport=transport)
    return NacosAIRegistry(client, transport=transport)


def _agentspec_payload(name: str = "knowledge-hub-agent") -> dict[str, object]:
    content = json.dumps(
        {
            "description": "知识库问答 Agent",
            "model": {"name": "chat-standard", "thinking": False, "temperature": 0.3},
            "skills": ["pptx"],
            "mcps": [],
            "tools": ["milvus_search", "fetch_url"],
            "subagents": ["retrieve_agent"],
            "link_prompts": ["shared-policy"],
        },
        ensure_ascii=False,
    )
    return {
        "code": 0,
        "data": {
            "content": content,
            "resource": {f"instruction_{name}/AGENTS__MD": {"content": "你是企业知识助手。"}},
        },
    }


def test_agentspec_merges_instruction_model_and_linked_prompts() -> None:
    registry = _registry(
        {
            "/v3/client/ai/agentspecs": _agentspec_payload(),
            "/v3/client/ai/prompt": {"code": 0, "data": {"template": "引用必须标注来源。"}},
        }
    )
    spec = registry.agentspec("knowledge-hub-agent")

    assert spec.system_prompt == "你是企业知识助手。\n\n引用必须标注来源。"
    assert spec.model.name == "chat-standard"
    assert spec.model.temperature == 0.3
    assert spec.tools == ["milvus_search", "fetch_url"]
    assert spec.subagents == ["retrieve_agent"]
    assert spec.link_prompts == ["shared-policy"]
    assert spec.source == "nacos"


def test_agentspec_without_registry_falls_back() -> None:
    spec, note = resolve_agent_spec(
        None, name="knowledge-hub-agent", fallback_prompt="内置提示词", default_model="chat-basic"
    )

    assert spec.source == "fallback"
    assert spec.system_prompt == "内置提示词"
    assert spec.model.name == "chat-basic"
    assert note is not None


def test_agentspec_missing_from_registry_falls_back() -> None:
    registry = _registry({"/v3/client/ai/agentspecs": {"code": 404, "message": "absent"}})
    spec, note = resolve_agent_spec(registry, name="knowledge-hub-agent", default_model="chat-basic")

    assert spec.source == "fallback"
    assert spec.model.name == "chat-basic"
    assert note is not None and "agentspec" in note


def test_linked_prompt_failure_keeps_instruction() -> None:
    registry = _registry(
        {
            "/v3/client/ai/agentspecs": _agentspec_payload(),
            "/v3/client/ai/prompt": httpx.Response(500, text="boom"),
        }
    )
    spec = registry.agentspec("knowledge-hub-agent")

    assert spec.system_prompt == "你是企业知识助手。"


def test_spec_prompt_never_drops_grounding_rules() -> None:
    prompt = compose_system_prompt("你是财务文档助手。")
    assert prompt.startswith("你是财务文档助手。")
    assert "<untrusted_context>" in prompt
    assert "资料不足" in prompt

    messages = build_messages(query="预算多少？", chunks=[], system_prompt="你是财务文档助手。")
    system = messages[0]["content"]
    assert "你是财务文档助手。" in system
    assert "资料不足" in system


def test_empty_spec_prompt_uses_default_persona() -> None:
    assert compose_system_prompt("").startswith("你是 Knowledge Hub 的知识问答助手。")


def test_load_settings_attaches_spec_and_prefers_its_model(
    env_settings: EnvSettings, monkeypatch
) -> None:
    spec = AgentSpec(
        name="knowledge-hub-agent",
        system_prompt="你是企业知识助手。",
        model={"name": "chat-standard", "thinking": False},
        tools=["milvus_search"],
        source="nacos",
    )
    monkeypatch.setattr(NacosAIRegistry, "agentspec", lambda self, name, label="production": spec)
    env = env_settings.replace(nacos__server="http://nacos.local:8848")

    settings = load_settings(env=env, fetch_nacos=True, environ={})

    assert settings.agent_spec.source == "nacos"
    assert settings.agent_spec_prompt == "你是企业知识助手。"
    assert settings.chat_model == "chat-standard"
    assert settings.public()["agent"]["tools"] == ["milvus_search"]

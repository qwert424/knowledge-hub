"""Agent specification schema (Nacos 3.x AI registry ``agentspecs``).

Mirrors the AgentSpec the RAG project publishes under ``/nacos/v3/client/ai/
agentspecs`` so both platforms describe an agent the same way::

    {
      "description": "ragAgent配置",
      "model": { "name": "chat-standard", "thinking": false },
      "skills": [], "mcps": [], "subagents": [], "link_prompts": [],
      "tools": ["milvus_search", "fetch_url", "web_search"]
    }

The system prompt itself is *not* part of that JSON: Nacos stores it as the
AgentSpec resource ``instruction_{name}/AGENTS__MD``, and ``link_prompts``
reference separate prompt resources that are concatenated after it.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class AgentModelConfig(BaseModel):
    """Model alias the gateway (LiteLLM) exposes, plus sampling hints."""

    name: str = ""
    #: AgentSpec 里写 true/false，也兼容 {"type": "enabled"|"disabled"}（Langfuse 习惯写法）
    thinking: bool | str | dict = False
    temperature: float | None = None
    top_p: float | None = None

    @property
    def thinking_enabled(self) -> bool:
        """归一化为布尔值；脏配置一律当"关闭"，不让网关报 400。"""
        value = self.thinking
        if isinstance(value, bool):
            return value
        if isinstance(value, dict):
            value = value.get("type", "")
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"enabled", "true", "on", "yes", "1"}:
                return True
        return False


class MCPServerConfig(BaseModel):
    name: str
    url: str = ""
    disabled_tools: list[str] = Field(default_factory=list)


class AgentSpec(BaseModel):
    name: str
    description: str = ""
    system_prompt: str = ""
    model: AgentModelConfig = Field(default_factory=AgentModelConfig)
    mcps: dict[str, MCPServerConfig] = Field(default_factory=dict)
    tools: list[str] = Field(default_factory=list)
    subagents: list[str] = Field(default_factory=list)
    link_prompts: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    #: ``nacos`` when the registry answered, ``fallback`` when it did not.
    source: str = "fallback"

    @property
    def prompt_configured(self) -> bool:
        return bool(self.system_prompt.strip())


__all__ = ["AgentModelConfig", "AgentSpec", "MCPServerConfig"]

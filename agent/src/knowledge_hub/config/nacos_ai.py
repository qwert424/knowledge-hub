"""Nacos 3.x AI registry: AgentSpec, prompts, skills and MCP descriptors.

Read-only and best-effort: every method returns ``None`` (or an empty result)
instead of raising when the registry is unreachable, so the engine keeps running
on its bundled defaults. Only :class:`NacosAIError` escapes - and only from
:meth:`NacosAIRegistry.agentspec`, whose caller turns it into a ``degraded`` note.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx

from knowledge_hub.config.agent_spec import AgentModelConfig, AgentSpec, MCPServerConfig
from knowledge_hub.config.nacos import NacosClient

logger = logging.getLogger(__name__)

_INSTRUCTION_SUFFIX = "AGENTS__MD"


class NacosAIError(RuntimeError):
    """The AI registry is unreachable or returned an unusable AgentSpec."""


class NacosAIRegistry:
    """Thin sync wrapper over ``/nacos/v3/client/ai/*`` and ``/admin/ai/mcp``."""

    def __init__(
        self,
        client: NacosClient,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._nacos = client
        self._transport = transport

    # ----------------------------------------------------------------- helpers
    def _params(self, **extra: Any) -> dict[str, Any]:
        params: dict[str, Any] = {}
        tenant = self._nacos.tenant_param()
        if tenant:
            params["namespaceId"] = tenant
        params.update({k: v for k, v in extra.items() if v not in (None, "")})
        return params

    def _headers(self) -> dict[str, str]:
        token = self._nacos.access_token()
        return {"accessToken": token} if token else {}

    def _get(self, path: str, params: dict[str, Any]) -> httpx.Response | None:
        url = f"{self._nacos.base_url}{path}"
        try:
            with httpx.Client(timeout=self._nacos.timeout_s, transport=self._transport) as client:
                return client.get(url, params=params, headers=self._headers())
        except httpx.HTTPError as exc:
            logger.info("nacos ai registry unreachable (%s): %s", path, type(exc).__name__)
            return None

    def _get_json(self, path: str, params: dict[str, Any]) -> dict[str, Any] | None:
        resp = self._get(path, params)
        if resp is None or resp.status_code != 200:
            return None
        try:
            payload = resp.json()
        except ValueError:
            return None
        if not isinstance(payload, dict) or payload.get("code") not in (0, "0"):
            return None
        data = payload.get("data")
        return data if isinstance(data, dict) else None

    # ------------------------------------------------------------------- agent
    #: Nacos 3.x 的 AgentSpec 生产标签叫 ``product``，早期文档/旧项目写的是 ``production``。
    #: 标签优先级：production 是线上标签；product 是历史别名（只兜底一次并打日志）；不用 latest。
    LABEL_FALLBACKS = ("production", "product")

    def _label_candidates(self, label: str) -> list[str]:
        ordered = [label, *self.LABEL_FALLBACKS]
        seen: list[str] = []
        for item in ordered:
            value = (item or "").strip()
            if value and value not in seen:
                seen.append(value)
        return seen

    def agentspec(self, name: str, label: str = "production") -> AgentSpec:
        """Fetch one AgentSpec, resolving its instruction and linked prompts."""
        if not name:
            raise NacosAIError("agent name is empty")
        data = None
        used_label = label
        for candidate in self._label_candidates(label):
            data = self._get_json(
                "/v3/client/ai/agentspecs", self._params(name=name, label=candidate)
            )
            if data is not None:
                used_label = candidate
                break
        if data is None:
            raise NacosAIError(f"agentspec {name!r} not found (label={label})")
        if used_label != label:
            logger.info("agentspec %s resolved with label=%s (configured %s)", name, used_label, label)
        label = used_label

        config = _json_object(data.get("content"))
        config["name"] = name
        config["mcps"] = self.mcps(config.get("mcps"))

        instruction = self._instruction(data.get("resource"), name) or config.get(
            "system_prompt", ""
        )
        linked = self.prompts(config.get("link_prompts"), label=label)
        config["system_prompt"] = "\n\n".join(
            part for part in (instruction.strip(), linked.strip()) if part
        )
        config["source"] = "nacos"
        return AgentSpec.model_validate(config)

    @staticmethod
    def _instruction(resource: Any, name: str) -> str:
        """Nacos stores the system prompt as ``instruction_{name}/AGENTS__MD``."""
        if not isinstance(resource, dict):
            return ""
        for key, value in resource.items():
            if not str(key).startswith("instruction_") or not isinstance(value, dict):
                continue
            if not str(key).endswith(_INSTRUCTION_SUFFIX):
                continue
            content = value.get("content")
            if isinstance(content, str) and content.strip():
                return content
        return ""

    # ------------------------------------------------------------------ prompt
    def prompt(self, key: str, label: str = "production") -> str:
        # 提示词的标签在某些库里叫 production、某些叫 product：逐个试，避免取不到就静默丢提示词
        for candidate in self._label_candidates(label):
            data = self._get_json(
                "/v3/client/ai/prompt", self._params(promptKey=key, label=candidate)
            )
            if data is not None and isinstance(data.get("template"), str) and data["template"].strip():
                return data["template"]
        logger.info("nacos prompt %r not available", key)
        return ""

    def prompts(self, keys: Any, label: str = "production") -> str:
        if not isinstance(keys, list):
            return ""
        parts = [self.prompt(str(key), label=label) for key in keys if str(key).strip()]
        return "\n\n".join(part for part in parts if part)

    # -------------------------------------------------------------------- mcp
    def mcp(self, name: str) -> MCPServerConfig | None:
        data = self._get_json("/v3/admin/ai/mcp", self._params(mcpName=name))
        if data is None:
            return None
        endpoints = data.get("backendEndpoints")
        if not isinstance(endpoints, list) or not endpoints:
            return None
        backend = endpoints[0] if isinstance(endpoints[0], dict) else {}
        url = "{protocol}://{address}:{port}{path}".format(
            protocol=backend.get("protocol") or "http",
            address=backend.get("address") or "",
            port=backend.get("port") or "",
            path=backend.get("path") or "",
        )
        metadata = data.get("toolSpec", {})
        tools_meta = metadata.get("toolsMeta", {}) if isinstance(metadata, dict) else {}
        disabled = [
            tool
            for tool, value in (tools_meta or {}).items()
            if isinstance(value, dict) and not value.get("enabled", True)
        ]
        return MCPServerConfig(name=name, url=url, disabled_tools=disabled)

    def mcps(self, names: Any) -> dict[str, MCPServerConfig]:
        if not isinstance(names, list):
            return {}
        resolved: dict[str, MCPServerConfig] = {}
        for raw in names:
            name = str(raw).strip()
            if not name:
                continue
            config = self.mcp(name)
            if config is not None:
                resolved[name] = config
        return resolved

    # ------------------------------------------------------------------- skill
    def skill_archive(self, name: str, label: str = "production") -> bytes | None:
        """Raw skill zip; the caller decides where to unpack it (sandbox volume)."""
        resp = self._get("/v3/client/ai/skills", self._params(name=name, label=label))
        if resp is None or resp.status_code != 200 or not resp.content:
            return None
        return resp.content


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except ValueError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def resolve_agent_spec(
    registry: NacosAIRegistry | None,
    *,
    name: str,
    label: str = "product",
    fallback_prompt: str = "",
    default_model: str = "",
) -> tuple[AgentSpec, str | None]:
    """Never raises: returns the spec plus an optional degradation note."""
    if registry is None:
        return (
            AgentSpec(
                name=name,
                system_prompt=fallback_prompt,
                model=AgentModelConfig(name=default_model),
                source="fallback",
            ),
            "agent: nacos AI registry not configured",
        )
    try:
        return registry.agentspec(name, label=label), None
    except (NacosAIError, ValueError) as exc:
        return (
            AgentSpec(
                name=name,
                system_prompt=fallback_prompt,
                model=AgentModelConfig(name=default_model),
                source="fallback",
            ),
            f"agent: {exc}",
        )


__all__ = ["NacosAIError", "NacosAIRegistry", "resolve_agent_spec"]


# --------------------------------------------------------------------- text prompts
_TEXT_TTL_S = 60.0
_text_cache: dict[str, tuple[float, str]] = {}
_text_registry: NacosAIRegistry | None = None
_text_registry_loaded = False


def _registry_for_text() -> NacosAIRegistry | None:
    """按环境变量建一个轻量 Nacos 客户端；没配 Nacos 就返回 None。"""
    global _text_registry, _text_registry_loaded
    if _text_registry_loaded:
        return _text_registry
    _text_registry_loaded = True
    try:
        from knowledge_hub.config.env import load_env  # noqa: PLC0415 - 避开循环引用

        env = load_env()
        nacos = env.nacos
        if nacos is None or not nacos.server:
            return None
        _text_registry = NacosAIRegistry(
            NacosClient(
                nacos.server,
                username=nacos.username,
                password=nacos.password,
                namespace=nacos.namespace,
                timeout_s=nacos.timeout_ms / 1000.0,
            )
        )
    except Exception as exc:  # noqa: BLE001 - 拿不到就用代码里的文本
        logger.info("nacos text prompts unavailable: %s", type(exc).__name__)
        _text_registry = None
    return _text_registry


def text_prompt(key: str, fallback: str) -> str:
    """从 Nacos 取一段提示词；取不到（没配置/超时/key 被误删）就用代码里的 fallback。

    60 秒进程内缓存，Nacos 改完不用重启。
    """
    now = time.monotonic()
    hit = _text_cache.get(key)
    if hit and now - hit[0] < _TEXT_TTL_S:
        return hit[1]
    registry = _registry_for_text()
    text = ""
    if registry is not None:
        try:
            text = (registry.prompt(key) or "").strip()
        except Exception as exc:  # noqa: BLE001
            logger.info("nacos prompt %r failed: %s", key, type(exc).__name__)
    if not text:
        text = fallback
    _text_cache[key] = (now, text)
    return text


def clear_text_prompt_cache() -> None:
    _text_cache.clear()

"""Configuration facade: env domains + Nacos sections -> one immutable snapshot.

Order (docs/12 §2): Nacos ``knowledge-hub.yaml`` -> environment overrides
(``${ENV:default}`` placeholders) -> bundled defaults in ``agent/config``.

The engine must boot with defaults when Nacos is unreachable; every failure is
recorded on :class:`Settings` and surfaced by ``GET /health`` as ``degraded``.

Module layout (no single class owns every variable):

===================  =====================================================
``env.py``           per-domain env settings (composition, not a flat bag)
``llm_settings.py``  gateway + model aliases
``sections.py``      Nacos-owned behaviour sections
``resolve.py``       merge / placeholder / override rules
``nacos.py``         config-center client
===================  =====================================================
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import yaml
from pydantic import ValidationError

from knowledge_hub.config.agent_spec import AgentSpec
from knowledge_hub.config.env import EnvSettings, load_env
from knowledge_hub.config.llm_settings import EmbeddingSection, LLMSection, LLMSettings
from knowledge_hub.config.milvus_settings import MilvusSettings
from knowledge_hub.config.minio_settings import MinioSettings
from knowledge_hub.config.nacos import NacosClient, NacosError
from knowledge_hub.config.nacos_ai import NacosAIRegistry, resolve_agent_spec
from knowledge_hub.config.nacos_settings import NacosSettings
from knowledge_hub.config.neo4j_settings import Neo4jSettings
from knowledge_hub.config.redis_settings import RedisSettings
from knowledge_hub.config.resolve import (
    apply_env_overrides,
    deep_merge,
    resolve_placeholders,
)
from knowledge_hub.config.sections import (
    AgentSection,
    AppConfig,
    ChunkingQuality,
    ChunkingSection,
    DenseSection,
    FusionSection,
    GraphSection,
    IndexSection,
    JevSection,
    RerankSection,
    RetrievalSection,
    SparseSection,
)
from knowledge_hub.config.server_settings import ServerSettings, WorkerSettings

logger = logging.getLogger(__name__)

AGENT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONFIG_PATH = AGENT_ROOT / "config" / "knowledge-hub.yaml"


class Settings:
    """Immutable snapshot of env + Nacos sections plus load diagnostics."""

    def __init__(
        self,
        env: EnvSettings,
        app: AppConfig,
        *,
        nacos_ok: bool = False,
        source: str = "defaults",
        errors: tuple[str, ...] = (),
        loaded_at: float | None = None,
        agent_spec: AgentSpec | None = None,
        chat_policy: str = "",
        image_caption_prompt: str = "",
    ) -> None:
        self.env = env
        self.app = app
        self.nacos_ok = nacos_ok
        self.source = source
        self.errors = errors
        self.loaded_at = loaded_at or time.time()
        # AgentSpec resolved from the Nacos AI registry (prompt/model/tools/skills).
        self.agent_spec = agent_spec or AgentSpec(name=app.agent.name, source="fallback")
        #: Extra policy for the deterministic retrieval path (Nacos prompt resource).
        self.chat_policy = chat_policy
        #: 图片理解提示词（Nacos prompt）；空字符串表示用代码里的兼底提示词
        self.image_caption_prompt = image_caption_prompt

    @property
    def image_parser(self):  # noqa: ANN201 - 直接转发，避免每处写 settings.app.image_parser
        return self.app.image_parser

    @property
    def agent_spec_prompt(self) -> str:
        return self.agent_spec.system_prompt

    @property
    def base_prompt(self) -> str:
        """系统提示词唯一来源：Nacos AgentSpec（AGENTS.md + link_prompts）优先，其次 Nacos prompt 资源。

        确定性检索链路和 Agent 链路都必须用这一份，否则会出现"管理台改了 AGENTS.md，
        线上回答却还在用代码里的默认人设"，Langfuse 里也看不到这段指令。
        """
        return (self.agent_spec.system_prompt or self.chat_policy or "").strip()

    @property
    def agent_spec_source(self) -> str:
        return self.agent_spec.source

    @property
    def chat_model(self) -> str:
        """AgentSpec wins; the Nacos ``llm.chat_model`` alias is the fallback."""
        return self.agent_spec.model.name or self.app.llm.chat_model

    # section shortcuts (exactly the Nacos sections)
    @property
    def llm(self) -> LLMSection:
        return self.app.llm

    @property
    def embedding(self) -> EmbeddingSection:
        return self.app.embedding

    @property
    def chunking(self) -> ChunkingSection:
        return self.app.chunking

    @property
    def retrieval(self) -> RetrievalSection:
        return self.app.retrieval

    @property
    def jev(self) -> JevSection:
        return self.app.jev

    @property
    def index(self) -> IndexSection:
        return self.app.index

    @property
    def agent(self) -> AgentSection:
        return self.app.agent

    @property
    def degraded(self) -> bool:
        return bool(self.errors)

    def with_env(self, env: EnvSettings) -> Settings:
        return Settings(
            env,
            self.app,
            nacos_ok=self.nacos_ok,
            source=self.source,
            errors=self.errors,
            loaded_at=self.loaded_at,
            agent_spec=self.agent_spec,
            chat_policy=self.chat_policy,
        )

    def public(self) -> dict[str, Any]:
        """Secret-free view for ``/health`` and ``/v1/admin/reload``."""
        return {
            "source": self.source,
            "nacos_ok": self.nacos_ok,
            "loaded_at": self.loaded_at,
            "errors": list(self.errors),
            "llm": {"chat_model": self.llm.chat_model, "base_url": self.llm.base_url},
            "embedding": {
                "model": self.embedding.model,
                "dimensions": self.embedding.dimensions,
                "batch_size": self.embedding.batch_size,
            },
            "chunking": {
                "template": self.chunking.template,
                "chunk_size": self.chunking.chunk_size,
                "chunk_overlap": self.chunking.chunk_overlap,
            },
            "retrieval": self.retrieval.model_dump(),
            "jev": {
                "enabled": self.jev.enabled,
                "model": self.jev.model,
                "min_confidence": self.jev.min_confidence,
                "scenes": dict(self.jev.scenes),
            },
            "index": self.index.model_dump(),
            "agent": {
                "name": self.agent.name,
                "label": self.agent.label,
                "spec_source": self.agent_spec.source,
                "model": self.agent_spec.model.name,
                "prompt_configured": self.agent_spec.prompt_configured,
                "tools": list(self.agent_spec.tools),
                "subagents": list(self.agent_spec.subagents),
                "skills": list(self.agent_spec.skills),
                "mcps": sorted(self.agent_spec.mcps),
                "link_prompts": list(self.agent_spec.link_prompts),
                "chat_policy_configured": bool(self.chat_policy.strip()),
                # 中间件开关：在 Nacos knowledge-hub.yaml 的 agent.* 下改，改完 POST /v1/admin/reload
                "switches": {
                    "plan": self.agent.plan_enabled,
                    "review": self.agent.review_enabled,
                    "security_scan": self.agent.security_scan_enabled,
                },
            },
            "milvus": {
                "uri_set": bool(self.env.milvus.uri),
                "db": self.env.milvus.db_name,
            },
            "redis": {"host": self.env.redis.host, "port": self.env.redis.port},
            "nacos": {
                "server": self.env.nacos.server,
                "data_id": self.env.nacos.data_id,
                "group": self.env.nacos.group,
                "namespace": self.env.nacos.namespace,
            },
        }

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Settings(source={self.source!r}, nacos_ok={self.nacos_ok}, errors={self.errors!r})"


def _default_config() -> dict[str, Any]:
    try:
        raw = yaml.safe_load(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:  # pragma: no cover - packaging issue
        logger.error("bundled config unreadable (%s); using hard-coded defaults", exc)
        return {}
    return raw if isinstance(raw, dict) else {}


def _nacos_client(env: EnvSettings) -> NacosClient:
    return NacosClient(
        env.nacos.server,
        username=env.nacos.username,
        password=env.nacos.password,
        namespace=env.nacos.namespace,
        timeout_s=env.nacos.timeout_ms / 1000.0,
    )


def load_settings(
    *,
    env: EnvSettings | None = None,
    fetch_nacos: bool = True,
    environ: Mapping[str, str] | None = None,
) -> Settings:
    """Nacos -> env overrides -> bundled defaults, never raising."""
    env = env or load_env()
    environ = dict(os.environ) if environ is None else dict(environ)
    errors: list[str] = []
    source = "defaults"
    nacos_ok = False

    config = _default_config()
    if fetch_nacos and env.nacos.server:
        client = _nacos_client(env)
        try:
            raw_text = client.fetch(env.nacos.data_id, env.nacos.group)
            remote = yaml.safe_load(raw_text)
            if not isinstance(remote, dict):
                raise NacosError("nacos config is not a mapping")
            config = deep_merge(config, remote)
            nacos_ok = True
            source = "nacos"
        except (NacosError, yaml.YAMLError) as exc:
            errors.append(f"nacos: {exc}")
            logger.warning("nacos config unavailable, using bundled defaults: %s", exc)
    elif not env.nacos.server:
        errors.append("nacos: NACOS_SERVER empty")

    resolved = resolve_placeholders(config, environ)
    overrides = apply_env_overrides(resolved, environ)
    if overrides:
        source = f"{source}+env"
    resolved.setdefault("llm", {}).setdefault("base_url", env.llm.litellm_base_url)

    try:
        app_config = AppConfig.model_validate(resolved)
    except ValidationError as exc:
        errors.append(f"config invalid: {exc.error_count()} field(s)")
        logger.error("nacos/default config failed validation, using hard-coded defaults: %s", exc)
        app_config = AppConfig()

    agent_spec, spec_error = resolve_agent_spec(
        NacosAIRegistry(_nacos_client(env))
        if (fetch_nacos and env.nacos.server)
        else None,
        name=app_config.agent.name,
        label=app_config.agent.label,
        fallback_prompt=app_config.agent.fallback_prompt,
        default_model=app_config.llm.chat_model,
    )
    if spec_error:
        errors.append(spec_error)
        logger.warning("agent spec unavailable, using bundled prompt: %s", spec_error)

    # Optional policy text for the deterministic retrieval path (a Nacos *prompt*,
    # not an AgentSpec: see AgentSection.chat_policy_prompt).
    chat_policy = ""
    policy_key = (app_config.agent.chat_policy_prompt or "").strip()
    if policy_key and fetch_nacos and env.nacos.server:
        registry = NacosAIRegistry(_nacos_client(env))
        chat_policy = registry.prompt(policy_key, label=app_config.agent.label)
        if not chat_policy:
            errors.append(f"agent: chat policy prompt {policy_key!r} not found")

    # 图片理解用的提示词：Nacos 上的一个 prompt 资源（image_parser.image_parser_prompt）
    image_caption_prompt = ""
    image_prompt_key = (app_config.image_parser.prompt_key or "").strip()
    if image_prompt_key and fetch_nacos and env.nacos.server:
        registry = NacosAIRegistry(_nacos_client(env))
        image_caption_prompt = registry.prompt(image_prompt_key, label="production")
        if not image_caption_prompt:
            errors.append(f"image_parser: prompt {image_prompt_key!r} not found, using builtin")

    settings = Settings(
        env,
        app_config,
        nacos_ok=nacos_ok,
        source=source,
        errors=tuple(errors),
        agent_spec=agent_spec,
        chat_policy=chat_policy,
        image_caption_prompt=image_caption_prompt,
    )
    logger.info(
        "settings loaded (source=%s, nacos_ok=%s, chat_model=%s, dim=%s, agent_spec=%s)",
        settings.source,
        settings.nacos_ok,
        settings.chat_model,
        settings.embedding.dimensions,
        settings.agent_spec.source,
    )
    return settings


_settings: Settings | None = None
_settings_lock = threading.Lock()


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        with _settings_lock:
            if _settings is None:
                _settings = load_settings()
    return _settings


def reload_settings(*, fetch_nacos: bool = True) -> Settings:
    global _settings
    settings = load_settings(env=load_env(), fetch_nacos=fetch_nacos)
    with _settings_lock:
        _settings = settings
    return settings


def set_settings(settings: Settings) -> None:
    """Test/DI hook."""
    global _settings
    with _settings_lock:
        _settings = settings


__all__ = [
    "AGENT_ROOT",
    "AgentSection",
    "AgentSpec",
    "AppConfig",
    "ChunkingQuality",
    "ChunkingSection",
    "DEFAULT_CONFIG_PATH",
    "DenseSection",
    "EmbeddingSection",
    "EnvSettings",
    "FusionSection",
    "GraphSection",
    "IndexSection",
    "JevSection",
    "LLMSection",
    "LLMSettings",
    "MilvusSettings",
    "MinioSettings",
    "NacosSettings",
    "Neo4jSettings",
    "RedisSettings",
    "RerankSection",
    "RetrievalSection",
    "ServerSettings",
    "Settings",
    "SparseSection",
    "WorkerSettings",
    "deep_merge",
    "get_settings",
    "load_env",
    "load_settings",
    "reload_settings",
    "resolve_placeholders",
    "set_settings",
]
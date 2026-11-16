"""Application container: wires settings to concrete clients and probes health."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from typing import Any

from knowledge_hub import __version__
from knowledge_hub.config.nacos import NacosClient
from knowledge_hub.config.nacos_ai import NacosAIRegistry, resolve_agent_spec
from knowledge_hub.config.settings import Settings, _nacos_client, load_settings, reload_settings
from knowledge_hub.decision.jev import Jev
from knowledge_hub.engine.chat import ChatEngine
from knowledge_hub.rag.graph import GraphService
from knowledge_hub.rag.graph_store import Neo4jGraphStore
from knowledge_hub.rag.pipeline import IndexPipeline
from knowledge_hub.rag.retriever import Retriever
from knowledge_hub.rag.store import ChunkStore
from knowledge_hub.runtime.agent import AgentDeps, AgentRuntime
from knowledge_hub.runtime.middleware import Planner, Reviewer, SecurityGuard
from knowledge_hub.runtime.sandbox import SandboxClient
from knowledge_hub.runtime.skills import SkillManager
from knowledge_hub.security.tickets import TicketVerifier
from knowledge_hub.tools.llm import LLMClient
from knowledge_hub.tools.milvus import MilvusSession
from knowledge_hub.tools.redis_factory import create_async_redis

logger = logging.getLogger(__name__)

_PROBE_TIMEOUT_S = 2.0


class Container:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._spec_cache: dict[str, Any] = {}
        self._build(settings)
        # Overridable for tests / alternative probes.
        self.probe_milvus = self._probe_milvus
        self.probe_nacos = self._probe_nacos
        self.probe_redis = self._probe_redis

    # ------------------------------------------------------------------ wiring
    def _build(self, settings: Settings) -> None:
        self.llm = LLMClient(settings.llm.base_url, settings.env.llm.litellm_api_key)
        self.store = ChunkStore(settings.env, session=MilvusSession(settings.env))
        self.verifier = TicketVerifier.from_env(settings.env)
        self.graph_store = Neo4jGraphStore(settings)
        self.graph = GraphService(settings, store=self.graph_store, llm=self.llm)
        self._ensure_graph_schema(settings)
        self.retriever = Retriever(
            settings, store=self.store, llm=self.llm, graph=self.graph
        )
        self.jev = Jev(settings, self.llm)
        self.chat = ChatEngine(settings, retriever=self.retriever, llm=self.llm, jev=self.jev)
        self.sandbox = SandboxClient(
            domain=os.environ.get("OPEN_SANDBOX_DOMAIN", ""),
            api_key=os.environ.get("OPEN_SANDBOX_API_KEY", ""),
        )
        registry = (
            NacosAIRegistry(_nacos_client(settings.env)) if settings.env.nacos.server else None
        )
        self.skills = SkillManager(
            registry, sandbox=self.sandbox, label=settings.agent.label
        )
        from knowledge_hub.tools.minio import S3Client

        agent_settings = settings.agent
        model_name = settings.agent_spec.model.name or settings.chat_model
        self.agent = AgentRuntime(
            AgentDeps(
                settings=settings,
                llm=self.llm,
                spec=settings.agent_spec,
                retriever=self.retriever,
                sandbox=self.sandbox,
                spec_loader=self._load_agent_spec,
                tavily_api_key=os.environ.get("TAVILY_API_KEY", ""),
                store=self.store,
                graph=self.graph,
                skills=self.skills,
                s3=S3Client.from_env(settings.env),
                planner=Planner(self.llm, model=model_name) if agent_settings.plan_enabled else None,
                reviewer=Reviewer(self.llm, model=model_name) if agent_settings.review_enabled else None,
                guard=SecurityGuard() if agent_settings.security_scan_enabled else None,
                forbidden_in_output=(
                    (settings.env.server.jwt_secret,) if settings.env.server.jwt_secret else ()
                ),
            )
        )
        # JEV 判定"该查库"却没查到证据时，chat 链路把这一轮交给主 Agent 兜底。
        self.chat.attach_agent(self.agent)
        self.pipeline = IndexPipeline(
            settings,
            store=self.store,
            llm=self.llm,
            concurrency=max(1, int(settings.index.max_concurrency)),
            graph=self.graph,
        )

    def _ensure_graph_schema(self, settings: Settings) -> None:
        """Create the graph constraints/vector index up front (best effort).

        Doing it lazily on first query made every chat log a "vector index missing"
        failure until the first document was extracted, which looked like a bug.
        """
        if not settings.retrieval.graph.enabled or not self.graph_store.configured:
            return

        def run() -> None:
            try:
                self.graph_store.ensure_schema(int(settings.embedding.dimensions) or 0)
            except Exception as exc:  # Neo4j 不可用不应影响对话
                logger.info("graph schema init skipped: %s", type(exc).__name__)

        threading.Thread(target=run, name="graph-schema", daemon=True).start()

    def _load_agent_spec(self, name: str) -> tuple[Any, str | None]:
        """Reload a subagent's spec from Nacos (cached per container build)."""
        cached = self._spec_cache.get(name)
        if cached is not None:
            return cached
        env = self.settings.env
        registry = (
            NacosAIRegistry(_nacos_client(env)) if env.nacos.server else None
        )
        spec, note = resolve_agent_spec(
            registry,
            name=name,
            label=self.settings.agent.label,
            default_model=self.settings.app.llm.chat_model,
        )
        result = (spec, note)
        if note is None:
            self._spec_cache[name] = result
        return result

    def reload(self) -> Settings:
        settings = reload_settings()
        old_llm = self.llm
        try:
            old_store = self.store
            old_store.close()
        except Exception:  # pragma: no cover - disconnect is best effort
            pass
        self.settings = settings
        self._build(settings)
        logger.info("container reloaded (source=%s, nacos_ok=%s)", settings.source, settings.nacos_ok)
        _close_quietly(old_llm)
        return settings

    async def aclose(self) -> None:
        await self.llm.aclose()
        try:
            self.store.close()
        except Exception:  # pragma: no cover
            pass
        try:
            self.graph_store.close()
        except Exception:  # pragma: no cover
            pass

    # ------------------------------------------------------------------ health
    async def health(self) -> dict[str, Any]:
        milvus, nacos, redis = await asyncio.gather(
            _safe(self.probe_milvus),
            _safe(self.probe_nacos),
            _safe(self.probe_redis),
        )
        required_ok = bool(milvus) and bool(nacos)
        return {
            "status": "ok" if required_ok else "degraded",
            "milvus": bool(milvus),
            "nacos": bool(nacos),
            "redis": bool(redis),
            "graph": bool(self.graph.enabled),
            "version": __version__,
            "config_source": self.settings.source,
            "nacos_ok_cached": self.settings.nacos_ok,
            "errors": list(self.settings.errors),
            "timestamp": int(time.time() * 1000),
        }

    async def _probe_milvus(self) -> bool:
        return await asyncio.wait_for(
            asyncio.to_thread(self.store.health), timeout=_PROBE_TIMEOUT_S
        )

    async def _probe_nacos(self) -> bool:
        env = self.settings.env
        if not env.nacos.server:
            return False
        client = NacosClient(
            env.nacos.server,
            username=env.nacos.username,
            password=env.nacos.password,
            namespace=env.nacos.namespace,
            timeout_s=min(1.0, env.nacos.timeout_ms / 1000.0),
        )
        return await asyncio.wait_for(
            asyncio.to_thread(client.health), timeout=_PROBE_TIMEOUT_S
        )

    async def _probe_redis(self) -> bool:
        client = await create_async_redis(self.settings.env)
        try:
            return bool(await asyncio.wait_for(client.ping(), timeout=1.0))
        finally:
            try:
                await client.aclose()
            except Exception:  # pragma: no cover
                pass


async def _safe(probe: Any) -> bool:
    try:
        return bool(await probe())
    except Exception as exc:  # never let a probe break /health
        logger.debug("health probe failed: %s", type(exc).__name__)
        return False


def _close_quietly(llm: LLMClient) -> None:
    try:
        asyncio.get_running_loop().create_task(llm.aclose())
    except RuntimeError:
        pass


def build_container(settings: Settings | None = None) -> Container:
    return Container(settings or load_settings())


__all__ = ["Container", "build_container"]

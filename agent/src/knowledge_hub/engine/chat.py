"""Grounded chat: JEV routing -> retrieval -> JEV judge -> streamed answer -> citations.

Emits the SSE event tuples defined in docs/12 §3.3 (``status`` / ``token`` /
``citation`` / ``error`` / ``done``). The transport formatting lives in
``knowledge_hub.api.sse`` so this module stays reusable/testable.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from knowledge_hub.config.settings import Settings
from knowledge_hub.decision.jev import Jev, JevOption, JevResult
from knowledge_hub.engine.history import compress_history
from knowledge_hub.engine.prompts import (
    build_direct_messages,
    build_messages,
    build_resume_messages,
    capability_block,
    refusal_message,
)
from knowledge_hub.errors import KhError, LLMTimeout, LLMUnavailable, PermissionDenied
from knowledge_hub.rag.citations import clean_source_url, resolve_title, trim_snippet
from knowledge_hub.rag.retriever import RetrievedChunk, Retriever, RetrieveResult
from knowledge_hub.rag.textutil import estimate_tokens
from knowledge_hub.security.tickets import RetrievalTicket
from knowledge_hub.tools.llm import LLMClient

logger = logging.getLogger(__name__)

Event = tuple[str, dict[str, Any]]

_MIN_SUPPORT_SCORE = 0.15
#: 低于这个分数（RRF 融合后的量级很小）就完全不接地：宁可通用作答，也不拿噪声当依据。
_MIN_GROUNDING_SCORE = 0.02


@dataclass(slots=True)
class ChatRequest:
    query: str = ""
    kb_ids: list[str] = field(default_factory=list)
    ticket: str = ""
    tenant_id: str = ""
    conversation_id: str = ""
    user_message_id: str = ""
    assistant_message_id: str = ""
    profile: dict[str, Any] = field(default_factory=dict)
    kb_collections: dict[str, str] = field(default_factory=dict)
    history: list[dict[str, Any]] = field(default_factory=list)
    trace_id: str = ""
    #: 用户在输入框里选的网关模型别名；空表示跟随 AgentSpec / 配置默认。
    model: str = ""
    #: 续写：把 prefix（已被中断的半截回答）交回模型接着写，不再检索。
    resume: bool = False
    resume_prefix: str = ""
    #: 该用户可访问的知识库清单（名称/简介），让路由决策知道"库里有哪类资料"。
    available_kbs: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> ChatRequest:
        profile = payload.get("profile")
        history = payload.get("history")
        kb_collections = payload.get("kb_collections")
        available_kbs = payload.get("available_kbs")
        return cls(
            query=str(payload.get("query") or ""),
            kb_ids=[str(kb) for kb in (payload.get("kb_ids") or [])],
            ticket=str(payload.get("ticket") or ""),
            tenant_id=str(payload.get("tenant_id") or ""),
            conversation_id=str(payload.get("conversation_id") or ""),
            user_message_id=str(payload.get("user_message_id") or ""),
            assistant_message_id=str(payload.get("assistant_message_id") or ""),
            profile=dict(profile) if isinstance(profile, Mapping) else {},
            kb_collections={
                str(key): str(value)
                for key, value in kb_collections.items()
                if isinstance(value, str)
            }
            if isinstance(kb_collections, Mapping)
            else {},
            history=[dict(item) for item in history if isinstance(item, Mapping)]
            if isinstance(history, list)
            else [],
            trace_id=str(payload.get("trace_id") or ""),
            model=str(payload.get("model") or ""),
            resume=bool(payload.get("resume")),
            resume_prefix=str(payload.get("resume_prefix") or ""),
            available_kbs=[
                dict(item) for item in available_kbs if isinstance(item, Mapping)
            ]
            if isinstance(available_kbs, list)
            else [],
        )


class ChatEngine:
    def __init__(
        self,
        settings: Settings,
        *,
        retriever: Retriever,
        llm: LLMClient,
        jev: Jev,
        agent: Any = None,
    ) -> None:
        self.settings = settings
        self.retriever = retriever
        self.llm = llm
        self.jev = jev
        #: 主 Agent（工具 / 子 Agent / 沙箱）。JEV 判定"该查库"但没查到证据时兜底用它。
        self.agent = agent
        #: 会话摘要缓存（懒初始化）。只用来避免重复总结同一段历史。
        self._history_redis: Any = None
        self._history_redis_down = False

    def attach_agent(self, agent: Any) -> None:
        """容器里 agent 比 chat 建得晚，建好后回挂一下。"""
        self.agent = agent

    async def _summary_redis(self) -> Any:
        """摘要缓存用的 Redis。拿不到就返回 None，缓存只是省钱手段。"""
        if self._history_redis_down:
            return None
        if self._history_redis is not None:
            return self._history_redis
        try:
            from knowledge_hub.tools.redis_factory import create_async_redis

            self._history_redis = await create_async_redis(self.settings.env, socket_timeout=2.0)
            return self._history_redis
        except Exception as exc:  # pragma: no cover - 未配置 redis
            logger.debug("history summary cache disabled: %s", exc)
            self._history_redis_down = True
            return None

    async def _compressed_history(
        self, request: ChatRequest, model: str
    ) -> tuple[str, list[dict[str, Any]]]:
        """长对话先压成摘要，只把最近几轮原样带上。任何异常都退回原始历史。"""
        history = list(request.history or [])
        if not history:
            return "", []
        try:
            return await compress_history(
                history=history,
                llm=self.llm,
                model=model,
                conversation_id=request.conversation_id or "",
                redis=await self._summary_redis(),
            )
        except Exception as exc:  # pragma: no cover - 保底：压缩失败不影响回答
            logger.info("history compression failed: %s", exc)
            return "", history

    # ------------------------------------------------------------------ routing
    def _extra_body(self) -> dict[str, Any]:
        """AgentSpec 里的 ``model.thinking`` 落到网关参数上。

        只有开启时才带：OpenAI 兼容网关收到不认识的参数会直接 400，
        所以关掉时一个字段都不加。
        """
        if self.settings.agent_spec.model.thinking_enabled:
            return {"enable_thinking": True}
        return {}

    async def route(self, request: ChatRequest, ticket: RetrievalTicket) -> JevResult:
        effective_kb = ticket.effective_kb_ids(request.kb_ids or None)
        strategy = str(request.profile.get("strategy") or "hybrid").lower()
        kb_selected = bool([str(kb).strip() for kb in request.kb_ids if str(kb).strip()])
        # 把可访问知识库的"名称 + 简介"交给决策器：没选库时它据此判断
        # "这个问题是不是这些库里能查到的"，比只看一个空列表准得多。
        kb_summaries = [
            {
                "name": str(item.get("name") or "")[:40],
                "description": str(item.get("description") or "")[:120],
            }
            for item in request.available_kbs[:10]
            if str(item.get("name") or "").strip()
        ]
        context = {
            # kb_ids 是"用户明确选的库"；授权集合另用 kb_authorized 表达，
            # 否则规则层会把"授权了 3 个库"误当成"用户选了 3 个"。
            "kb_ids": list(effective_kb) if kb_selected else [],
            "kb_authorized": list(effective_kb),
            "kb_selected": kb_selected,
            "available_kbs": kb_summaries,
            "query_length": len(request.query.strip()),
            "strategy": strategy,
            "retrieval_disabled": strategy == "direct",
            "no_permission": not ticket.principals,
        }
        # Deterministic rules win; otherwise the structured model call runs (3s budget)
        # and only degrades when the gateway is unreachable / invalid / slow.
        options = [
            JevOption(
                "retrieve",
                "需要查企业知识库后再回答（没指定范围时检索全部已授权知识库，"
                "库清单见 context.available_kbs）",
            ),
            JevOption("direct", "无需检索（闲聊、通用知识、写作创作等），直接回答"),
        ]
        if self.agent is not None:
            # 实时行情、公开网页、制作类任务：检索企业库帮不上忙，直接交给主 Agent，
            # 由它委派检索 Agent（web_search / fetch_url 在那边）或直接用 Skill，省掉一次空检索。
            options.append(
                JevOption(
                    "agent",
                    "需要实时或外部信息（行情、新闻、天气）、公开网页内容、联网搜索，"
                    "或制作类任务（PPT/页面/文件），交给主 Agent 处理",
                )
            )
        return await self.jev.decide(
            "router",
            context,
            options,
            {"fallback": "retrieve" if kb_selected else "direct"},
        )

    async def judge(self, chunks: Sequence[RetrievedChunk], retrieval: RetrieveResult | None) -> JevResult:
        top_score = max((chunk.score for chunk in chunks), default=0.0)
        context = {
            "chunk_count": len(chunks),
            "top_score": round(float(top_score), 4),
            "min_support_score": _MIN_SUPPORT_SCORE,
            "empty_retrieval": not chunks,
        }
        return await self.jev.decide(
            "judge",
            context,
            [
                JevOption("answer", "证据充分，可直接作答"),
                JevOption("answer_with_caveat", "证据偏弱，作答时声明不确定性"),
                JevOption("refuse", "证据不足，拒答"),
            ],
            {"fallback": "answer_with_caveat"},
        )

    # ------------------------------------------------------------------- stream
    def _base_prompt_with_capabilities(self) -> str | None:
        """将「已装载的工具/子 Agent/Skill/MCP」附在系统提示词后，
        保证用户问「你有什么工具」时模型回答的是真实能力。"""
        base = self.settings.base_prompt
        block = capability_block(self.settings.agent_spec)
        if not block:
            return base or None
        return f"{base}\n\n{block}".strip() if base else block

    async def stream(
        self,
        request: ChatRequest,
        *,
        ticket: RetrievalTicket,
    ) -> AsyncIterator[Event]:
        usage = {
            "model": request.model or self.settings.chat_model,
            "input_tokens": 0,
            "output_tokens": 0,
        }
        chunks: list[RetrievedChunk] = []
        started = time.perf_counter()

        if not ticket.principals:
            yield "error", PermissionDenied("retrieval ticket carries no principals").to_event()
            yield "done", {"usage": usage}
            return

        try:
            if request.resume:
                async for event in self._stream_resume(request, ticket, usage, started):
                    yield event
                return

            # 两条明确的车道（不再让一个小分类器去猜"闲聊还是查库"）：
            # 1) 用户锁定了知识库 → 确定性链路：稠密+稀疏召回 → 融合 → 重排 → 带引用作答；
            # 2) 没锁定 → 交给主 Agent（Nacos 里配的那个），它自己决定要不要委派检索 Agent
            #    去 milvus_search / milvus_query / web_search，用完再作答。
            # 只有在没有主 Agent（纯引擎部署）或策略显式要求直答时，才让 JEV router 兜底。
            kb_selected = bool([str(kb).strip() for kb in request.kb_ids if str(kb).strip()])
            strategy = str(request.profile.get("strategy") or "").lower()
            yield "status", {"stage": "route", "kb_selected": kb_selected}
            capability_answer = self._capability_answer(request.query)
            if capability_answer:
                yield "status", {"stage": "capability"}
                yield "token", {"delta": capability_answer}
                usage["output_tokens"] = estimate_tokens(capability_answer)
                yield "done", {"usage": usage}
                return
            if not kb_selected and self.agent is not None and strategy != "direct":
                # 没锁定知识库：先做一次轻量预检索（3 条、不重排，几百毫秒），
                # 把命中作为"初始材料"交给主 Agent。这样企业制度类问题不依赖
                # "模型愿不愿意调 task"，实时/公开网页类问题命中为空，Agent 照常用
                # web_search 处理，也不会多花一次空检索。
                prefetched: list[dict[str, Any]] = []
                skip_probe = _skip_prefetch(request.query, self._capability_answer(request.query))
                if skip_probe:
                    # 能力类 / 写作类 / 寒暄：预取只会带来无关材料，
                    # 反而让主 Agent 拿产品文档去回答「你有什么工具」。
                    yield "status", {"stage": "prefetch", "skipped": True, "reason": "not_a_lookup"}
                    skip_probe = True
                try:
                    probe = None if skip_probe else await self.retriever.retrieve(
                        ticket=ticket,
                        kb_ids=request.kb_ids,
                        query=request.query,
                        profile=request.profile,
                        include_debug=False,
                        kb_collections=request.kb_collections,
                    )
                    if probe is not None:
                        prefetched = [
                            {
                                "text": chunk.text,
                                "title": chunk.title,
                                "doc_title": chunk.doc_title or chunk.title,
                                "title_path": chunk.title_path,
                                "kind": chunk.kind or chunk.block_type,
                                "url": chunk.source_url,
                                "score": chunk.score,
                            }
                            for chunk in probe.chunks[:3]
                        ]
                    if prefetched:
                        yield "status", {"stage": "prefetch", "hits": len(prefetched)}
                except KhError as exc:
                    # 预检索失败不该挡住这一轮：交给 Agent 自己用 web_search / 说明情况
                    logger.warning(
                        "chat %s prefetch failed: %s", request.trace_id or request.conversation_id, exc.code
                    )
                async for event in self._delegate_to_agent(
                    request, ticket, usage, started, reason="no_kb_pinned", initial_context=prefetched
                ):
                    yield event
                return
            route = await self.route(request, ticket)
            retrieval: RetrieveResult | None = None
            if route.choice == "retrieve" or kb_selected:
                # 用户显式锁定知识库时必须检索这个范围，不采纳 router 的"直答/交 agent"
                try:
                    retrieval = await self.retriever.retrieve(
                        ticket=ticket,
                        kb_ids=request.kb_ids,
                        query=request.query,
                        profile=request.profile,
                        include_debug=bool(request.profile.get("debug")),
                        kb_collections=request.kb_collections,
                    )
                    chunks = retrieval.chunks
                except KhError as exc:
                    logger.warning(
                        "chat %s retrieval failed: %s", request.trace_id or request.conversation_id, exc.code
                    )
                    # 用户没锁定知识库时，检索侧故障不该把整条提问打死：
                    # 交给主 Agent（能联网/兜底作答），前端只会看到一条提示，不会中断。
                    if not kb_selected and self.agent is not None:
                        yield "notice", {
                            "level": "warning",
                            "message": "知识库检索暂时不可用，已改用通用回答",
                        }
                        async for event in self._delegate_to_agent(
                            request, ticket, usage, started, reason="retrieval_unavailable"
                        ):
                            yield event
                        return
                    yield "error", _public_error(exc)
                    yield "done", {"usage": usage}
                    return
                if not chunks and not kb_selected and self.agent is not None:
                    # 用户选定的库里一条证据都没有：交给主 Agent（它能调工具/子 Agent 继续找）。
                    async for event in self._delegate_to_agent(
                        request, ticket, usage, started, reason="no_evidence"
                    ):
                        yield event
                    return
                if not chunks:
                    # Nothing usable came back (e.g. every kb collection is missing):
                    # re-route to the direct-answer path instead of pretending we have evidence.
                    route = await self.jev.decide(
                        "router",
                        {
                            "kb_ids": list(ticket.effective_kb_ids(request.kb_ids or None)),
                            "query_length": len(request.query.strip()),
                            "chunk_count": 0,
                            "empty_retrieval": True,
                            "no_kb_collections": bool((retrieval.debug or {}).get("all_collections_missing")),
                            "skipped_kbs": (retrieval.debug or {}).get("skipped_kbs") or [],
                        },
                        [
                            JevOption("retrieve", "需要检索知识库后再回答"),
                            JevOption("direct", "无需检索，直接回答或要求用户澄清"),
                        ],
                        {"fallback": "direct", "allow_model": False},
                    )

            # 只有"用户没选知识库 + 决策器判定不需要查"才算纯对话；
            # 选了知识库却没检索到内容时必须保留接地提示，不能退化成凭常识作答。
            used_direct = route.choice != "retrieve" and not kb_selected
            # 选了知识库却一条证据都没有：直接给一句明确答复，不再让模型"解释自己资料不足"
            # （那样会出现"证据支撑度不足……资料不足，无法回答"这种自相重复的话）。
            if kb_selected and not chunks:
                message = refusal_message()
                yield "token", {"delta": message}
                usage["output_tokens"] = estimate_tokens(message)
                usage["input_tokens"] = estimate_tokens(request.query)
                logger.info(
                    "chat %s answered with deterministic refusal (empty retrieval)",
                    request.trace_id or request.conversation_id,
                )
                yield "done", {"usage": usage}
                return
            yield "status", {"stage": "direct" if used_direct else "retrieve"}
            verdict = await self.judge(chunks, retrieval)
            if verdict.choice == "refuse":
                message = refusal_message()
                yield "token", {"delta": message}
                usage["output_tokens"] = estimate_tokens(message)
                usage["input_tokens"] = estimate_tokens(request.query)
                logger.info(
                    "chat %s refused by judge (confidence=%.2f)",
                    request.trace_id or request.conversation_id,
                    verdict.confidence,
                )
                yield "done", {"usage": usage}
                return

            # 证据分数低到"几乎不相关"时：用户本来就没锁定知识库的，
            # 说明这只是顺手查了一下，不该拿噪声片段把回答绑死 —— 退回通用作答。
            top_score = max((float(chunk.score) for chunk in chunks), default=0.0)
            weak_evidence = verdict.rule_hit == "low_score" and top_score < _MIN_GROUNDING_SCORE
            if weak_evidence and not kb_selected:
                used_direct = True
                yield "status", {"stage": "direct"}
                logger.info(
                    "chat %s evidence too weak (%.3f); answering without grounding",
                    request.trace_id or request.conversation_id,
                    top_score,
                )

            # 接地时把命中的片段全部作为引用发出：哪条真被用到由正文里的 [cN] 决定，
            # 前端只展示正文引用到的那些（按分数二次过滤会让 [c1] 找不到来源）。
            citable = [] if used_direct else list(chunks)
            for index, chunk in enumerate(citable, start=1):
                yield "citation", {
                    "chunk_id": chunk.chunk_id,
                    "doc_id": chunk.doc_id,
                    "title": resolve_title(chunk.doc_title, chunk.title_path, chunk.block_type),
                    "title_path": [part for part in chunk.title_path if part],
                    "url": clean_source_url(chunk.source_url),
                    "snippet": trim_snippet(chunk.text, request.query),
                    "score": round(float(chunk.score), 6),
                }
                if index >= self.settings.retrieval.top_k:
                    break

            # 长对话：较早的几轮压成摘要，避免被 MAX_HISTORY_TURNS 硬截断丢前文
            summary, history = await self._compressed_history(request, usage["model"])
            messages = (
                build_direct_messages(
                    query=request.query,
                    history=history,
                    summary=summary or None,
                    system_prompt=self._base_prompt_with_capabilities(),
                )
                if used_direct
                else build_messages(
                    query=request.query,
                    chunks=chunks,
                    history=history,
                    summary=summary or None,
                    caveat=verdict.choice == "answer_with_caveat",
                    system_prompt=self._base_prompt_with_capabilities(),
                )
            )
            usage["input_tokens"] = estimate_tokens(
                "\n".join(message["content"] for message in messages)
            )
            yield "status", {"stage": "generate"}

            produced: list[str] = []
            try:
                async with asyncio.timeout(float(self.settings.llm.stream_timeout_s)):
                    async for delta in self.llm.chat_stream(
                        messages,
                        model=usage["model"],
                        temperature=self.settings.agent_spec.model.temperature
                        if self.settings.agent_spec.model.temperature is not None
                        else self.settings.llm.temperature,
                        max_tokens=self.settings.llm.max_tokens,
                        extra_body=self._extra_body(),
                    ):
                        if delta.usage:
                            _merge_usage(usage, delta.usage)
                        if delta.text:
                            produced.append(delta.text)
                            yield "token", {"delta": delta.text}
            except (TimeoutError, LLMTimeout):
                logger.warning("chat %s generation timed out", request.trace_id)
                yield "error", _public_error(LLMUnavailable("stream timed out"))
                yield "done", {"usage": usage}
                return
            except LLMUnavailable as exc:
                logger.warning("chat %s model unavailable: %s", request.trace_id, exc.code)
                yield "error", _public_error(exc)
                yield "done", {"usage": usage}
                return

            if not produced and usage["output_tokens"] == 0:
                yield "error", {
                    "code": "MODEL_UNAVAILABLE",
                    "message": "模型未返回内容，请稍后重试",
                    "retryable": True,
                }
            else:
                usage["output_tokens"] = usage["output_tokens"] or estimate_tokens("".join(produced))

            logger.info(
                "chat %s finished in %sms (chunks=%s, route=%s, judge=%s)",
                request.trace_id or request.conversation_id,
                int((time.perf_counter() - started) * 1000),
                len(chunks),
                route.choice,
                verdict.choice,
            )
            yield "done", {"usage": usage}
        except KhError as exc:
            yield "error", _public_error(exc)
            yield "done", {"usage": usage}
        except Exception:
            logger.exception("chat stream failed")
            yield "error", {
                "code": "INTERNAL_ERROR",
                "message": "服务内部错误，请稍后重试",
                "retryable": False,
            }
            yield "done", {"usage": usage}

    def _capability_answer(self, query: str) -> str:
        """用户问「你有什么工具 / 能做什么」时，按 Nacos AgentSpec 的事实直接答。

        为什么不交给模型：它会去检索知识库（命中产品文档），然后回答“资料里没提到”，
        甚至反过来建议用户去委派检索。这类关于自身能力的问题应该确定性回答。
        """
        import re as _re

        text = (query or "").strip()
        if not text or len(text) > 40:
            return ""
        pattern = (
            "工具|tool|技能|skill|能力|能做什么|会什么|能干什么"
            "|子\\s*agent|subagent"
        )
        if not _re.search(pattern, text, _re.I):
            return ""
        spec = self.settings.agent_spec
        tools = [str(item) for item in (spec.tools or [])]
        if not tools and not spec.subagents:
            return ""
        lines = ["我当前实际可用的能力如下："]
        if tools:
            lines.append(f"- 可调用工具：{' / '.join(tools)}")
        if spec.subagents:
            lines.append(f"- 可委派的子 Agent：{' / '.join(str(s) for s in spec.subagents)}")
        if spec.skills:
            lines.append(f"- 可用 Skill：{' / '.join(str(s) for s in spec.skills)}")
        if spec.mcps:
            lines.append(f"- 已接入 MCP：{' / '.join(str(m) for m in spec.mcps)}")
        lines.append("")
        lines.append(
            "需要检索企业知识库或联网时，我会委派检索子 Agent；"
            "需要你补充关键信息时，我会直接给出可点选的选项。"
        )
        return chr(10).join(lines)

    async def _maybe_ask(
        self, text: str, request: ChatRequest
    ) -> dict[str, Any] | None:
        """回答只有一句反问（没引用、没工具调用）时，补上可点选的候选。

        为什么要在引擎做：模型经常把澄清问题当成普通回答输出，
        不调 ask_user_question 工具，前端就没有按钮可点。这里做一次兜底，
        只在“短、以问号结尾、带要求补充的字样”时才触发，不影响正常回答。
        """
        raw = (text or "").strip()
        if not raw or "[c" in raw:
            return None
        # 模型常把澄清写成一段列表 + 一句反问：取最后一个以问号结尾的句子当问题
        body = ""
        for line in reversed([item.strip() for item in raw.splitlines() if item.strip()]):
            if line.endswith("?") or line.endswith("？"):
                body = line.lstrip("#-*0123456789. ").strip()
                break
        if not body or len(body) > 300:
            return None
        from knowledge_hub.runtime.agent import _parse_option_list  # noqa: PLC0415 - 避开循环引用

        prompt = (
            "用户需要回答下面这个问题：" + chr(10)
            + body + chr(10) + chr(10)
            + "请只输出一个 JSON 数组，里面是 2 到 6 个最可能的简短回答选项"
            + "（每项不超过 12 个字），不要输出任何其他内容。"
        )
        try:
            response = await self.llm.chat(
                [{"role": "user", "content": prompt}],
                model=self.settings.chat_model,
                temperature=0.0,
                max_tokens=120,
                timeout_s=20.0,
            )
            choices = response.get("choices") or [{}]
            message = (choices[0] or {}).get("message") or {}
            content = str(message.get("content") or "")
        except Exception as exc:  # noqa: BLE001 - 补候选失败不影响回答
            logger.info("chat %s infer options failed: %s", request.trace_id, type(exc).__name__)
            return None
        options = _parse_option_list(content)
        if len(options) < 2:
            return None
        return {"stage": "awaiting_user", "question": body, "options": options}

    async def _delegate_to_agent(
        self,
        request: ChatRequest,
        ticket: RetrievalTicket,
        usage: dict[str, Any],
        started: float,
        *,
        reason: str = "no_kb_pinned",
        initial_context: Sequence[dict[str, Any]] | None = None,
    ) -> AsyncIterator[Event]:
        """把这一轮交给主 Agent：复用同一个 SSE 契约，前端看不出链路差异。

        事件名沿用 ``status`` / ``tool`` / ``token`` / ``error`` / ``done``；
        token 载荷统一成 ``delta``，因为后端与前端按 chat 契约解析。
        ``reason`` 如实说明为什么交给 Agent，别一直写 no_evidence。
        ``initial_context`` 是引擎预检索到的切片，交给 Agent 当初始材料。
        """
        yield "status", {"stage": "agent", "reason": reason}
        # 局部导入：runtime.agent 会 import engine 里的提示词，顶层引入会成环。
        from knowledge_hub.runtime.agent import AgentRequest

        agent_request = AgentRequest(
            query=request.query,
            history=list(request.history or []),
            ticket=ticket,
            kb_ids=tuple(request.kb_ids or ()),
            kb_collections=dict(request.kb_collections or {}),
            session_key=request.conversation_id or request.trace_id or "default",
            conversation_id=request.conversation_id,
            tenant_id=ticket.tenant_id,
            initial_context=list(initial_context or []),
        )
        produced: list[str] = []
        asked = False
        try:
            async with asyncio.timeout(float(self.settings.llm.stream_timeout_s) * 3):
                async for event, data in self.agent.stream(agent_request):
                    if event == "status" and str(data.get("stage") or "") == "awaiting_user":
                        # 只有真正带候选的提问才算“已问”；
                        # 子层发了空 options 的 awaiting_user 时，下面的 _maybe_ask 要能补上。
                        asked = len(data.get("options") or []) >= 2
                    if event == "token":
                        text = data.get("text") or data.get("delta") or ""
                        if text:
                            produced.append(text)
                            yield "token", {"delta": text}
                        continue
                    if event == "done":
                        _merge_usage(usage, data.get("usage") or {})
                        continue
                    yield event, data
        except TimeoutError:
            logger.warning("chat %s agent delegation timed out", request.trace_id)
            yield "error", _public_error(LLMUnavailable("agent stream timed out"))
        except KhError as exc:
            yield "error", _public_error(exc)
        except Exception:
            logger.exception("chat %s agent delegation failed", request.trace_id)
            yield "error", {
                "code": "INTERNAL_ERROR",
                "message": "服务内部错误，请稍后重试",
                "retryable": False,
            }

        if produced:
            usage["output_tokens"] = usage["output_tokens"] or estimate_tokens("".join(produced))
        logger.info(
            "chat %s delegated to agent in %sms (chars=%s)",
            request.trace_id or request.conversation_id,
            int((time.perf_counter() - started) * 1000),
            sum(len(text) for text in produced),
        )
        if not asked:
            ask_event = await self._maybe_ask("".join(produced), request)
            if ask_event:
                yield "status", ask_event
        yield "done", {"usage": usage}

    async def _stream_resume(
        self, request: ChatRequest, ticket: RetrievalTicket, usage: dict[str, Any], started: float
    ) -> AsyncIterator[Event]:
        """断点续传：把半截回答接着写完。

        原来是接地回答的（正文里已经有 [cN]）就把资料重新取一遍再续写：
        否则续写的段落没有依据，[cN] 也会变成对不上来源的凭空编号。
        """
        prefix = request.resume_prefix.rstrip()
        if not prefix:
            yield "error", {
                "code": "BAD_REQUEST",
                "message": "这条回答还没有内容，无法续写，请重新生成",
                "retryable": False,
            }
            yield "done", {"usage": usage}
            return

        chunks: list[RetrievedChunk] = []
        grounded = bool(re.search(r"\[c\d+\]", prefix)) or bool(
            [str(kb).strip() for kb in request.kb_ids if str(kb).strip()]
        )
        if grounded:
            yield "status", {"stage": "retrieve"}
            try:
                retrieval = await self.retriever.retrieve(
                    ticket=ticket,
                    kb_ids=request.kb_ids,
                    query=request.query,
                    profile=request.profile,
                    include_debug=bool(request.profile.get("debug")),
                    kb_collections=request.kb_collections,
                )
                chunks = retrieval.chunks
            except KhError as exc:
                # 续写不因为检索失败而中断：退化成"接着写"，但不再要求引用
                logger.warning("resume %s retrieval failed: %s", request.trace_id, exc.code)
            for index, chunk in enumerate(chunks, start=1):
                yield "citation", {
                    "chunk_id": chunk.chunk_id,
                    "doc_id": chunk.doc_id,
                    "title": resolve_title(chunk.doc_title, chunk.title_path, chunk.block_type),
                    "title_path": [part for part in chunk.title_path if part],
                    "url": clean_source_url(chunk.source_url),
                    "snippet": trim_snippet(chunk.text, request.query),
                    "score": round(float(chunk.score), 6),
                }
                if index >= self.settings.retrieval.top_k:
                    break

        messages = build_resume_messages(
            query=request.query,
            prefix=prefix,
            history=request.history,
            system_prompt=self._base_prompt_with_capabilities(),
            chunks=chunks or None,
        )
        usage["input_tokens"] = estimate_tokens(
            "\n".join(message["content"] for message in messages)
        )
        yield "status", {"stage": "resume"}
        produced: list[str] = []
        try:
            async with asyncio.timeout(float(self.settings.llm.stream_timeout_s)):
                async for delta in self.llm.chat_stream(
                    messages,
                    model=usage["model"],
                    temperature=self.settings.agent_spec.model.temperature
                    if self.settings.agent_spec.model.temperature is not None
                    else self.settings.llm.temperature,
                    max_tokens=self.settings.llm.max_tokens,
                    extra_body=self._extra_body(),
                ):
                    if delta.usage:
                        _merge_usage(usage, delta.usage)
                    if delta.text:
                        produced.append(delta.text)
                        yield "token", {"delta": delta.text}
        except (TimeoutError, LLMTimeout):
            yield "error", _public_error(LLMUnavailable("stream timed out"))
            yield "done", {"usage": usage}
            return
        except LLMUnavailable as exc:
            yield "error", _public_error(exc)
            yield "done", {"usage": usage}
            return

        usage["output_tokens"] = usage["output_tokens"] or estimate_tokens("".join(produced))
        logger.info(
            "chat %s resumed in %sms (prefix_chars=%s, added_chars=%s)",
            request.trace_id or request.conversation_id,
            int((time.perf_counter() - started) * 1000),
            len(prefix),
            len("".join(produced)),
        )
        yield "done", {"usage": usage}


_GENERIC_ERROR_MESSAGES = {
    "MODEL_UNAVAILABLE": "模型服务暂时不可用，请稍后重试",
    "INTERNAL_ERROR": "服务内部错误，请稍后重试",
    "RETRIEVAL_TIMEOUT": "知识库检索超时：向量库响应过慢，请稍后点「重新回答」重试",
    "RETRIEVAL_UNAVAILABLE": (
        "知识库检索暂不可用：向量库（Milvus）未就绪或刚重启。"
        "请稍后点「重新回答」重试；若持续出现，联系管理员检查 Milvus 容器。"
    ),
}


def _skip_prefetch(query: str, capability_answer: str) -> bool:
    """这类问题不该先去知识库捞一把：能力类、写作/制作类、寒暄。

    它们要么跟企业资料无关，要么需要的是用户补充信息；预取只会把相关度很低的
    产品文档塞给主 Agent，让它拿这些去凑答案。真需要资料时，主 Agent 自己会委派
    retrieve_agent。
    """
    import re as _re

    text = (query or "").strip()
    if not text:
        return True
    if capability_answer:
        return True
    if len(text) <= 6:
        return True
    if _re.search("工具|能力|技能|你是谁|你叫什么|你能做什么|tool|skill", text, _re.I):
        return True
    if _re.search("写|做|生成|制作|策划|方案|PPT|ppt|复盘|总结|文章|润色|翻译|代码", text):
        return True
    return False


def _public_error(exc: KhError) -> dict[str, Any]:
    """Client-safe error payload: never echo upstream hosts, prompts or stack details."""
    event = exc.to_event()
    if exc.code in _GENERIC_ERROR_MESSAGES:
        event["message"] = _GENERIC_ERROR_MESSAGES[exc.code]
    return event


def _merge_usage(target: dict[str, Any], raw: Mapping[str, Any]) -> None:
    model = raw.get("model")
    if isinstance(model, str) and model:
        target["model"] = model
    for key in ("prompt_tokens", "input_tokens"):
        if raw.get(key) is not None:
            target["input_tokens"] = int(raw[key])
    for key in ("completion_tokens", "output_tokens"):
        if raw.get(key) is not None:
            target["output_tokens"] = int(raw[key])


__all__ = ["ChatEngine", "ChatRequest", "Event"]

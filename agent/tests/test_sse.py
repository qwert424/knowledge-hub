"""SSE framing + grounded chat event sequence (docs/12 §3.3)."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import pytest

from knowledge_hub.api.sse import encode_sse
from knowledge_hub.config.settings import Settings
from knowledge_hub.decision.jev import Jev
from knowledge_hub.engine.chat import ChatEngine, ChatRequest
from knowledge_hub.engine.prompts import build_messages
from knowledge_hub.errors import LLMUnavailable, RetrievalTimeout
from knowledge_hub.rag.retriever import RetrievedChunk, RetrieveResult
from knowledge_hub.security.tickets import RetrievalTicket
from knowledge_hub.tools.llm import StreamDelta


def _ticket() -> RetrievalTicket:
    return RetrievalTicket(
        tenant_id="t_001",
        user_id="u_1",
        principals=("user:u_1", "tenant:all"),
        kb_ids=("kb_001",),
    )


def _chunks(count: int = 2) -> list[RetrievedChunk]:
    return [
        RetrievedChunk(
            chunk_id=f"c{index}",
            doc_id=f"doc{index}",
            title=f"制度 {index}",
            title_path=[f"制度 {index}"],
            text=f"这是第 {index} 段检索内容。",
            score=0.9 - index * 0.1,
            source_url=f"kh://kb/doc{index}",
        )
        for index in range(count)
    ]


class FakeRetriever:
    def __init__(
        self,
        chunks: list[RetrievedChunk],
        error: Exception | None = None,
        debug: dict[str, Any] | None = None,
    ) -> None:
        self.chunks = chunks
        self.error = error
        self.debug = debug or {"dense_ms": 1}
        self.calls: list[dict[str, Any]] = []

    async def retrieve(self, **kwargs: Any) -> RetrieveResult:
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return RetrieveResult(chunks=self.chunks, debug=dict(self.debug))


class FakeLLM:
    def __init__(
        self,
        deltas: tuple[str, ...] = ("你", "好"),
        usage: dict[str, Any] | None = None,
        stream_error: Exception | None = None,
        judge: dict[str, Any] | None = None,
        router: dict[str, Any] | None = None,
        json_error: Exception | None = None,
    ) -> None:
        self.deltas = deltas
        self.usage = usage or {"model": "gpt-x", "prompt_tokens": 11, "completion_tokens": 7}
        self.stream_error = stream_error
        self.judge = judge or {
            "choice": "answer",
            "confidence": 0.9,
            "rationale": "证据充分",
            "evidence": [],
        }
        self.router = router or {
            "choice": "retrieve",
            "confidence": 0.9,
            "rationale": "需要检索制度原文",
            "evidence": [],
        }
        self.json_error = json_error
        self.models_used: list[str] = []
        self.messages: list[dict[str, str]] = []
        self.stream_calls = 0
        self.json_calls: list[str] = []
        self.json_messages: list[list[dict[str, str]]] = []

    async def chat_stream(
        self, messages: list[dict[str, str]], **kwargs: Any
    ) -> AsyncIterator[StreamDelta]:
        self.stream_calls += 1
        self.messages = messages
        model = kwargs.get("model")
        if isinstance(model, str) and model:
            self.models_used.append(model)
        if self.stream_error:
            raise self.stream_error
        for text in self.deltas:
            yield StreamDelta(text=text)
        yield StreamDelta(usage=self.usage)
        yield StreamDelta(finished=True)

    async def chat_json(
        self,
        messages: list[dict[str, str]],
        *,
        model: str,
        json_schema: dict[str, Any],
        schema_name: str = "decision",
        **kwargs: Any,
    ) -> dict[str, Any]:
        self.json_calls.append(schema_name)
        self.json_messages.append(list(messages))
        if self.json_error:
            raise self.json_error
        enum = json_schema["properties"]["choice"]["enum"]
        if "retrieve" in enum:
            return dict(self.router)
        return dict(self.judge)

    async def aclose(self) -> None:
        return None


def _engine(settings: Settings, retriever: FakeRetriever, llm: FakeLLM) -> ChatEngine:
    jev = Jev(settings, llm)  # type: ignore[arg-type]
    return ChatEngine(settings, retriever=retriever, llm=llm, jev=jev)  # type: ignore[arg-type]


class FakeAgent:
    """最小主 Agent：只关心 chat 是否把这一轮交过来了、事件是否被转成 chat 契约。"""

    def __init__(self, tokens: tuple[str, ...] = ("已", "处理")) -> None:
        self.tokens = tokens
        self.requests: list[Any] = []

    async def stream(self, request: Any) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        self.requests.append(request)
        yield "status", {"stage": "agent", "tools": ["web_search"]}
        yield "tool", {"name": "web_search", "arguments": "{}"}
        for text in self.tokens:
            yield "token", {"text": text}
        yield "done", {"usage": {"model": "gpt-x", "output_tokens": 2}}


async def _collect(engine: ChatEngine, request: ChatRequest) -> list[tuple[str, dict[str, Any]]]:
    return [event async for event in engine.stream(request, ticket=_ticket())]


def test_sse_frame_shape() -> None:
    frame = encode_sse("token", {"delta": "你好"})
    assert frame.startswith("event: token\ndata: ")
    assert frame.endswith("\n\n")
    body = frame.split("data: ", 1)[1].strip()
    assert json.loads(body) == {"delta": "你好"}


def test_sse_multiline_payload_is_single_line() -> None:
    frame = encode_sse("error", {"code": "X", "message": "line1\nline2"})
    assert frame.count("\n") == 3  # event line, data line, trailing blank separator
    assert '"line1\\nline2"' in frame  # escaped inside JSON, never a raw event break
    assert len(frame.splitlines()) == 3


def test_sse_accepts_preformatted_json() -> None:
    assert encode_sse("done", '{"usage":{}}') == 'event: done\ndata: {"usage":{}}\n\n'


async def test_chat_event_sequence(settings: Settings) -> None:
    llm = FakeLLM()
    engine = _engine(settings, FakeRetriever(_chunks(2)), llm)
    events = await _collect(
        engine,
        ChatRequest(query="报销流程是什么？", kb_ids=["kb_001"]),
    )
    names = [name for name, _ in events]
    assert names[0] == "status"
    assert events[0][1] == {"stage": "route", "kb_selected": True}
    assert ("status", {"stage": "retrieve"}) in events
    assert "citation" in names
    assert names.count("citation") == 2
    assert "status" in names and {"stage": "generate"} in [data for name, data in events if name == "status"]
    assert names[-1] == "done"
    tokens = [data["delta"] for name, data in events if name == "token"]
    assert "".join(tokens) == "你好"
    done_usage = events[-1][1]["usage"]
    assert done_usage == {"model": "gpt-x", "input_tokens": 11, "output_tokens": 7}
    for name, data in events:
        if name == "citation":
            assert set(data) == {
                "chunk_id",
                "doc_id",
                "title",
                "title_path",
                "url",
                "snippet",
                "score",
            }
            # title_path root (= document title here) is used, never the block type
            assert data["title"] == f"制度 {data['chunk_id'][1:]}"
            # synthetic kh:// URLs are never surfaced
            assert data["url"] == ""
            assert len(data["snippet"]) <= 240


async def test_chat_prompt_marks_untrusted_content(settings: Settings) -> None:
    llm = FakeLLM()
    engine = _engine(settings, FakeRetriever(_chunks(1)), llm)
    await _collect(engine, ChatRequest(query="问题", kb_ids=["kb_001"]))
    system = llm.messages[0]
    assert system["role"] == "system"
    assert "不可信" in system["content"]
    user = llm.messages[-1]["content"]
    assert "<untrusted_context>" in user and "</untrusted_context>" in user
    assert "忽略" in user or "忽略" in system["content"]


async def test_chat_model_unavailable_emits_error_without_leaking_prompt(settings: Settings) -> None:
    llm = FakeLLM(stream_error=LLMUnavailable("connect failed to 10.0.0.1:4000"))
    engine = _engine(settings, FakeRetriever(_chunks(1)), llm)
    events = await _collect(engine, ChatRequest(query="问题", kb_ids=["kb_001"]))
    errors = [data for name, data in events if name == "error"]
    assert errors and errors[0]["code"] == "MODEL_UNAVAILABLE"
    assert "10.0.0.1" not in errors[0]["message"]
    assert "system" not in errors[0]["message"].lower()
    assert events[-1][0] == "done"


async def test_chat_retrieval_error_emits_error(settings: Settings) -> None:
    engine = _engine(settings, FakeRetriever(_chunks(1), error=RetrievalTimeout("slow")), FakeLLM())
    events = await _collect(engine, ChatRequest(query="问题", kb_ids=["kb_001"]))
    errors = [data for name, data in events if name == "error"]
    assert errors and errors[0]["code"] == "RETRIEVAL_TIMEOUT"
    assert events[-1][0] == "done"


async def test_chat_judge_refusal_skips_generation(settings: Settings) -> None:
    llm = FakeLLM(
        judge={"choice": "refuse", "confidence": 0.95, "rationale": "无证据", "evidence": []}
    )
    engine = _engine(settings, FakeRetriever(_chunks(1)), llm)
    events = await _collect(engine, ChatRequest(query="问题", kb_ids=["kb_001"]))
    assert any(name == "token" for name, _ in events)
    assert not any(name == "citation" for name, _ in events)
    assert llm.stream_calls == 0
    assert events[-1][0] == "done"


async def test_no_kb_selection_lets_router_retrieve(settings: Settings) -> None:
    """没选知识库不再被强制成"纯对话"：决策器认为需要查，就在授权范围内检索。"""
    retriever = FakeRetriever(_chunks(1))
    llm = FakeLLM(router={"choice": "retrieve", "confidence": 0.9, "rationale": "制度类问题", "evidence": []})
    engine = _engine(settings, retriever, llm)
    events = await _collect(
        engine,
        ChatRequest(
            query="差旅标准是多少",
            kb_ids=[],
            available_kbs=[{"name": "差旅制度库", "description": "差旅制度"}],
        ),
    )

    assert len(retriever.calls) == 1
    assert retriever.calls[0]["kb_ids"] == []
    assert "citation" in [name for name, _ in events]
    assert events[-1][0] == "done"


async def test_no_kb_selection_can_answer_directly(settings: Settings) -> None:
    """决策器认为不需要检索时，连向量化都不发生。"""
    retriever = FakeRetriever(_chunks(1))
    llm = FakeLLM(router={"choice": "direct", "confidence": 0.9, "rationale": "闲聊", "evidence": []})
    engine = _engine(settings, retriever, llm)
    events = await _collect(engine, ChatRequest(query="你好", kb_ids=[]))

    assert retriever.calls == []
    assert "citation" not in [name for name, _ in events]
    assert ("status", {"stage": "direct"}) in events
    assert events[-1][0] == "done"


async def test_chat_retrieves_when_user_selected_a_knowledge_base(settings: Settings) -> None:
    retriever = FakeRetriever(_chunks(1))
    engine = _engine(settings, retriever, FakeLLM())
    events = await _collect(engine, ChatRequest(query="差旅标准", kb_ids=["kb_001"]))
    assert len(retriever.calls) == 1
    assert retriever.calls[0]["kb_ids"] == ["kb_001"]
    assert events[-1][0] == "done"


async def test_chat_uses_request_model_when_provided(settings: Settings) -> None:
    llm = FakeLLM()
    engine = _engine(settings, FakeRetriever(_chunks(1)), llm)
    await _collect(engine, ChatRequest(query="差旅标准", kb_ids=["kb_001"], model="chat-basic"))
    assert llm.models_used and llm.models_used[0] == "chat-basic"


async def test_chat_without_any_kb_skips_retrieval(settings: Settings) -> None:
    retriever = FakeRetriever(_chunks(1))
    engine = _engine(settings, retriever, FakeLLM())
    ticket = RetrievalTicket(
        tenant_id="t_001", user_id="u_1", principals=("user:u_1",), kb_ids=()
    )
    events = [event async for event in engine.stream(ChatRequest(query="你好", kb_ids=[]), ticket=ticket)]
    assert retriever.calls == []
    assert events[-1][0] == "done"


async def test_chat_rejects_ticket_without_principals(settings: Settings) -> None:
    engine = _engine(settings, FakeRetriever(_chunks(1)), FakeLLM())
    ticket = RetrievalTicket(tenant_id="t_001", user_id="u_1", principals=(), kb_ids=("kb_001",))
    events = [event async for event in engine.stream(ChatRequest(query="q"), ticket=ticket)]
    assert events[0][0] == "error"
    assert events[0][1]["code"] == "AUTH_403"


def test_prompt_contains_history_and_query(settings: Settings) -> None:
    messages = build_messages(
        query="继续上一个问题",
        chunks=_chunks(1),
        history=[
            {"role": "user", "content": "第一个问题"},
            {"role": "assistant", "content": "第一个回答"},
            {"role": "system", "content": "应被丢弃"},
        ],
        caveat=True,
    )
    roles = [message["role"] for message in messages]
    assert roles == ["system", "user", "assistant", "user"]
    assert "不够完整" in messages[0]["content"]
    assert "继续上一个问题" in messages[-1]["content"]


@pytest.mark.parametrize("score", [0.0, 0.9])
async def test_judge_rule_and_model_paths(settings: Settings, score: float) -> None:
    llm = FakeLLM()
    engine = _engine(settings, FakeRetriever(_chunks(1)), llm)
    chunks = _chunks(1)
    chunks[0].score = score
    events = [event async for event in engine.stream(ChatRequest(query="q", kb_ids=["kb_001"]), ticket=_ticket())]
    assert events[-1][0] == "done"


async def test_empty_chunks_with_selected_kb_refuses_without_model_call(settings: Settings) -> None:
    """选了知识库却一条证据都没有：直接给一句明确答复，不烧模型、不伪造引用。"""
    retriever = FakeRetriever(
        [],
        debug={
            "dense_ms": 0,
            "sparse_ms": 0,
            "rerank_ms": 0,
            "filtered": 0,
            "skipped_kbs": [
                {"kb_id": "kb_001", "collection": "kh_demo_1024", "reason": "collection_missing"}
            ],
            "all_collections_missing": True,
            "reason": "no_kb_collection",
        },
    )
    llm = FakeLLM(deltas=("资料", "不足"))
    engine = _engine(settings, retriever, llm)
    events = await _collect(engine, ChatRequest(query="报销流程？", kb_ids=["kb_001"]))
    names = [name for name, _ in events]

    assert events[0] == ("status", {"stage": "route", "kb_selected": True})
    assert "citation" not in names, "empty retrieval must not fabricate citations"
    assert names.count("token") == 1
    assert "资料不足" in "".join(data["delta"] for name, data in events if name == "token") or (
        "没有检索到" in "".join(data["delta"] for name, data in events if name == "token")
    )
    assert names[-1] == "done"
    assert llm.stream_calls == 0, "no evidence means no model call"


async def test_chunks_present_and_model_down_emits_one_error_then_done(settings: Settings) -> None:
    retriever = FakeRetriever(_chunks(2))
    llm = FakeLLM(stream_error=LLMUnavailable("connection refused"))
    engine = _engine(settings, retriever, llm)
    events = await _collect(engine, ChatRequest(query="报销流程？", kb_ids=["kb_001"]))
    names = [name for name, _ in events]
    assert names.count("error") == 1
    error = next(data for name, data in events if name == "error")
    assert error["code"] == "MODEL_UNAVAILABLE"
    assert "connection refused" not in error["message"]
    assert names[-1] == "done"
    assert names.index("error") < names.index("done")


async def test_citation_metadata_uses_doc_title_and_real_url(settings: Settings) -> None:
    long_text = ("无关段落。" * 120) + "差旅报销需要提供发票与行程单" + ("尾部。" * 120)
    chunks = [
        RetrievedChunk(
            chunk_id="c1",
            doc_id="d1",
            title="paragraph",
            title_path=["", "报销制度"],
            text=long_text,
            score=0.8,
            source_url="kh://kb_001/d1",
            block_type="paragraph",
        ),
        RetrievedChunk(
            chunk_id="c2",
            doc_id="d2",
            title="paragraph",
            title_path=["", "差旅规定"],
            text="差旅报销需要提供发票。",
            score=0.7,
            source_url="https://wiki.example.com/policy/2",
            block_type="paragraph",
        ),
    ]
    engine = _engine(settings, FakeRetriever(chunks), FakeLLM())
    events = await _collect(engine, ChatRequest(query="报销发票", kb_ids=["kb_001"]))
    citations = [data for name, data in events if name == "citation"]
    assert len(citations) == 2

    first, second = citations
    assert first["title"] == "报销制度"  # first non-empty title_path segment
    assert first["url"] == ""  # kh:// is never surfaced
    assert first["doc_id"] == "d1"
    assert first["title_path"] == ["报销制度"]
    assert len(first["snippet"]) <= 240
    assert "发票与行程单" in first["snippet"]

    assert second["title"] == "差旅规定"
    assert second["url"] == "https://wiki.example.com/policy/2"


async def test_citation_title_falls_back_to_block_type(settings: Settings) -> None:
    chunk = RetrievedChunk(
        chunk_id="c1",
        doc_id="d1",
        title="",
        title_path=[],
        text="没有任何标题的段落。",
        score=0.5,
        source_url="",
        block_type="table",
    )
    engine = _engine(settings, FakeRetriever([chunk]), FakeLLM())
    events = await _collect(engine, ChatRequest(query="段落", kb_ids=["kb_001"]))
    citation = next(data for name, data in events if name == "citation")
    assert citation["title"] == "table"
    assert citation["url"] == ""


async def test_router_runs_model_when_scene_enabled(settings: Settings) -> None:
    llm = FakeLLM()
    engine = _engine(settings, FakeRetriever(_chunks(1)), llm)
    result = await engine.route(
        ChatRequest(query="报销流程是什么", kb_ids=["kb_001"]), _ticket()
    )
    assert result.choice == "retrieve"
    assert result.degraded is False
    assert result.rule_hit is None
    assert result.model == settings.jev.model
    assert llm.json_calls, "the structured router call must actually run"


async def test_router_rule_hit_is_not_degraded(settings: Settings) -> None:
    llm = FakeLLM()
    engine = _engine(settings, FakeRetriever(_chunks(1)), llm)
    ticket = RetrievalTicket(tenant_id="t_001", user_id="u_1", principals=("user:u_1",), kb_ids=())
    result = await engine.route(ChatRequest(query="你好", kb_ids=[]), ticket)
    assert result.choice == "direct"
    assert result.degraded is False
    assert result.rule_hit == "no_kb"
    assert llm.json_calls == []


async def test_router_degrades_when_gateway_is_down(settings: Settings) -> None:
    llm = FakeLLM(json_error=LLMUnavailable("gateway down"))
    engine = _engine(settings, FakeRetriever(_chunks(1)), llm)
    result = await engine.route(
        ChatRequest(query="报销流程是什么", kb_ids=["kb_001"]), _ticket()
    )
    assert result.choice == "retrieve"
    assert result.degraded is True
    assert result.rule_hit == "model_error"
    assert "gateway" not in result.rationale

async def test_resume_continues_instead_of_restarting(settings: Settings) -> None:
    """断点续传：把半截回答交回模型继续写，并重新带上资料，避免续写部分失去依据。"""
    retriever = FakeRetriever(_chunks(1))
    llm = FakeLLM(deltas=("接着", "写"))
    engine = _engine(settings, retriever, llm)
    events = await _collect(
        engine,
        ChatRequest(
            query="报销流程？",
            kb_ids=["kb_001"],
            resume=True,
            resume_prefix="第一步：准备发票，参见 [c1]",
        ),
    )
    names = [name for name, _ in events]

    # 选了知识库（或正文已有引用）的续写要重新检索，否则 [cN] 对不上来源
    assert len(retriever.calls) == 1
    assert ("status", {"stage": "resume"}) in events
    assert "".join(data["delta"] for name, data in events if name == "token") == "接着写"
    assert names[-1] == "done"
    # 半截回答必须作为 assistant 轮次出现在上下文里，模型才知道从哪里继续
    assert any(message["role"] == "assistant" and "准备发票" in message["content"] for message in llm.messages)
    # 续写时资料也重新进上下文，并重新下发引用
    assert any("<untrusted_context>" in message["content"] for message in llm.messages)
    assert any(name == "citation" for name, _ in events)


async def test_resume_without_kb_or_citations_skips_retrieval(settings: Settings) -> None:
    """纯对话的半截回答续写不需要检索。"""
    retriever = FakeRetriever(_chunks(1))
    engine = _engine(settings, retriever, FakeLLM(deltas=("好",)))
    events = await _collect(
        engine,
        ChatRequest(query="聊聊写作", kb_ids=[], resume=True, resume_prefix="第一段已经写好"),
    )
    assert retriever.calls == []
    assert events[-1][0] == "done"


async def test_resume_without_prefix_asks_for_regeneration(settings: Settings) -> None:
    engine = _engine(settings, FakeRetriever(_chunks(1)), FakeLLM())
    events = await _collect(engine, ChatRequest(query="q", kb_ids=[], resume=True, resume_prefix="  "))
    assert events[0][0] == "error"
    assert events[0][1]["code"] == "BAD_REQUEST"
    assert events[-1][0] == "done"


async def test_prefetch_empty_does_not_inject_context(settings: Settings) -> None:
    """预检索没命中（实时行情这类）→ 不注入材料，交给主 Agent 自己处理。"""
    retriever = FakeRetriever(_chunks(0))
    agent = FakeAgent()
    llm = FakeLLM(router={"choice": "agent", "confidence": 0.9, "rationale": "问的是实时行情", "evidence": []})
    engine = _engine(settings, retriever, llm)
    engine.attach_agent(agent)
    events = await _collect(
        engine,
        ChatRequest(
            query="今天的黄金价格是多少",
            kb_ids=[],
            available_kbs=[{"name": "差旅制度库", "description": "差旅与报销制度"}],
        ),
    )
    # 预检索命中为空（本条用 _chunks(0)）→ 不注入材料，直接交给 Agent
    assert len(agent.requests) == 1
    assert ("status", {"stage": "agent", "reason": "no_kb_pinned"}) in events
    assert agent.requests[0].initial_context == []
    assert events[-1][0] == "done"


async def test_router_agent_choice_still_retrieves_when_kb_selected(settings: Settings) -> None:
    """用户锁定了知识库：即使 router 想交给 agent，也要先检索用户选的范围。"""
    retriever = FakeRetriever(_chunks(1))
    agent = FakeAgent()
    llm = FakeLLM(
        router={"choice": "agent", "confidence": 0.9, "rationale": "看起来像实时信息", "evidence": []},
        deltas=("基于资料回答",),
    )
    engine = _engine(settings, retriever, llm)
    engine.attach_agent(agent)
    events = await _collect(engine, ChatRequest(query="住宿标准", kb_ids=["kb_001"]))
    assert len(retriever.calls) == 1
    assert agent.requests == []
    assert events[-1][0] == "done"


async def test_router_consults_kb_summaries_when_none_selected(settings: Settings) -> None:
    """没选库但用户有可访问的库：不能一刀切直答，要按问题内容判断。"""
    retriever = FakeRetriever(_chunks(1))
    llm = FakeLLM(router={"choice": "retrieve", "confidence": 0.9, "rationale": "问的是公司制度", "evidence": []})
    engine = _engine(settings, retriever, llm)
    events = await _collect(
        engine,
        ChatRequest(
            query="公司住宿标准是多少",
            kb_ids=[],
            available_kbs=[{"name": "差旅制度库", "description": "差旅与报销制度"}],
        ),
    )
    assert len(retriever.calls) == 1
    assert events[-1][0] == "done"
    # 决策上下文里必须带上库名/简介
    router_calls = [
        messages
        for messages in llm.json_messages
        if any('"choice": "retrieve"' in message.get("content", "") for message in messages)
    ]
    assert router_calls, "应有一次 router 决策调用"
    assert "差旅制度库" in json.dumps(router_calls[-1], ensure_ascii=False)


async def test_router_falls_back_to_direct_without_any_kb(settings: Settings) -> None:
    retriever = FakeRetriever(_chunks(1))
    engine = _engine(settings, retriever, FakeLLM())
    events = await _collect(engine, ChatRequest(query="你好", kb_ids=[], available_kbs=[]))
    assert retriever.calls == []
    assert ("status", {"stage": "direct"}) in events


async def test_weak_evidence_without_selected_kb_answers_directly(settings: Settings) -> None:
    """未锁定知识库 + 检索到低分噪声：不能拿不相干片段把回答绑死，退回通用作答。"""
    low = _chunks(1)
    low[0].score = 0.001
    retriever = FakeRetriever(low)
    engine = _engine(settings, retriever, FakeLLM(deltas=("开场白", "如下")))
    events = await _collect(
        engine,
        ChatRequest(
            query="帮我写一段发布会开场白",
            kb_ids=[],
            available_kbs=[{"name": "差旅制度库", "description": "差旅制度"}],
        ),
    )
    names = [name for name, _ in events]
    assert "citation" not in names, "低分片段不该被当成来源展示"
    assert ("status", {"stage": "direct"}) in events
    assert events[-1][0] == "done"


async def test_no_pinned_kb_prefetches_then_delegates_to_main_agent(settings: Settings) -> None:
    """没锁定知识库 → 引擎先跑一次轻量预检索，把命中作为初始材料交给主 Agent。

    这一步是为了让企业制度类问题不依赖"模型愿不愿意调 task"；
    预检索为空时（实时行情、闲聊）就不注入材料，Agent 照常自己用 web_search。
    """
    retriever = FakeRetriever(_chunks(1))
    agent = FakeAgent()
    engine = _engine(settings, retriever, FakeLLM())
    engine.attach_agent(agent)
    events = await _collect(
        engine,
        ChatRequest(query="最近的公司公告是什么？", kb_ids=[], available_kbs=[{"name": "公告库"}]),
    )
    names = [name for name, _ in events]
    assert len(retriever.calls) == 1, "没锁库时只跑一次轻量预检索"
    assert ("status", {"stage": "prefetch", "hits": 1}) in events
    assert ("status", {"stage": "agent", "reason": "no_kb_pinned"}) in events
    assert len(agent.requests) == 1
    assert agent.requests[0].initial_context, "预检索命中要作为初始材料交给 Agent"
    # Agent 的 token 载荷 text 被翻译成 chat 契约的 delta
    assert ("token", {"delta": "已"}) in events and ("token", {"delta": "处理"}) in events
    assert "tool" in names, "工具事件要原样透传给前端"
    assert events[-1][0] == "done"


async def test_jev_miss_with_selected_kb_refuses_instead_of_agent(settings: Settings) -> None:
    """用户锁定知识库却没证据：明确说资料不足，不偷偷换成 Agent 乱答。"""
    retriever = FakeRetriever([])
    agent = FakeAgent()
    engine = _engine(settings, retriever, FakeLLM())
    engine.attach_agent(agent)
    events = await _collect(engine, ChatRequest(query="住宿标准", kb_ids=["kb_001"]))
    assert agent.requests == []
    assert [name for name, _ in events].count("token") == 1
    assert events[-1][0] == "done"


async def test_weak_evidence_with_selected_kb_still_cites_retrieved_chunks(settings: Settings) -> None:
    """用户锁定了知识库：即使分数低也要给出可核对的来源（正文用 [cN] 决定展示哪条）。"""
    low = _chunks(1)
    low[0].score = 0.001
    retriever = FakeRetriever(low)
    engine = _engine(settings, retriever, FakeLLM(deltas=("文中提到 [c1]",)))
    events = await _collect(engine, ChatRequest(query="住宿标准", kb_ids=["kb_001"]))
    assert "citation" in [name for name, _ in events]
    assert events[-1][0] == "done"


async def test_maybe_ask_only_for_short_clarification(settings) -> None:
    """只有“短 + 以问号结尾 + 没引用”的回答才补候选，正常答案不受影响。"""
    from knowledge_hub.engine.chat import ChatEngine, ChatRequest

    engine = ChatEngine.__new__(ChatEngine)
    engine.settings = settings

    class FakeLLM:
        async def chat(self, *args, **kwargs):  # noqa: ANN002, ANN003, ANN202
            return {"choices": [{"message": {"content": '["本季度", "上个月"]'}}]}

    engine.llm = FakeLLM()
    request = ChatRequest(query="帮我写季度复盘")

    ok = await engine._maybe_ask("请确认本次季度复盘的时间范围是？", request)
    assert ok is not None
    assert ok["stage"] == "awaiting_user"
    assert ok["options"] == ["本季度", "上个月"]

    # 带引用的正式回答不应被当成反问
    assert await engine._maybe_ask("住宿上限 600 元。[c1]", request) is None
    # 很长的正文不应触发
    assert await engine._maybe_ask("很长" * 200 + "？", request) is None

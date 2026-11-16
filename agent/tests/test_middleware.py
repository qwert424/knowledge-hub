"""中间件：计划 / 复核 / 安全扫描，以及 ask_user_question 的选项。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from knowledge_hub.config.agent_spec import AgentModelConfig, AgentSpec
from knowledge_hub.config.settings import Settings
from knowledge_hub.runtime.agent import AgentDeps, AgentRequest, AgentRuntime
from knowledge_hub.runtime.middleware import Planner, Reviewer, SecurityGuard
from knowledge_hub.runtime.tools import AskUser, ToolContext, build_toolset
from knowledge_hub.security.tickets import RetrievalTicket
from knowledge_hub.tools.llm import StreamDelta


class FakeLLM:
    """按调用顺序返回预设 JSON / 文本。"""

    def __init__(self, *, json_payloads: list[dict[str, Any]] | None = None, chats: list[str] | None = None) -> None:
        self.json_payloads = list(json_payloads or [])
        self.chats = list(chats or [])
        self.json_calls = 0
        self.chat_calls: list[list[dict[str, Any]]] = []

    async def chat_json(self, messages, **kwargs: Any) -> dict[str, Any]:
        self.json_calls += 1
        return self.json_payloads.pop(0) if self.json_payloads else {}

    async def chat(self, messages, **kwargs: Any) -> dict[str, Any]:
        self.chat_calls.append(messages)
        content = self.chats.pop(0) if self.chats else "好的"
        return {"choices": [{"message": {"content": content}}]}

    async def chat_stream(self, messages, **kwargs: Any) -> AsyncIterator[StreamDelta]:
        yield StreamDelta(text=self.chats.pop(0) if self.chats else "好的")


def _ticket() -> RetrievalTicket:
    return RetrievalTicket(tenant_id="t", user_id="u", principals=("user:u",), kb_ids=())


async def test_planner_builds_plan_and_degrades_silently() -> None:
    llm = FakeLLM(
        json_payloads=[
            {
                "goal": "查报销标准",
                "needs_retrieval": True,
                "steps": [{"step": "检索制度库", "tool": "milvus_search"}, {"step": "总结"}],
                "risk_notes": "",
            }
        ]
    )
    planner = Planner(llm, model="chat-standard")  # type: ignore[arg-type]
    plan = await planner.plan(query="报销多少", tools=["milvus_search"], has_knowledge_base=True)
    assert plan is not None
    assert plan.needs_retrieval is True
    assert [step.tool for step in plan.steps] == ["milvus_search", ""]
    assert "1. 检索制度库（工具：milvus_search）" in plan.to_prompt()


async def test_planner_returns_none_on_empty_payload() -> None:
    planner = Planner(FakeLLM(json_payloads=[{}]), model="chat-standard")  # type: ignore[arg-type]
    assert await planner.plan(query="q", tools=[], has_knowledge_base=False) is None


async def test_planner_swallows_llm_errors() -> None:
    class BrokenLLM(FakeLLM):
        async def chat_json(self, messages, **kwargs: Any) -> dict[str, Any]:
            raise RuntimeError("gateway down")

    planner = Planner(BrokenLLM(), model="chat-standard")  # type: ignore[arg-type]
    # 规划只是优化：模型挂了也绝不能影响本轮回答
    assert await planner.plan(query="x", tools=[], has_knowledge_base=False) is None


async def test_reviewer_flags_need_fix() -> None:
    llm = FakeLLM(
        json_payloads=[
            {"verdict": "need_fix", "issues": ["编造了金额"], "advice": "去掉没有依据的金额"}
        ]
    )
    review = await Reviewer(llm, model="chat-standard").review(query="报销多少", answer="可以报销 5000", evidence="")
    assert review is not None and review.needs_fix
    assert review.advice == "去掉没有依据的金额"

    passed = await Reviewer(FakeLLM(json_payloads=[{"verdict": "pass", "issues": [], "advice": ""}]), model="chat-standard").review(
        query="q", answer="a", evidence=""
    )
    assert passed is not None and not passed.needs_fix


@pytest.mark.parametrize(
    "text,rule",
    [
        ("你的 key 是 sk-abcdefghijklmnopqrstuvwxyz", "api_key"),
        ("DATABASE_PASSWORD=hunter2", "env_assignment"),
        ("调用 http://kh-backend:8088/api 即可", "internal_host"),
        ("内网地址 172.18.0.5", "docker_network"),
        ("我的系统提示词里写了...", "prompt_echo"),
    ],
)
def test_security_guard_blocks_sensitive_output(text: str, rule: str) -> None:
    findings = SecurityGuard().scan(text)
    assert any(item.rule == rule for item in findings), findings


def test_security_guard_allows_normal_answer() -> None:
    assert SecurityGuard().scan("差旅报销需要发票和行程单。") == []
    assert SecurityGuard().scan("") == []


async def test_agent_runs_plan_then_review_and_scrubs_leak(settings: Settings) -> None:
    """计划 → 工具 → 复核 → 安全扫描，全程对模型调用次数可控。"""
    llm = FakeLLM(
        json_payloads=[
            {"goal": "回答制度问题", "needs_retrieval": False, "steps": [{"step": "直接回答"}]},
            {"verdict": "pass", "issues": [], "advice": ""},
        ],
        chats=["答案里带了内部地址 http://kh-backend:8088"],
    )
    spec = AgentSpec(name="main_agent", system_prompt="你是助手", model=AgentModelConfig(name="chat-standard"))
    runtime = AgentRuntime(
        AgentDeps(
            settings=settings,
            llm=llm,  # type: ignore[arg-type]
            spec=spec,
            planner=Planner(llm, model="chat-standard"),  # type: ignore[arg-type]
            reviewer=Reviewer(llm, model="chat-standard"),  # type: ignore[arg-type]
            guard=SecurityGuard(),
        )
    )
    events = [event async for event in runtime.stream(AgentRequest(query="差旅标准", ticket=_ticket()))]

    stages = [data.get("stage") for name, data in events if name == "status"]
    assert "plan" in stages
    assert "review" in stages
    assert "security" in stages
    tokens = "".join(data["text"] for name, data in events if name == "token")
    assert "kh-backend" not in tokens
    assert tokens == SecurityGuard.safe_reply()


async def test_ask_user_question_carries_options(settings: Settings) -> None:
    ctx = ToolContext(settings=settings, ticket=_ticket())
    toolset = build_toolset(["ask_user_question"], ctx)
    with pytest.raises(AskUser) as excinfo:
        await toolset.tools["ask_user_question"].handler(
            question="查哪个城市？", options=["北京", "上海", "  "], ctx=ctx
        )
    assert excinfo.value.options == ["北京", "上海"]

"""Agent runtime: tool selection, tool calls, subagent delegation, sandbox gating."""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

import pytest

from knowledge_hub.config.agent_spec import AgentModelConfig, AgentSpec
from knowledge_hub.config.settings import Settings
from knowledge_hub.runtime.agent import AgentDeps, AgentRequest, AgentRuntime
from knowledge_hub.runtime.sandbox import SandboxClient, SandboxUnavailable
from knowledge_hub.runtime.tools import AskUser, ToolContext, build_toolset
from knowledge_hub.security.tickets import RetrievalTicket


class FakeLLM:
    """Replays scripted responses and records prompts."""

    def __init__(self, responses: Sequence[dict[str, Any]]) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    async def chat(self, messages, **kwargs):  # noqa: ANN001
        self.calls.append({"messages": list(messages), **kwargs})
        if self.responses:
            return self.responses.pop(0)
        return _answer("没有更多脚本响应")


class FakeRetriever:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def retrieve(self, **kwargs):  # noqa: ANN003
        self.calls.append(kwargs)

        class _Chunk:
            chunk_id = "c1"
            doc_id = "doc1"
            title = "差旅制度"
            title_path = ["差旅", "标准"]
            source_url = ""
            score = 0.82
            text = "一线城市住宿上限 600 元。"

        class _Result:
            chunks = [_Chunk()]

        return _Result()


class FakeSandbox:
    configured = True

    def __init__(self) -> None:
        self.executed: list[str] = []

    async def execute(self, key: str, command: str, timeout_seconds: int = 90):
        self.executed.append(command)

        class _Result:
            exit_code = 0
            output = "hello from sandbox"

        return _Result()

    async def write_text(self, key: str, path: str, content: str) -> None:
        self.executed.append(f"write {path}")

    async def read_text(self, key: str, path: str) -> str:
        return "file body"


def _answer(text: str) -> dict[str, Any]:
    return {"choices": [{"message": {"role": "assistant", "content": text}}]}


def _tool_call(name: str, arguments: dict[str, Any], call_id: str = "call-1") -> dict[str, Any]:
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                    ],
                }
            }
        ]
    }


def _ticket() -> RetrievalTicket:
    return RetrievalTicket(
        tenant_id="t_001",
        user_id="u_1",
        principals=("user:u_1",),
        kb_ids=("kb_001",),
    )


def _spec(**overrides: Any) -> AgentSpec:
    data: dict[str, Any] = {
        "name": "main_agent",
        "system_prompt": "你是主 Agent。",
        "model": AgentModelConfig(name="chat-standard"),
        "tools": ["get_current_time"],
        "subagents": [],
        "source": "nacos",
    }
    data.update(overrides)
    return AgentSpec(**data)


async def _drain(runtime: AgentRuntime, request: AgentRequest) -> list[tuple[str, dict[str, Any]]]:
    return [event async for event in runtime.stream(request)]


# ------------------------------------------------------------------- tool gating
def test_toolset_only_advertises_configured_tools(settings: Settings) -> None:
    ctx = ToolContext(settings=settings, ticket=_ticket())

    toolset = build_toolset(
        ["get_current_time", "web_search", "sandbox_exec", "deploy"], ctx
    )

    assert set(toolset.tools) == {"get_current_time"}
    # Unavailable tools are reported, never silently faked.
    assert set(toolset.skipped) == {"web_search", "sandbox_exec", "deploy"}


def test_retrieval_tools_require_a_retriever(settings: Settings) -> None:
    ctx = ToolContext(settings=settings, ticket=_ticket())
    assert "milvus_search" not in build_toolset(["milvus_search"], ctx).tools

    ctx.retriever = FakeRetriever()
    assert "milvus_search" in build_toolset(["milvus_search"], ctx).tools


def test_sandbox_tools_require_credentials(settings: Settings) -> None:
    unconfigured = ToolContext(
        settings=settings, ticket=_ticket(), sandbox=SandboxClient()
    )
    assert "sandbox_exec" not in build_toolset(["sandbox_exec"], unconfigured).tools

    configured = ToolContext(
        settings=settings,
        ticket=_ticket(),
        sandbox=SandboxClient(domain="sandbox:8080", api_key="k"),
    )
    assert "sandbox_exec" in build_toolset(["sandbox_exec"], configured).tools


# --------------------------------------------------------------------- the loop
@pytest.mark.asyncio
async def test_plain_answer_returns_without_tools(settings: Settings) -> None:
    llm = FakeLLM([_answer("你好，我是知识助手。")])
    runtime = AgentRuntime(AgentDeps(settings=settings, llm=llm, spec=_spec(tools=[])))

    events = await _drain(runtime, AgentRequest(query="你好", ticket=_ticket()))

    kinds = [kind for kind, _ in events]
    assert kinds[0] == "status"
    assert events[0][1]["spec"] == "main_agent"
    assert ("token", {"text": "你好，我是知识助手。"}) in events
    assert kinds[-1] == "done"
    # 没有工具时不要把 schemas 发上去（既省 token 也避免模型硬凑工具调用）
    assert "tools" not in llm.calls[0]


@pytest.mark.asyncio
async def test_tool_call_is_executed_and_result_fed_back(settings: Settings) -> None:
    llm = FakeLLM([_tool_call("get_current_time", {}), _answer("现在是周五。")])
    runtime = AgentRuntime(AgentDeps(settings=settings, llm=llm, spec=_spec()))

    events = await _drain(runtime, AgentRequest(query="今天几号？", ticket=_ticket()))

    assert events[0][1]["tools"] == ["get_current_time"]
    assert any(kind == "tool" and data["name"] == "get_current_time" for kind, data in events)
    assert ("token", {"text": "现在是周五。"}) in events
    # the tool result is appended before the second model call
    second = llm.calls[1]["messages"]
    assert second[-1]["role"] == "tool"
    assert second[-1]["name"] == "get_current_time"


@pytest.mark.asyncio
async def test_retrieval_tool_uses_ticket_scope(settings: Settings) -> None:
    retriever = FakeRetriever()
    llm = FakeLLM(
        [
            _tool_call("milvus_search", {"query": "住宿标准"}),
            _answer("一线城市 600 元。[1]"),
        ]
    )
    runtime = AgentRuntime(
        AgentDeps(
            settings=settings,
            llm=llm,
            spec=_spec(tools=["milvus_search"]),
            retriever=retriever,
        )
    )

    events = await _drain(
        runtime, AgentRequest(query="住宿标准多少？", ticket=_ticket(), kb_ids=["kb_001"])
    )

    assert retriever.calls[0]["kb_ids"] == ["kb_001"]
    assert retriever.calls[0]["ticket"].tenant_id == "t_001"
    tool_payload = next(data for kind, data in events if kind == "tool")
    assert tool_payload["name"] == "milvus_search"
    # the retrieved text reaches the model
    assert "住宿上限" in json.dumps(llm.calls[1]["messages"], ensure_ascii=False)


@pytest.mark.asyncio
async def test_ask_user_question_stops_the_turn(settings: Settings) -> None:
    llm = FakeLLM([_tool_call("ask_user_question", {"question": "你要查哪个城市？"})])
    runtime = AgentRuntime(
        AgentDeps(settings=settings, llm=llm, spec=_spec(tools=["ask_user_question"]))
    )

    events = await _drain(runtime, AgentRequest(query="住宿标准？", ticket=_ticket()))

    ask = next(data for kind, data in events if kind == "status" and data.get("stage") == "awaiting_user")
    assert ask["question"] == "你要查哪个城市？"
    # 模型没给候选时必须有确定性兜底，否则前端只能显示“请自己在下面补充”
    assert len(ask["options"]) >= 2
    assert events[-1][0] == "done"
    assert events[-1][1]["awaiting_user"] is True


@pytest.mark.asyncio
async def test_unknown_tool_is_reported_to_the_model(settings: Settings) -> None:
    llm = FakeLLM([_tool_call("deploy", {"path": "x"}), _answer("我无法部署。")])
    runtime = AgentRuntime(AgentDeps(settings=settings, llm=llm, spec=_spec()))

    events = await _drain(runtime, AgentRequest(query="部署一下", ticket=_ticket()))

    tool_message = llm.calls[1]["messages"][-1]
    assert "不可用" in tool_message["content"]
    assert ("token", {"text": "我无法部署。"}) in events


@pytest.mark.asyncio
async def test_step_budget_returns_partial_answer(settings: Settings) -> None:
    looping = [_tool_call("get_current_time", {}, f"call-{i}") for i in range(3)]
    llm = FakeLLM([*looping, _answer("已尽力回答。")])
    runtime = AgentRuntime(
        AgentDeps(settings=settings, llm=llm, spec=_spec(), max_steps=2)
    )

    events = await _drain(runtime, AgentRequest(query="循环", ticket=_ticket()))

    assert any(kind == "status" and data["stage"] == "step_budget_exhausted" for kind, data in events)
    assert events[-1][0] == "done"


@pytest.mark.asyncio
async def test_llm_failure_is_an_error_event(settings: Settings) -> None:
    class BoomLLM:
        async def chat(self, *args, **kwargs):
            raise RuntimeError("gateway down")

    runtime = AgentRuntime(AgentDeps(settings=settings, llm=BoomLLM(), spec=_spec()))

    events = await _drain(runtime, AgentRequest(query="hi", ticket=_ticket()))

    assert events[-2][0] == "error"
    assert events[-1][0] == "done"


# ----------------------------------------------------------------- subagents
@pytest.mark.asyncio
async def test_task_delegates_to_subagent_with_its_own_spec(settings: Settings) -> None:
    retrieve_spec = AgentSpec(
        name="retrieve_agent",
        system_prompt="你是检索 Agent。",
        model=AgentModelConfig(name="chat-standard"),
        tools=["milvus_search"],
        source="nacos",
    )
    retriever = FakeRetriever()
    llm = FakeLLM(
        [
            _tool_call("task", {"subagent_type": "retrieve_agent", "description": "查住宿标准"}),
            _answer("一线城市 600 元。"),
            _answer("检索结论：一线城市 600 元。"),
        ]
    )
    runtime = AgentRuntime(
        AgentDeps(
            settings=settings,
            llm=llm,
            spec=_spec(subagents=["retrieve_agent"], tools=["task"]),
            retriever=retriever,
            spec_loader=lambda name: (retrieve_spec, None)
            if name == "retrieve_agent"
            else (_spec(), f"{name} not found"),
        )
    )

    events = await _drain(runtime, AgentRequest(query="住宿标准？", ticket=_ticket()))

    assert events[0][1]["subagents"] == ["retrieve_agent"]
    assert any(data.get("name") == "task" for kind, data in events if kind == "tool")
    task_message = next(
        message for message in llm.calls[0]["messages"] if message["role"] == "user"
    )
    assert "住宿标准" in str(task_message["content"])
    # the subagent's answer is fed back to the main agent as the tool result
    assert "一线城市 600 元。" in llm.calls[2]["messages"][-1]["content"]
    assert ("token", {"text": "检索结论：一线城市 600 元。"}) in events


@pytest.mark.asyncio
async def test_missing_subagent_spec_is_reported(settings: Settings) -> None:
    llm = FakeLLM(
        [
            _tool_call("task", {"subagent_type": "retrieve_agent", "description": "查"}),
            _answer("无法检索。"),
        ]
    )
    runtime = AgentRuntime(
        AgentDeps(
            settings=settings,
            llm=llm,
            spec=_spec(subagents=["retrieve_agent"], tools=["task"]),
            spec_loader=lambda name: (_spec(), f"agentspec {name} not found"),
        )
    )

    events = await _drain(runtime, AgentRequest(query="查一下", ticket=_ticket()))

    feedback = llm.calls[1]["messages"][-1]["content"]
    assert "不可用" in feedback and "not found" in feedback
    assert ("token", {"text": "无法检索。"}) in events


# --------------------------------------------------------------------- sandbox
@pytest.mark.asyncio
async def test_sandbox_exec_runs_in_the_session(settings: Settings) -> None:
    sandbox = FakeSandbox()
    llm = FakeLLM(
        [
            _tool_call("sandbox_exec", {"command": "echo hi"}),
            _answer("执行完成。"),
        ]
    )
    runtime = AgentRuntime(
        AgentDeps(
            settings=settings,
            llm=llm,
            spec=_spec(tools=["sandbox_exec"]),
            sandbox=sandbox,  # type: ignore[arg-type]
        )
    )

    await _drain(
        runtime,
        AgentRequest(query="跑个命令", ticket=_ticket(), conversation_id="conv-9"),
    )

    assert sandbox.executed == ["echo hi"]
    tool_result = llm.calls[1]["messages"][-1]["content"]
    assert "hello from sandbox" in tool_result


@pytest.mark.asyncio
async def test_sandbox_failure_does_not_break_the_turn(settings: Settings) -> None:
    class BrokenSandbox(FakeSandbox):
        async def execute(self, key: str, command: str, timeout_seconds: int = 90):
            raise SandboxUnavailable("server down")

    llm = FakeLLM([_tool_call("sandbox_exec", {"command": "ls"}), _answer("沙箱不可用。")])
    runtime = AgentRuntime(
        AgentDeps(
            settings=settings,
            llm=llm,
            spec=_spec(tools=["sandbox_exec"]),
            sandbox=BrokenSandbox(),  # type: ignore[arg-type]
        )
    )

    events = await _drain(runtime, AgentRequest(query="ls", ticket=_ticket()))

    assert "沙箱不可用" in llm.calls[1]["messages"][-1]["content"]
    assert events[-1][0] == "done"


def test_ask_user_is_not_swallowed_by_tool_error_handling() -> None:
    with pytest.raises(AskUser):
        raise AskUser("请补充")



@pytest.mark.asyncio
async def test_inline_task_tag_is_executed_not_passed_through(settings: Settings) -> None:
    """旧版提示词让模型输出 <task>{...}</task>：必须真的执行委派，
    不能把这段标签当正文交给用户（否则界面就是"请稍等片刻"然后什么也没发生）。"""
    inline = (
        '好的，请稍等。<task>{"subagent_type": "retrieve_agent", '
        '"description": "查一下今天的黄金价格"}</task>'
    )
    retrieve_spec = AgentSpec(
        name="retrieve_agent",
        system_prompt="你是检索 Agent。",
        model=AgentModelConfig(name="chat-standard"),
        tools=["get_current_time"],
        source="nacos",
    )
    llm = FakeLLM([
        _answer(inline),
        _answer("子 Agent：黄金约 600 元/克。"),
        _answer("今天黄金约 600 元/克。"),
    ])
    sub_calls: list[tuple[str, str]] = []
    runtime = AgentRuntime(
        AgentDeps(
            settings=settings,
            llm=llm,
            spec=_spec(subagents=["retrieve_agent"], tools=["task"]),
            spec_loader=lambda name: (retrieve_spec, None),
        )
    )
    original = runtime.delegate

    async def _spy(ctx, name, task):  # noqa: ANN001
        sub_calls.append((name, task))
        return await original(ctx, name, task)

    runtime.delegate = _spy  # type: ignore[method-assign]

    events = await _drain(runtime, AgentRequest(query="黄金的价格", ticket=_ticket()))

    assert any(kind == "tool" and data["name"] == "task" for kind, data in events)
    assert sub_calls == [("retrieve_agent", "查一下今天的黄金价格")]
    text = "".join(data.get("text", "") for kind, data in events if kind == "token")
    assert "<task>" not in text, "占位标签不能出现在最终回答里"
    assert "今天黄金约 600 元/克" in text


def test_parse_option_list_accepts_json_array() -> None:
    from knowledge_hub.runtime.agent import _parse_option_list

    assert _parse_option_list('["本季度", "上个月", "全年"]') == ["本季度", "上个月", "全年"]
    # 模型多说了一句也要能拿到数组
    assert _parse_option_list('好的：["A", "B"]。') == ["A", "B"]
    # 不足两个就当没有
    assert _parse_option_list('["只有一个"]') == []
    assert _parse_option_list("没有数组") == []


def test_last_assistant_text_skips_empty() -> None:
    from knowledge_hub.runtime.agent import _last_assistant_text

    messages = [
        {"role": "user", "content": "你好"},
        {"role": "assistant", "content": ""},
        {"role": "assistant", "content": "请确认时间范围是？"},
    ]
    assert _last_assistant_text(messages) == "请确认时间范围是？"
    assert _last_assistant_text([{"role": "user", "content": "x"}]) == ""


def test_parse_option_list_accepts_plain_lines() -> None:
    """模型经常不输出 JSON，而是整理成 1. 2. 3. 的行列表。"""
    from knowledge_hub.runtime.agent import _parse_option_list

    assert _parse_option_list("1. 产品介绍\n2. 年度总结") == ["产品介绍", "年度总结"]
    assert _parse_option_list("- 本季度\n- 上个月") == ["本季度", "上个月"]
    assert _parse_option_list("只有一行") == []


def test_strip_inline_task_removes_protocol_tag() -> None:
    """模型把 <task> 当文本吐出来时，用户不能看到内部协议。"""
    from knowledge_hub.runtime.agent import _strip_inline_task

    raw = '资料中没有今天的黄金价格。<task>{"subagent_type":"retrieve_agent","description":"查黄金"}</task>'
    cleaned = _strip_inline_task(raw)
    assert "<task>" not in cleaned and "</task>" not in cleaned
    assert "资料中没有今天的黄金价格。" in cleaned


def test_capability_block_forbids_inline_task(settings) -> None:
    """能力清单里要明确要求用 task 工具，而不是写标签。"""
    from knowledge_hub.engine.prompts import capability_block

    block = capability_block(settings.agent_spec)
    if "task" in (settings.agent_spec.tools or []):
        assert "task 工具" in block
        assert "<task>" in block


def test_render_submission_turns_json_into_markdown() -> None:
    """子 Agent 的四字段 JSON 要转成主 Agent 好读的正文，不能把 JSON 直接塞回去。"""
    from knowledge_hub.runtime.agent import _render_submission

    raw = (
        '{"status":"partial","answer":"住宿上限 600 元。[c1]",'
        '"sources":[{"title":"差旅报销标准","url":"kh://doc/1"}],'
        '"gaps":["缺少二线城市数据"]}'
    )
    out = _render_submission(raw)
    assert "{" not in out
    assert "住宿上限 600 元" in out
    assert "差旅报销标准" in out
    assert "缺少二线城市数据" in out
    assert "partial" in out
    # 普通正文不被改动
    assert _render_submission("你好") == "你好"


def test_sanitize_images_drops_self_invented_links() -> None:
    """只保留来自检索/工具的图片链接，自拼的降级成文字。"""
    from knowledge_hub.runtime.agent import _sanitize_images

    allowed = {"http://127.0.0.1:9002/knowledge-hub/feishu-images/ok.png"}
    text = (
        "产品外观：\n"
        "![正面](http://127.0.0.1:9002/knowledge-hub/feishu-images/ok.png)\n"
        "![背面](http://example.com/made-up.png)"
    )
    out = _sanitize_images(text, allowed)
    assert "feishu-images/ok.png" in out
    assert "made-up.png" not in out
    assert "背面" in out


def test_sanitize_images_keeps_plain_text() -> None:
    from knowledge_hub.runtime.agent import _sanitize_images

    assert _sanitize_images("没有图片的回答", set()) == "没有图片的回答"


def test_collect_image_urls_from_prefetch() -> None:
    from knowledge_hub.runtime.agent import _collect_image_urls

    chunks = [
        {"metadata": {"image_url": "http://x/1.png"}},
        {"image_url": "http://x/2.png"},
        {"metadata": {"title": "no image"}},
    ]
    assert _collect_image_urls(chunks) == {"http://x/1.png", "http://x/2.png"}

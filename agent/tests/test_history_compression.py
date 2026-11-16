"""会话历史压缩：长对话压成摘要，短对话原样，失败降级。"""

from __future__ import annotations

from typing import Any

import pytest

from knowledge_hub.engine.history import MIN_MESSAGES, compress_history


class FakeLLM:
    def __init__(self, reply: str = "用户问过差旅标准，已答一线城市 600 元。", *, boom: bool = False) -> None:
        self.reply = reply
        self.boom = boom
        self.calls: list[list[dict[str, str]]] = []

    async def chat(self, messages, **kwargs: Any) -> dict[str, Any]:  # noqa: ANN001
        self.calls.append(list(messages))
        if self.boom:
            raise RuntimeError("gateway down")
        return {"choices": [{"message": {"content": self.reply}}]}


class FakeRedis:
    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    async def get(self, key: str) -> str | None:
        return self.data.get(key)

    async def set(self, key: str, value: str, ex: int | None = None) -> None:  # noqa: ARG002
        self.data[key] = value


def _history(turns: int) -> list[dict[str, str]]:
    history: list[dict[str, str]] = []
    for index in range(turns):
        history.append({"role": "user", "content": f"问题 {index}"})
        history.append({"role": "assistant", "content": f"回答 {index}"})
    return history


@pytest.mark.asyncio
async def test_short_history_is_left_alone() -> None:
    llm = FakeLLM()
    summary, recent = await compress_history(
        history=_history(2), llm=llm, model="chat-basic"
    )
    assert summary == ""
    assert len(recent) == 4
    assert llm.calls == []


@pytest.mark.asyncio
async def test_long_history_is_summarised_and_tail_kept() -> None:
    llm = FakeLLM()
    redis = FakeRedis()
    history = _history(12)  # 24 条，超过 MIN_MESSAGES
    summary, recent = await compress_history(
        history=history, llm=llm, model="chat-basic", conversation_id="conv-1", redis=redis
    )
    assert summary.startswith("用户问过差旅标准")
    # 最近的 8 条原样带上，前面的都不再重复塞进上下文
    assert len(recent) == 8
    assert recent[-1]["content"] == "回答 11"
    assert len(llm.calls) == 1
    assert "conv-1" in "".join(redis.data)


@pytest.mark.asyncio
async def test_summary_is_reused_from_cache() -> None:
    llm = FakeLLM()
    redis = FakeRedis()
    history = _history(12)
    await compress_history(history=history, llm=llm, model="chat-basic", conversation_id="c", redis=redis)
    # 同一会话再来一轮：历史只多两条，缓存覆盖的前缀仍然有效，不该再调模型
    _, recent = await compress_history(
        history=[*history, {"role": "user", "content": "还有别的吗"}, {"role": "assistant", "content": "没有"}],
        llm=llm,
        model="chat-basic",
        conversation_id="c",
        redis=redis,
    )
    assert len(llm.calls) == 1
    assert recent[-1]["content"] == "没有"


@pytest.mark.asyncio
async def test_summary_failure_falls_back_to_raw_history() -> None:
    llm = FakeLLM(boom=True)
    summary, recent = await compress_history(
        history=_history(MIN_MESSAGES), llm=llm, model="chat-basic"
    )
    assert summary == ""
    assert len(recent) == 8

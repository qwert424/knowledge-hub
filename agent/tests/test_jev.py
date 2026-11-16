"""JEV: rules first, structured model call second, deterministic fallback always."""

from __future__ import annotations

from typing import Any

import pytest

from knowledge_hub.config.settings import Settings
from knowledge_hub.decision.jev import Jev, JevOption
from knowledge_hub.errors import LLMUnavailable


class ExplodingLLM:
    """Any model call is a test failure."""

    async def chat_json(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        raise AssertionError("model must not be called")


class StubLLM:
    def __init__(self, payload: dict[str, Any] | Exception) -> None:
        self.payload = payload
        self.calls = 0
        self.last_messages: list[dict[str, str]] = []

    async def chat_json(
        self,
        messages: list[dict[str, str]],
        *,
        model: str,
        json_schema: dict[str, Any],
        schema_name: str = "decision",
        temperature: float = 0.0,
        max_tokens: int = 512,
        timeout_s: float | None = None,
    ) -> dict[str, Any]:
        self.calls += 1
        self.last_messages = messages
        self.enum = json_schema["properties"]["choice"]["enum"]
        if isinstance(self.payload, Exception):
            raise self.payload
        return dict(self.payload)


async def test_empty_retrieval_uses_rule(settings: Settings) -> None:
    jev = Jev(settings, ExplodingLLM())  # type: ignore[arg-type]
    result = await jev.decide(
        "judge",
        {"chunk_count": 0, "empty_retrieval": True},
        ["answer", "answer_with_caveat", "refuse"],
    )
    assert result.choice == "answer_with_caveat"
    assert result.rule_hit == "empty_retrieval"
    assert result.confidence == 1.0
    assert result.degraded is False


async def test_no_permission_rule(settings: Settings) -> None:
    jev = Jev(settings, ExplodingLLM())  # type: ignore[arg-type]
    result = await jev.decide("router", {"no_permission": True, "kb_ids": ["kb_1"]}, ["retrieve", "refuse"])
    assert result.choice == "refuse"
    assert result.rule_hit == "no_permission"


async def test_tenant_mismatch_rule(settings: Settings) -> None:
    jev = Jev(settings, ExplodingLLM())  # type: ignore[arg-type]
    result = await jev.decide("router", {"tenant_mismatch": True, "kb_ids": ["kb_1"]}, ["retrieve", "refuse"])
    assert result.choice == "refuse"
    assert result.rule_hit == "tenant_mismatch"


async def test_no_kb_rule_routes_direct(settings: Settings) -> None:
    jev = Jev(settings, ExplodingLLM())  # type: ignore[arg-type]
    result = await jev.decide("router", {"kb_ids": []}, ["retrieve", "direct"])
    assert result.choice == "direct"
    assert result.rule_hit == "no_kb"


async def test_model_choice_used_when_rules_miss(settings: Settings) -> None:
    llm = StubLLM(
        {"choice": "retrieve", "confidence": 0.91, "rationale": "问题需要制度原文", "evidence": ["kb_001"]}
    )
    jev = Jev(settings, llm)  # type: ignore[arg-type]
    result = await jev.decide("router", {"kb_ids": ["kb_001"], "query_length": 20}, ["retrieve", "direct"])
    assert result.choice == "retrieve"
    assert result.confidence == pytest.approx(0.91)
    assert result.degraded is False
    assert llm.calls == 1
    assert llm.enum == ["retrieve", "direct"]
    assert "JEV" in llm.last_messages[0]["content"]
    assert "retrieve" in llm.last_messages[1]["content"]


async def test_out_of_set_choice_falls_back(settings: Settings) -> None:
    llm = StubLLM({"choice": "invented", "confidence": 0.99, "rationale": "x", "evidence": []})
    jev = Jev(settings, llm)  # type: ignore[arg-type]
    result = await jev.decide("router", {"kb_ids": ["kb_1"]}, ["retrieve", "direct"])
    assert result.choice == "retrieve"
    assert result.degraded is True
    assert result.rule_hit == "invalid_choice"


async def test_model_error_falls_back(settings: Settings) -> None:
    llm = StubLLM(LLMUnavailable("gateway down"))
    jev = Jev(settings, llm)  # type: ignore[arg-type]
    result = await jev.decide("router", {"kb_ids": ["kb_1"]}, ["retrieve", "direct"])
    assert result.choice == "retrieve"
    assert result.degraded is True
    assert result.rule_hit == "model_error"
    assert "gateway" not in result.rationale


async def test_low_confidence_uses_fallback(settings: Settings) -> None:
    llm = StubLLM({"choice": "retrieve", "confidence": 0.1, "rationale": "不确定", "evidence": []})
    jev = Jev(settings, llm)  # type: ignore[arg-type]
    result = await jev.decide("router", {"kb_ids": ["kb_1"]}, ["retrieve", "direct"])
    assert result.choice == "retrieve"
    assert result.degraded is True
    assert result.rule_hit == "below_min_confidence"


async def test_model_disabled_uses_fallback_without_calling(settings: Settings) -> None:
    jev = Jev(settings, ExplodingLLM())  # type: ignore[arg-type]
    result = await jev.decide(
        "router", {"kb_ids": ["kb_1"]}, ["retrieve", "direct"], {"allow_model": False}
    )
    assert result.choice == "retrieve"
    # A policy decision is not a degradation.
    assert result.degraded is False
    assert result.rule_hit == "model_disabled"


async def test_missing_model_is_degraded(settings: Settings) -> None:
    jev = Jev(settings, None)
    result = await jev.decide("router", {"kb_ids": ["kb_1"]}, ["retrieve", "direct"])
    assert result.choice == "retrieve"
    assert result.degraded is True
    assert result.rule_hit == "model_unconfigured"


@pytest.mark.parametrize(
    ("scene", "context", "options", "expected_choice", "rule"),
    [
        ("router", {"no_permission": True, "kb_ids": ["kb_1"]}, ["retrieve", "refuse"], "refuse", "no_permission"),
        ("router", {"tenant_mismatch": True, "kb_ids": ["kb_1"]}, ["retrieve", "refuse"], "refuse", "tenant_mismatch"),
        ("router", {"kb_ids": []}, ["retrieve", "direct"], "direct", "no_kb"),
        ("router", {"no_kb_collections": True, "kb_ids": ["kb_1"]}, ["retrieve", "direct", "no_kb"], "no_kb", "no_kb_collections"),
        ("judge", {"chunk_count": 0}, ["answer", "answer_with_caveat", "refuse"], "answer_with_caveat", "empty_retrieval"),
        ("router", {"retrieval_disabled": True, "kb_ids": ["kb_1"]}, ["retrieve", "direct"], "direct", "retrieval_disabled"),
    ],
)
async def test_rule_hits_are_not_degraded(
    settings: Settings,
    scene: str,
    context: dict[str, object],
    options: list[str],
    expected_choice: str,
    rule: str,
) -> None:
    jev = Jev(settings, ExplodingLLM())  # type: ignore[arg-type]
    result = await jev.decide(scene, context, options)
    assert result.choice == expected_choice
    assert result.rule_hit == rule
    assert result.degraded is False
    assert result.rationale.startswith(rule)


async def test_forced_choice(settings: Settings) -> None:
    jev = Jev(settings, ExplodingLLM())  # type: ignore[arg-type]
    result = await jev.decide(
        "router", {"kb_ids": ["kb_1"]}, ["retrieve", "direct"], {"force_choice": "direct"}
    )
    assert result.choice == "direct"
    assert result.rule_hit == "forced_choice"


async def test_empty_options_rejected(settings: Settings) -> None:
    jev = Jev(settings, ExplodingLLM())  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        await jev.decide("router", {}, [])


async def test_audit_log_contains_required_fields(settings: Settings) -> None:
    llm = StubLLM({"choice": "answer", "confidence": 0.8, "rationale": "ok", "evidence": ["c1"]})
    jev = Jev(settings, llm)  # type: ignore[arg-type]
    result = await jev.decide("judge", {"chunk_count": 3, "top_score": 0.8}, ["answer", "refuse"])
    log = result.to_log()
    assert {"scene", "options", "choice", "confidence", "rationale", "evidence", "fallback", "degraded"} <= set(log)
    assert log["evidence"] == [{"ref": "c1"}]


async def test_option_descriptions_are_passed_to_model(settings: Settings) -> None:
    llm = StubLLM({"choice": "retrieve", "confidence": 0.9, "rationale": "ok", "evidence": []})
    jev = Jev(settings, llm)  # type: ignore[arg-type]
    await jev.decide(
        "router",
        {"kb_ids": ["kb_1"]},
        [JevOption("retrieve", "需要检索"), JevOption("direct", "直接回答")],
    )
    assert "需要检索" in llm.last_messages[1]["content"]

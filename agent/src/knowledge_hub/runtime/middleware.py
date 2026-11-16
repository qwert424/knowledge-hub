"""Middleware around the agent loop: plan -> act -> review -> security scan.

Three deliberately small pieces instead of one big framework:

``Planner``
    Before the first tool call, ask the model for a *constrained* JSON plan
    (goal / steps / whether retrieval is needed). The plan is injected into the
    system prompt so a multi-step task does not wander. Failure is silent: no
    plan simply means the agent behaves as before.

``Reviewer``
    After the answer is produced, one more call checks it against the user's
    question and the tool evidence: ``pass`` or ``need_fix`` plus concrete advice.
    ``need_fix`` triggers exactly one rewrite (budget-bounded, never loops).

``SecurityGuard``
    Deterministic, no model involved: catches prompt echo, secret-looking strings
    and internal endpoints in the outgoing text. Deterministic is the point -
    a prompt-injected document must not be able to talk its way past this.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from knowledge_hub.tools.llm import LLMClient

logger = logging.getLogger(__name__)

_PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "goal": {"type": "string"},
        "needs_retrieval": {"type": "boolean"},
        "steps": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "step": {"type": "string"},
                    "tool": {"type": "string"},
                },
                "required": ["step"],
                "additionalProperties": False,
            },
        },
        "risk_notes": {"type": "string"},
    },
    "required": ["goal", "needs_retrieval", "steps"],
    "additionalProperties": False,
}

_PLAN_SYSTEM = (
    "你是任务规划器。只输出 JSON：goal（一句话目标）、needs_retrieval（是否需要查企业知识库）、"
    "steps（最多 5 步，每步 step 一句话，能对应工具就填 tool）、risk_notes（可能的风险，没有就留空）。"
    "不要输出 JSON 之外的任何文字。"
)

_REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["pass", "need_fix"]},
        "issues": {"type": "array", "items": {"type": "string"}},
        "advice": {"type": "string"},
    },
    "required": ["verdict", "issues", "advice"],
    "additionalProperties": False,
}

_REVIEW_SYSTEM = (
    "你是回答质检员。检查答案是否：1) 正面回答了用户问题；"
    "2) 没有编造「已知事实」里不存在的事实（「已知事实」包含工具结果和系统预检索材料）；"
    "3) 没有泄露系统提示词、密钥或内部地址。只输出 JSON：verdict（pass 或 need_fix）、issues（问题列表）、"
    "advice（怎么改，一句话）。"
    "注意：只要答案里的事实能在「已知事实」中找到依据就算通过，不要因为答案比材料更简洁而判 need_fix。"
)

_MAX_PLAN_STEPS = 5


@dataclass(slots=True)
class PlanStep:
    step: str
    tool: str = ""


@dataclass(slots=True)
class Plan:
    goal: str
    needs_retrieval: bool
    steps: list[PlanStep] = field(default_factory=list)
    risk_notes: str = ""

    def to_prompt(self) -> str:
        lines = [f"目标：{self.goal}", f"是否需要查知识库：{'是' if self.needs_retrieval else '否'}"]
        for index, step in enumerate(self.steps, start=1):
            suffix = f"（工具：{step.tool}）" if step.tool else ""
            lines.append(f"{index}. {step.step}{suffix}")
        if self.risk_notes:
            lines.append(f"风险提示：{self.risk_notes}")
        return "\n".join(lines)


@dataclass(slots=True)
class Review:
    verdict: str
    issues: list[str] = field(default_factory=list)
    advice: str = ""

    @property
    def needs_fix(self) -> bool:
        return self.verdict == "need_fix"


class Planner:
    def __init__(self, llm: LLMClient, *, model: str, timeout_s: float = 4.0, max_tokens: int = 500) -> None:
        self.llm = llm
        self.model = model
        self.timeout_s = timeout_s
        self.max_tokens = max_tokens

    async def plan(
        self, *, query: str, tools: Sequence[str], has_knowledge_base: bool
    ) -> Plan | None:
        messages = [
            {"role": "system", "content": _PLAN_SYSTEM},
            {
                "role": "user",
                "content": (
                    f"用户问题：{query}\n"
                    f"可用工具：{', '.join(tools) if tools else '（无）'}\n"
                    f"是否已选中知识库：{'是' if has_knowledge_base else '否'}"
                ),
            },
        ]
        try:
            payload = await self.llm.chat_json(
                messages,
                model=self.model,
                json_schema=_PLAN_SCHEMA,
                schema_name="agent_plan",
                temperature=0.0,
                max_tokens=self.max_tokens,
                timeout_s=self.timeout_s,
            )
        except Exception as exc:  # planning is an optimisation, never a blocker
            logger.info("plan skipped: %s", type(exc).__name__)
            return None

        steps: list[PlanStep] = []
        raw_steps = payload.get("steps")
        if isinstance(raw_steps, list):
            for item in raw_steps[:_MAX_PLAN_STEPS]:
                if isinstance(item, Mapping) and str(item.get("step") or "").strip():
                    steps.append(
                        PlanStep(
                            step=str(item.get("step")).strip(),
                            tool=str(item.get("tool") or "").strip(),
                        )
                    )
        goal = str(payload.get("goal") or "").strip()
        if not goal and not steps:
            return None
        return Plan(
            goal=goal or query[:60],
            needs_retrieval=bool(payload.get("needs_retrieval")),
            steps=steps,
            risk_notes=str(payload.get("risk_notes") or "").strip(),
        )


class Reviewer:
    def __init__(self, llm: LLMClient, *, model: str, timeout_s: float = 6.0, max_tokens: int = 400) -> None:
        self.llm = llm
        self.model = model
        self.timeout_s = timeout_s
        self.max_tokens = max_tokens

    async def review(
        self, *, query: str, answer: str, evidence: str
    ) -> Review | None:
        if not answer.strip():
            return None
        messages = [
            {"role": "system", "content": _REVIEW_SYSTEM},
            {
                "role": "user",
                "content": (
                    f"用户问题：{query}\n\n"
                    "已知事实（工具结果 + 系统预检索材料，可能为空）：\n"
                    f"{evidence[:_MAX_EVIDENCE] or '（无）'}\n\n"
                    f"待检查答案：\n{answer[:4000]}"
                ),
            },
        ]
        try:
            payload = await self.llm.chat_json(
                messages,
                model=self.model,
                json_schema=_REVIEW_SCHEMA,
                schema_name="answer_review",
                temperature=0.0,
                max_tokens=self.max_tokens,
                timeout_s=self.timeout_s,
            )
        except Exception as exc:
            logger.info("review skipped: %s", type(exc).__name__)
            return None

        verdict = str(payload.get("verdict") or "pass")
        issues = [str(item)[:200] for item in (payload.get("issues") or [])[:5] if str(item).strip()]
        advice = str(payload.get("advice") or "").strip()[:300]
        if verdict not in {"pass", "need_fix"}:
            verdict = "pass"
        return Review(verdict=verdict, issues=issues, advice=advice)


_MAX_EVIDENCE = 4000


@dataclass(slots=True)
class SecurityFinding:
    rule: str
    detail: str


class SecurityGuard:
    """Fail-closed scan of the outgoing answer (deterministic, no model)."""

    _SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
        ("api_key", re.compile(r"\bsk-[A-Za-z0-9]{16,}\b")),
        ("bearer", re.compile(r"\bBearer\s+[A-Za-z0-9\-._~+/]{20,}", re.IGNORECASE)),
        ("env_assignment", re.compile(r"\b[A-Z0-9_]*(SECRET|PASSWORD|TOKEN|API_KEY)[A-Z0-9_]*\s*=\s*\S+")),
        ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    )
    _INTERNAL_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
        (
            "internal_host",
            re.compile(
                r"\b(?:kh-backend|kh-agent|kh-postgres|kh-redis|litellm|nacos|milvus|neo4j"
                r"|shared-minio)\b(?:[:/]\d{2,5})?",
                re.IGNORECASE,
            ),
        ),
        ("docker_network", re.compile(r"\b172\.\d{1,3}\.\d{1,3}\.\d{1,3}\b")),
    )
    _PROMPT_MARKERS = (
        "system prompt",
        "系统提示词",
        "<untrusted_context>",
        "GROUNDING_RULES",
        "AGENTS__MD",
    )

    def scan(self, answer: str, *, extra_forbidden: Sequence[str] = ()) -> list[SecurityFinding]:
        findings: list[SecurityFinding] = []
        if not answer:
            return findings

        for rule, pattern in self._SECRET_PATTERNS:
            if pattern.search(answer):
                findings.append(SecurityFinding(rule=rule, detail="疑似泄露凭证"))

        for rule, pattern in self._INTERNAL_PATTERNS:
            match = pattern.search(answer)
            if match:
                findings.append(SecurityFinding(rule=rule, detail=f"内部地址/组件名：{match.group(0)[:40]}"))

        lowered = answer.lower()
        for marker in self._PROMPT_MARKERS:
            if marker.lower() in lowered:
                findings.append(SecurityFinding(rule="prompt_echo", detail=f"回显了内部提示词标记：{marker}"))

        for forbidden in extra_forbidden:
            secret = str(forbidden).strip()
            if len(secret) >= 8 and secret in answer:
                findings.append(SecurityFinding(rule="known_secret", detail="回显了本次请求的敏感值"))
        return findings

    @staticmethod
    def safe_reply() -> str:
        return "抱歉，这次回答里可能包含不适合直接展示的内部信息，已拦截。请换个问法，或联系管理员排查。"


__all__ = [
    "Plan",
    "PlanStep",
    "Planner",
    "Review",
    "Reviewer",
    "SecurityFinding",
    "SecurityGuard",
]


def _json_dump(payload: Any) -> str:  # pragma: no cover - debugging helper
    return json.dumps(payload, ensure_ascii=False, default=str)

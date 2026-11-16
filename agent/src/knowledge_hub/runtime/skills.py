"""Skills: Nacos AI registry -> sandbox shared dir -> model prompt.

The reference project keeps skills on a shared volume (``/shared/skills/<agent>``)
and hands that directory to the agent, so the agent can read ``SKILL.md`` and any
bundled scripts at runtime. We do the same, minus the volume assumption:

1. download each skill zip from ``/v3/client/ai/skills``;
2. write it into the sandbox under ``/shared/skills/<agent>/<name>.zip``;
3. unpack it inside the sandbox (``zipfile`` from the image's Python);
4. read ``SKILL.md`` back and put a short, honest index into the system prompt.

Nothing here is fatal: when the sandbox or the registry is unavailable the agent
simply runs without skills (reported in the ``status`` event).
"""

from __future__ import annotations

import asyncio
import json
import logging
import shlex
from dataclasses import dataclass
from typing import Any

from knowledge_hub.runtime.sandbox import SandboxClient, SandboxUnavailable

logger = logging.getLogger(__name__)

SKILL_ROOT = "/shared/skills"
_MAX_SKILL_MD_CHARS = 4000


@dataclass(slots=True)
class SkillInfo:
    name: str
    directory: str
    skill_md: str = ""

    def to_prompt(self) -> str:
        body = self.skill_md.strip() or "（该 skill 未提供 SKILL.md，可按目录内文件自行探索）"
        return (
            f"### skill: {self.name}\n"
            f"目录：{self.directory}\n"
            f"需要用到它时，先用 load_skill 读取说明或直接 sandbox_exec 查看目录内容；"
            f"只在任务确实需要时才使用。\n\n"
            f"{body}"
        )


class SkillManager:
    """Downloads skills once per (sandbox session, agent) and caches the result."""

    def __init__(
        self,
        registry: Any,
        *,
        sandbox: SandboxClient | None,
        label: str = "production",
    ) -> None:
        self.registry = registry
        self.sandbox = sandbox
        self.label = label
        self._cache: dict[tuple[str, str, tuple[str, ...]], list[SkillInfo]] = {}
        self._locks: dict[tuple[str, str, tuple[str, ...]], asyncio.Lock] = {}

    @property
    def available(self) -> bool:
        return self.registry is not None and self.sandbox is not None and self.sandbox.configured

    async def sync(self, *, session_key: str, agent_name: str, names: list[str]) -> list[SkillInfo]:
        cleaned = tuple(sorted({str(name).strip() for name in names if str(name).strip()}))
        if not cleaned or not self.available:
            return []
        key = (session_key, agent_name, cleaned)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            existing = self._cache.get(key)
            if existing is not None:
                return existing
            skills = await self._install(session_key=session_key, agent_name=agent_name, names=cleaned)
            self._cache[key] = skills
            return skills

    # --------------------------------------------------------------- internals
    async def _install(
        self, *, session_key: str, agent_name: str, names: tuple[str, ...]
    ) -> list[SkillInfo]:
        assert self.sandbox is not None
        base = f"{SKILL_ROOT}/{agent_name}"
        quoted = shlex.quote(base)
        try:
            await self.sandbox.execute(session_key, f"rm -rf {quoted} && mkdir -p {quoted}")
        except SandboxUnavailable as exc:
            logger.info("skills: sandbox unavailable (%s)", exc)
            return []

        installed: list[SkillInfo] = []
        for name in names:
            archive = await asyncio.to_thread(self.registry.skill_archive, name, self.label)
            if not archive:
                logger.info("skills: %s not found in nacos", name)
                continue
            zip_path = f"{base}/{name}.zip"
            try:
                await self.sandbox.write_bytes(session_key, zip_path, archive)
                target = f"{base}/{name}"
                unpack = (
                    "python -c "
                    + shlex.quote(
                        "import zipfile,sys;"
                        f"zipfile.ZipFile({zip_path!r}).extractall({target!r})"
                    )
                )
                result = await self.sandbox.execute(
                    session_key, f"mkdir -p {shlex.quote(target)} && {unpack}", timeout_seconds=60
                )
                if result.exit_code != 0:
                    logger.warning("skills: unzip %s failed (%s)", name, result.output[:200])
                    continue
                skill_md = await self._read_skill_md(session_key, target)
                installed.append(SkillInfo(name=name, directory=target, skill_md=skill_md))
            except SandboxUnavailable as exc:
                logger.info("skills: install %s skipped (%s)", name, exc)
        return installed

    async def _read_skill_md(self, session_key: str, directory: str) -> str:
        assert self.sandbox is not None
        candidates = [f"{directory}/SKILL.md", f"{directory}/skill.md", f"{directory}/SKILL.MD"]
        try:
            listed = await self.sandbox.execute(
                session_key, f"ls -1 {shlex.quote(directory)} 2>/dev/null | head -n 40"
            )
        except SandboxUnavailable:
            return ""
        names = {line.strip() for line in listed.output.splitlines() if line.strip()}
        for path in candidates:
            if path.rsplit("/", 1)[-1] in names:
                try:
                    raw = await self.sandbox.read_text(session_key, path)
                except SandboxUnavailable:
                    return ""
                return raw[:_MAX_SKILL_MD_CHARS]
        # 单文件 skill：只有一个 md 就直接用它
        markdown = [name for name in names if name.lower().endswith(".md")]
        if len(markdown) == 1:
            try:
                raw = await self.sandbox.read_text(session_key, f"{directory}/{markdown[0]}")
            except SandboxUnavailable:
                return ""
            return raw[:_MAX_SKILL_MD_CHARS]
        return ""

    def prompt_section(self, skills: list[SkillInfo]) -> str:
        if not skills:
            return ""
        body = "\n\n".join(skill.to_prompt() for skill in skills)
        return (
            "## 可用 skills\n"
            "下面是本 Agent 已装配的可复用技能（来自 Nacos，已解压到沙箱）。"
            "需要时用 load_skill(name, path) 读取说明或脚本，再用 sandbox_exec 执行；"
            "不需要时不要提及它们。\n\n"
            f"{body}\n"
        )

    def index(self, skills: list[SkillInfo]) -> str:
        return json.dumps(
            [
                {"name": item.name, "directory": item.directory, "has_md": bool(item.skill_md)}
                for item in skills
            ],
            ensure_ascii=False,
        )


__all__ = ["SKILL_ROOT", "SkillInfo", "SkillManager"]

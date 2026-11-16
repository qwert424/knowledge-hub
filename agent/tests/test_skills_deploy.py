"""Skills (Nacos zip -> sandbox) and deploy (sandbox -> object storage)."""

from __future__ import annotations

from typing import Any

import pytest

from knowledge_hub.config.settings import Settings
from knowledge_hub.runtime.sandbox import ExecResult
from knowledge_hub.runtime.skills import SkillManager
from knowledge_hub.runtime.tools import ToolContext, build_toolset
from knowledge_hub.security.tickets import RetrievalTicket


class FakeSandbox:
    configured = True

    def __init__(self) -> None:
        self.commands: list[str] = []
        self.writes: dict[str, bytes] = {}
        self.files = {"/shared/skills/main_agent/pptx/SKILL.md": "# 用法\n先读模板"}

    async def execute(self, key: str, command: str, *, timeout_seconds: int | None = None) -> ExecResult:
        self.commands.append(command)
        return ExecResult(exit_code=0, output="SKILL.md\nassets\n")

    async def write_bytes(self, key: str, path: str, content: bytes) -> None:
        self.writes[path] = content

    async def read_text(self, key: str, path: str) -> str:
        return self.files.get(path, "")

    async def read_bytes(self, key: str, path: str, *, max_bytes: int = 6_000_000) -> bytes:
        return f"<{path}>".encode()

    async def list_files(self, key: str, path: str, *, limit: int = 200) -> list[str]:
        self.commands.append(f"find {path}")
        return ["/root/workspace/app/index.html", "/root/workspace/app/style.css"]


class FakeRegistry:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def skill_archive(self, name: str, label: str = "production") -> bytes | None:
        self.calls.append(name)
        return b"PK\x03\x04zip" if name == "pptx" else None


class FakeS3:
    def __init__(self) -> None:
        self.configured = True
        self.buckets: list[str] = []
        self.objects: dict[str, bytes] = {}

    def ensure_bucket(self, bucket: str) -> None:
        self.buckets.append(bucket)

    def put_object(self, bucket: str, key: str, data: bytes, *, content_type: str = "") -> None:
        self.objects[f"{bucket}/{key}"] = data

    def presign_get(self, bucket: str, key: str, *, expires_s: int = 0) -> str:
        return f"http://minio.local/{bucket}/{key}?sig=x"


def _ticket() -> RetrievalTicket:
    return RetrievalTicket(
        tenant_id="t_001",
        user_id="u_1",
        principals=("user:u_1",),
        kb_ids=("kb_001",),
    )


@pytest.mark.asyncio
async def test_skill_manager_unpacks_once_and_documents_skills() -> None:
    sandbox = FakeSandbox()
    registry = FakeRegistry()
    manager = SkillManager(registry, sandbox=sandbox)  # type: ignore[arg-type]

    skills = await manager.sync(session_key="s1", agent_name="main_agent", names=["pptx", "missing"])
    assert [skill.name for skill in skills] == ["pptx"]
    assert skills[0].skill_md.startswith("# 用法")
    assert "/shared/skills/main_agent/pptx.zip" in sandbox.writes
    assert any("extractall" in command for command in sandbox.commands)
    assert "### skill: pptx" in manager.prompt_section(skills)

    # 第二个请求命中缓存，不会重复下载/解压
    await manager.sync(session_key="s1", agent_name="main_agent", names=["pptx", "missing"])
    assert registry.calls.count("pptx") == 1


@pytest.mark.asyncio
async def test_deploy_publishes_artifacts_and_returns_urls(settings: Settings) -> None:
    sandbox = FakeSandbox()
    s3 = FakeS3()
    ctx = ToolContext(
        settings=settings,
        ticket=_ticket(),
        session_key="s1",
        sandbox=sandbox,  # type: ignore[arg-type]
        s3=s3,
    )
    toolset = build_toolset(["deploy"], ctx)
    assert "deploy" in toolset

    output = await toolset.tools["deploy"].handler(
        path="/root/workspace/app",
        target_dirname="demo",
        entry_files=["index.html"],
        ctx=ctx,
    )

    assert "http://minio.local/agent-artifacts/t_001/u_1/demo/index.html" in output
    assert "agent-artifacts/t_001/u_1/demo/style.css" in s3.objects
    assert s3.buckets == ["agent-artifacts"]


@pytest.mark.asyncio
async def test_deploy_rejects_relative_path(settings: Settings) -> None:
    ctx = ToolContext(
        settings=settings,
        ticket=_ticket(),
        session_key="s1",
        sandbox=FakeSandbox(),  # type: ignore[arg-type]
        s3=FakeS3(),
    )
    toolset = build_toolset(["deploy"], ctx)
    result: Any = await toolset.tools["deploy"].handler(
        path="app", target_dirname="demo", entry_files=["index.html"], ctx=ctx
    )
    assert "绝对路径" in result

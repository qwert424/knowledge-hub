"""Tool registry for the agent runtime.

The names match what the Nacos AgentSpec declares (``tools: [...]``), so the
configuration you already have keeps working:

``ask_user_question`` ``get_current_time`` ``get_bucket_file_url``
``milvus_search`` ``milvus_query`` ``fetch_url`` ``web_search``
``sandbox_exec`` ``sandbox_write_file`` ``sandbox_read_file`` ``task``

A tool is only advertised when its dependency is actually configured (Tavily key
for ``web_search``, sandbox endpoint for the sandbox tools, ...). Anything the
spec asks for but this build cannot do is returned as *skipped* instead of being
silently faked.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import re
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx

from knowledge_hub.config.settings import Settings
from knowledge_hub.runtime.sandbox import SandboxClient, SandboxUnavailable
from knowledge_hub.security.tickets import RetrievalTicket

logger = logging.getLogger(__name__)

Handler = Callable[..., Awaitable[str]]
_MAX_FETCH_BYTES = 400_000
_MAX_TOOL_CHARS = 6000
_TAVILY_URL = "https://api.tavily.com/search"
_TAVILY_EXTRACT_URL = "https://api.tavily.com/extract"


class AskUser(Exception):
    """Raised by ``ask_user_question`` to stop the loop and ask the human.

    ``options`` carries the candidate answers the UI can turn into buttons, so a
    "选择式追问"（让用户点一下而不是再打一遍）is possible without extra tooling.
    ``questions`` 支持一次问多件事（主题 / 受众 / 页数），每项各自带候选，
    前端会渲染成多行小表单而不是一段长问句。
    """

    def __init__(
        self,
        question: str,
        options: Sequence[str] | None = None,
        questions: Sequence[Any] | None = None,
    ) -> None:
        super().__init__(question)
        self.question = question
        self.options = [str(item).strip() for item in (options or []) if str(item).strip()][:6]
        self.questions: list[dict[str, Any]] = []
        for item in questions or []:
            if not isinstance(item, dict):
                continue
            text = str(item.get("question") or "").strip()
            if not text:
                continue
            raw = item.get("options") or []
            self.questions.append(
                {
                    "question": text,
                    "options": [str(opt).strip() for opt in raw if str(opt).strip()][:6],
                }
            )


@dataclass(slots=True)
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Handler

    def schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


@dataclass(slots=True)
class ToolContext:
    """Everything a tool may touch; built once per chat request."""

    settings: Settings
    ticket: RetrievalTicket
    kb_ids: Sequence[str] = ()
    session_key: str = ""
    retriever: Any = None
    sandbox: SandboxClient | None = None
    tavily_api_key: str = ""
    fetch_transport: httpx.AsyncBaseTransport | None = None
    search_transport: httpx.AsyncBaseTransport | None = None
    #: Chunk store, used by ``milvus_query`` for scalar (non-vector) lookups.
    store: Any = None
    #: 知识库 → 集合名映射，标量查询时用来定位集合
    kb_collections: Mapping[str, str] | None = None
    embedding_dim: int = 0
    #: GraphRAG：入库时抽过实体的"精选"文档才走这条路（图查询 + 实体关系）
    graph: Any = None
    #: Nacos skills already unpacked into the sandbox (see runtime.skills).
    skills: Sequence[Any] = ()
    #: S3/MinIO client used by ``deploy`` to publish artifacts.
    s3: Any = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class Toolset:
    tools: dict[str, Tool]
    skipped: list[str] = field(default_factory=list)

    def schemas(self) -> list[dict[str, Any]]:
        return [tool.schema() for tool in self.tools.values()]

    def __contains__(self, name: str) -> bool:
        return name in self.tools


def _obj(properties: Mapping[str, Any], required: Iterable[str] = ()) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": dict(properties),
        "required": list(required),
        "additionalProperties": False,
    }


def _str(description: str) -> dict[str, Any]:
    return {"type": "string", "description": description}


def _int(description: str, default: int) -> dict[str, Any]:
    return {"type": "integer", "description": description, "default": default}


def _clip(text: str, limit: int = _MAX_TOOL_CHARS) -> str:
    return text if len(text) <= limit else text[:limit] + "\n…（已截断）"


def _quote(value: str) -> str:
    """Milvus 表达式里的字符串常量转义（与 store 里保持一致）。"""
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


def build_toolset(
    names: Sequence[str],
    ctx: ToolContext,
    *,
    extra_tools: Mapping[str, Tool] | None = None,
) -> Toolset:
    """Resolve the spec's tool names into concrete, callable tools."""
    available = _builtin_tools(ctx)
    if extra_tools:
        available.update(extra_tools)

    tools: dict[str, Tool] = {}
    skipped: list[str] = []
    for raw in names:
        name = str(raw).strip()
        if not name:
            continue
        tool = available.get(name)
        if tool is None:
            skipped.append(name)
            continue
        tools[name] = tool
    # 图检索是"检索"的子能力：只要这个 Agent 本来就能检索、且图已启用，就一并给它，
    # 免得为了拿到 graph_search 去改 Nacos 里的 agentspec 白名单（那里还要走审核/上线流程）。
    if "milvus_search" in tools and "graph_search" in available and "graph_search" not in tools:
        tools["graph_search"] = available["graph_search"]
    if skipped:
        logger.info("agent spec requested unavailable tools: %s", ", ".join(sorted(skipped)))
    return Toolset(tools=tools, skipped=skipped)


def _builtin_tools(ctx: ToolContext) -> dict[str, Tool]:
    tools: dict[str, Tool] = {
        "get_current_time": Tool(
            name="get_current_time",
            description="返回当前时间（含时区），用于涉及“今天/最近”的问题。",
            parameters=_obj({}),
            handler=_get_current_time,
        ),
        "fetch_url": Tool(
            name="fetch_url",
            description=(
                "抓取一个或多个网页，返回纯文本正文（单页最多约 6000 字）。批量抓取用 urls 传数组。"
            ),
            parameters=_obj(
                {
                    "url": _str("单个 URL（与 urls 二选一）"),
                    "urls": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "多个 URL（最多 5 个）",
                    },
                }
            ),
            handler=_fetch_url,
        ),
        "ask_user_question": Tool(
            name="ask_user_question",
            description=(
                "信息不足且必须由用户补充时，向用户提问并结束本轮。"
                "如果答案是有限的几个选项，请用 options 给出候选，用户可以直接点选。"
                "需要同时确认多件事（例如 PPT 的主题、受众、页数）时，"
                "用 questions 一次问清，每项自带 options，前端会渲染成多行小表单。"
            ),
            parameters=_obj(
                {
                    "question": _str("要问用户的问题（一句话概括）"),
                    "options": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "候选答案（可选，最多 6 个）",
                    },
                    "questions": {
                        "type": "array",
                        "description": "一次问多件事时使用；每项 {question, options}",
                        "items": _obj(
                            {
                                "question": _str("子问题"),
                                "options": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "该子问题的候选（可选）",
                                },
                            },
                            ["question"],
                        ),
                    },
                },
                ["question"],
            ),
            handler=_ask_user,
        ),
        "submit_result": Tool(
            name="submit_result",
            description=(
                "以固定结构提交检索结果：只要你是检索子 Agent，"
                "就必须用它交付，而不是把结论写成普通正文。"
            ),
            parameters=_obj(
                {
                    "status": {
                        "type": "string",
                        "enum": ["answered", "partial", "unanswerable"],
                        "description": "证据是否足以回答本次检索任务",
                    },
                    "answer": _str("可独立阅读的 Markdown 正文，带 [cN] 引用与必要图片"),
                    "sources": {
                        "type": "array",
                        "description": "实际采用的来源，每项 {title, url}；url 确实缺失时用 null",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string"},
                                "url": {"type": ["string", "null"]},
                            },
                            "required": ["title"],
                        },
                    },
                    "gaps": {
                        "type": "array",
                        "description": "尚缺的条件/材料/对比对象；没有缺口就给空数组",
                        "items": {"type": "string"},
                    },
                },
                ["status", "answer"],
            ),
            handler=_submit_result,
        ),
        "get_bucket_file_url": Tool(
            name="get_bucket_file_url",
            description="返回对象存储中某个文件的访问地址（需要桶允许直读）。",
            parameters=_obj({"key": _str("对象键（文件路径）"), "bucket": _str("桶名，可省略")}, ["key"]),
            handler=_get_bucket_file_url,
        ),
    }

    if ctx.retriever is not None:
        tools["milvus_search"] = Tool(
            name="milvus_search",
            description=(
                "在企业知识库中做混合检索（向量 + 关键词 + 图谱），返回命中的原文片段、"
                "标题路径和来源链接。回答内部制度、流程、数字时必须先调用它。"
            ),
            parameters=_obj(
                {
                    "query": _str("检索问题或关键词"),
                    "top_k": _int("返回条数，默认 6", 6),
                },
                ["query"],
            ),
            handler=_milvus_search,
        )

    if ctx.store is not None:
        tools["milvus_query"] = Tool(
            name="milvus_query",
            description=(
                "按标量条件读取知识库切片（不做向量检索），用于已知 doc_id/chunk_id 后翻页看上下文。"
                'filter 用 Milvus 表达式，例如 doc_id == "xxx" 或 chunk_id == "yyy"；空字符串表示不筛。'
            ),
            parameters=_obj(
                {
                    "filter": _str('Milvus 标量过滤表达式，例如 doc_id == "abc"'),
                    "limit": _int("返回条数，默认 20（1~100）", 20),
                    "offset": _int("跳过条数，默认 0", 0),
                },
                ["filter"],
            ),
            handler=_milvus_query,
        )

    if ctx.graph is not None and getattr(ctx.graph, "enabled", False):
        tools["graph_search"] = Tool(
            name="graph_search",
            description=(
                "在知识图谱里按实体/关系检索（只对入库时标记为「精选」的文档有内容）。"
                "适合「谁和谁什么关系」「某个主题涉及哪些对象」这类问题；返回实体、关系与证据切片。"
            ),
            parameters=_obj(
                {
                    "query": _str("要查的实体、主题或关系描述"),
                    "hops": _int("关系扩展跳数，默认 2（1~3）", 2),
                },
                ["query"],
            ),
            handler=_graph_search,
        )

    if ctx.tavily_api_key:
        tools["web_search"] = Tool(
            name="web_search",
            description="联网搜索公开信息，返回标题、链接和摘要。企业内部事实不要用它替代知识库。",
            parameters=_obj({"query": _str("搜索词"), "max_results": _int("结果条数，默认 5", 5)}, ["query"]),
            handler=_web_search,
        )

    if ctx.sandbox is not None and ctx.sandbox.configured:
        tools["sandbox_exec"] = Tool(
            name="sandbox_exec",
            description="在隔离沙箱中执行 shell 命令并返回输出（用于运行脚本、处理文件）。",
            parameters=_obj(
                {"command": _str("要执行的命令"), "timeout_seconds": _int("超时秒数，默认 90", 90)},
                ["command"],
            ),
            handler=_sandbox_exec,
        )
        tools["sandbox_write_file"] = Tool(
            name="sandbox_write_file",
            description="把文本内容写入沙箱中的文件。",
            parameters=_obj(
                {"path": _str("沙箱内绝对路径"), "content": _str("文件内容")},
                ["path", "content"],
            ),
            handler=_sandbox_write_file,
        )
        tools["sandbox_read_file"] = Tool(
            name="sandbox_read_file",
            description="读取沙箱中的文本文件。",
            parameters=_obj({"path": _str("沙箱内绝对路径")}, ["path"]),
            handler=_sandbox_read_file,
        )

    if ctx.skills and ctx.sandbox is not None and ctx.sandbox.configured:
        names = ", ".join(skill.name for skill in ctx.skills)
        tools["load_skill"] = Tool(
            name="load_skill",
            description=(
                "读取某个 skill 的说明文件（SKILL.md）或它自带的脚本/资源。"
                f"当前可用 skills：{names}。"
            ),
            parameters=_obj(
                {
                    "name": _str("skill 名称"),
                    "path": _str("skill 内的相对路径，留空则返回 SKILL.md"),
                },
                ["name"],
            ),
            handler=_load_skill,
        )

    if (
        ctx.sandbox is not None
        and ctx.sandbox.configured
        and ctx.s3 is not None
        and getattr(ctx.s3, "configured", False)
    ):
        tools["deploy"] = Tool(
            name="deploy",
            description=(
                "把沙箱里的产物（单文件或整个目录）发布到对象存储，返回可访问的入口地址，"
                "用于把生成的网页、图片、压缩包交付给用户。静态页面的资源要写成相对路径。"
            ),
            parameters=_obj(
                {
                    "path": _str("沙箱内的产物路径（目录或文件，绝对路径）"),
                    "target_dirname": _str("目标目录名，建议用工程名"),
                    "entry_files": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "入口文件名（相对 target_dirname），例如 index.html",
                    },
                },
                ["path", "target_dirname", "entry_files"],
            ),
            handler=_deploy,
        )
    return tools


# ---------------------------------------------------------------- implementations
async def _get_current_time(**_kwargs: Any) -> str:
    now = dt.datetime.now().astimezone()
    return now.strftime("%Y-%m-%d %H:%M:%S %Z（%A）")


async def _submit_result(arguments: Mapping[str, Any], ctx: ToolContext) -> str:
    """检索子 Agent 的结构化交付：把四个字段原样序列化回去，由调用方解析。"""
    payload = {
        "status": str(arguments.get("status") or "answered"),
        "answer": str(arguments.get("answer") or ""),
        "sources": list(arguments.get("sources") or []),
        "gaps": [str(item) for item in (arguments.get("gaps") or [])],
    }
    return json.dumps(payload, ensure_ascii=False)


def _ask_user(
    question: str,
    options: Sequence[str] | None = None,
    questions: Sequence[Any] | None = None,
    **_kwargs: Any,
) -> str:
    raise AskUser(str(question or "").strip() or "请补充更多信息。", options, questions)


async def _get_bucket_file_url(
    key: str, bucket: str = "", *, ctx: ToolContext, **_kwargs: Any
) -> str:
    minio = ctx.settings.env.minio
    if not minio.configured:
        return "对象存储未配置，无法生成文件地址。"
    return minio.public_url(str(key), bucket=str(bucket or ""))


async def _milvus_search(
    query: str, top_k: int = 6, *, ctx: ToolContext, **_kwargs: Any
) -> str:
    result = await ctx.retriever.retrieve(
        ticket=ctx.ticket,
        kb_ids=list(ctx.kb_ids),
        query=str(query),
        top_k=max(1, min(int(top_k or 6), 20)),
        debug=False,
    )
    if not result.chunks:
        return "知识库中没有检索到相关内容。"
    lines: list[str] = []
    for index, chunk in enumerate(result.chunks, start=1):
        path = " > ".join(chunk.title_path) or chunk.title or "未命名"
        lines.append(
            json.dumps(
                {
                    "index": index,
                    "chunk_id": chunk.chunk_id,
                    "doc_id": chunk.doc_id,
                    "title": chunk.title,
                    "title_path": path,
                    "source_url": chunk.source_url,
                    "score": round(float(chunk.score), 4),
                    "block_id": getattr(chunk, "block_id", ""),
                    "block_parent_id": getattr(chunk, "block_parent_id", ""),
                    "block_type": getattr(chunk, "block_type", ""),
                    "kind": getattr(chunk, "kind", "") or getattr(chunk, "block_type", ""),
                    "order": getattr(chunk, "block_order", -1),
                    "chunk_index": getattr(chunk, "chunk_index", 0),
                    "chunk_count": getattr(chunk, "chunk_count", 1),
                    "references": getattr(chunk, "references", []) or [],
                    "payload": getattr(chunk, "payload", {}) or {},
                    "text": _clip(chunk.text, 1200),
                },
                ensure_ascii=False,
            )
        )
    return "\n".join(lines)


async def _milvus_query(
    filter: str,
    limit: int = 20,
    offset: int = 0,
    *,
    ctx: ToolContext,
    **_kwargs: Any,
) -> str:
    """标量查询：按 doc_id/chunk_id 等条件翻页读切片。

    必须带上知识库范围（ticket 授权 ∩ 请求 kb_ids），并且强制把 tenant/kb 条件
    拼进表达式，避免模型写一个宽条件读到别的租户的数据。
    """
    if ctx.store is None or not ctx.kb_collections:
        return "标量查询不可用（缺少知识库集合信息）。"

    allowed = list(ctx.ticket.effective_kb_ids(list(ctx.kb_ids) or None))
    targets = [(kb, ctx.kb_collections.get(kb)) for kb in allowed]
    targets = [(kb, name) for kb, name in targets if name]
    if not targets:
        return "当前会话没有可查询的知识库集合。"

    extra = str(filter or "").strip()
    dim = int(ctx.embedding_dim) or int(ctx.settings.embedding.dimensions) or 0
    if dim <= 0:
        return "标量查询不可用（向量维度未配置）。"

    lines: list[str] = []
    for kb_id, collection in targets:
        # tenant + kb 约束始终由服务端拼接，模型只能收窄范围
        scope = f'tenant_id == "{_quote(ctx.ticket.tenant_id)}" and kb_id == "{_quote(kb_id)}"'
        expr = f"({scope}) and ({extra})" if extra else f"({scope})"
        try:
            rows = await asyncio.to_thread(
                ctx.store.query_scalar,
                collection,
                expr,
                limit=max(1, min(int(limit or 20), 100)),
                offset=max(0, int(offset or 0)),
                dim=dim,
            )
        except Exception as exc:
            lines.append(f"知识库 {kb_id} 查询失败：{type(exc).__name__}")
            continue
        if not rows:
            continue
        for row in rows:
            lines.append(
                json.dumps(
                    {
                        "id": row.get("pk") or row.get("chunk_id"),
                        "kb_id": row.get("kb_id"),
                        "doc_id": row.get("doc_id"),
                        "chunk_index": row.get("chunk_index"),
                        "chunk_count": row.get("chunk_count"),
                        "block_id": row.get("block_id"),
                        "block_parent_id": row.get("block_parent_id"),
                        "block_type": row.get("block_type"),
                        "kind": row.get("kind"),
                        "order": row.get("block_order"),
                        "table_row_index": row.get("table_row_index"),
                        "title": row.get("doc_title"),
                        "title_path": row.get("title_path"),
                        "references": row.get("references"),
                        "payload": row.get("payload"),
                        "space_id": row.get("space_id"),
                        "node_token": row.get("node_token"),
                        "revision_id": row.get("revision_id"),
                        "text": _clip(str(row.get("text") or ""), 1200),
                    },
                    ensure_ascii=False,
                    default=str,
                )
            )

    if not lines:
        return "没有匹配的切片。"
    return "\n".join(lines)


async def _graph_search(
    query: str, hops: int = 2, *, ctx: ToolContext, **_kwargs: Any
) -> str:
    if ctx.graph is None:
        return "知识图谱未启用。"
    try:
        result = await ctx.graph.query(
            ticket=ctx.ticket,
            kb_ids=list(ctx.kb_ids),
            query=str(query),
            hops=max(1, min(int(hops or 2), 3)),
            include_communities=True,
        )
    except Exception as exc:  # 图不可用不应把整次回答打死
        return f"图检索不可用：{type(exc).__name__}"
    if getattr(result, "degraded", True):
        return f"图检索不可用（{getattr(result, 'reason', 'unknown')}）。"
    if not result.hits and not result.entities:
        return "图谱中没有匹配的实体或关系。"
    payload = {
        "entities": result.entities[:20],
        "relations": result.relations[:20],
        "communities": result.communities[:5],
        "evidence": [
            {
                "chunk_id": hit.pk,
                "doc_id": hit.doc_id,
                "title": hit.doc_title,
                "title_path": hit.title_path,
                "text": _clip(hit.text, 800),
            }
            for hit in result.hits[:8]
        ],
    }
    return json.dumps(payload, ensure_ascii=False, default=str)


async def _fetch_url(
    url: str = "",
    urls: Sequence[str] | None = None,
    *,
    ctx: ToolContext,
    **_kwargs: Any,
) -> str:
    targets = [str(item).strip() for item in (urls or []) if str(item).strip()]
    if str(url or "").strip():
        targets.insert(0, str(url).strip())
    targets = [item for item in targets if item][:5]
    if not targets:
        return "请提供 url 或 urls。"

    for target in targets:
        parsed = urlparse(target)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            return "只支持 http/https URL。"

    # 有 Tavily key 时用 extract：一次多页、自动去导航噪音，效果比裸抓 HTML 好。
    if ctx.tavily_api_key:
        extracted = await _tavily_extract(targets, ctx)
        if extracted:
            return extracted

    if len(targets) == 1:
        return await _fetch_one(targets[0], ctx)

    parts: list[str] = []
    for target in targets:
        parts.append(f"### {target}\n{await _fetch_one(target, ctx)}")
    return _clip("\n\n".join(parts))


async def _tavily_extract(targets: Sequence[str], ctx: ToolContext) -> str:
    payload = {"api_key": ctx.tavily_api_key, "urls": list(targets), "include_images": False}
    try:
        async with httpx.AsyncClient(timeout=30.0, transport=ctx.search_transport) as client:
            response = await client.post(_TAVILY_EXTRACT_URL, json=payload)
    except httpx.HTTPError:
        return ""
    if response.status_code >= 400:
        return ""
    try:
        data = response.json()
    except ValueError:
        return ""
    results = data.get("results") if isinstance(data, Mapping) else None
    if not isinstance(results, list) or not results:
        return ""
    parts: list[str] = []
    for item in results[:5]:
        if not isinstance(item, Mapping):
            continue
        parts.append(
            f"### {item.get('url')}\n{_clip(_squash(str(item.get('raw_content') or '')), 3000)}"
        )
    return _clip("\n\n".join(parts))


async def _fetch_one(target: str, ctx: ToolContext) -> str:
    try:
        async with httpx.AsyncClient(
            timeout=20.0, follow_redirects=True, transport=ctx.fetch_transport
        ) as client:
            response = await client.get(target)
    except httpx.HTTPError as exc:
        return f"抓取失败：{type(exc).__name__}"
    if response.status_code >= 400:
        return f"抓取失败：HTTP {response.status_code}"

    body = response.text[:_MAX_FETCH_BYTES]
    if "html" in response.headers.get("content-type", ""):
        body = _html_to_text(body)
    return _clip(_squash(body))


async def _web_search(
    query: str, max_results: int = 5, *, ctx: ToolContext, **_kwargs: Any
) -> str:
    payload = {
        "api_key": ctx.tavily_api_key,
        "query": str(query or "").strip(),
        "max_results": max(1, min(int(max_results or 5), 10)),
        "search_depth": "basic",
    }
    try:
        async with httpx.AsyncClient(timeout=25.0, transport=ctx.search_transport) as client:
            response = await client.post(_TAVILY_URL, json=payload)
    except httpx.HTTPError as exc:
        return f"联网搜索失败：{type(exc).__name__}"
    if response.status_code >= 400:
        return f"联网搜索失败：HTTP {response.status_code}"

    try:
        data = response.json()
    except ValueError:
        return "联网搜索返回了无法解析的内容。"
    results = data.get("results") if isinstance(data, dict) else None
    if not results:
        return "没有找到相关公开信息。"
    lines = [
        json.dumps(
            {
                "title": item.get("title"),
                "url": item.get("url"),
                "content": _clip(str(item.get("content") or ""), 600),
            },
            ensure_ascii=False,
        )
        for item in results
        if isinstance(item, Mapping)
    ]
    return "\n".join(lines)


async def _sandbox_exec(
    command: str, timeout_seconds: int = 90, *, ctx: ToolContext, **_kwargs: Any
) -> str:
    assert ctx.sandbox is not None
    try:
        result = await ctx.sandbox.execute(
            ctx.session_key, str(command), timeout_seconds=int(timeout_seconds or 90)
        )
    except SandboxUnavailable as exc:
        return f"沙箱不可用：{exc}"
    return json.dumps(
        {"exit_code": result.exit_code, "output": _clip(result.output)}, ensure_ascii=False
    )


async def _sandbox_write_file(
    path: str, content: str, *, ctx: ToolContext, **_kwargs: Any
) -> str:
    assert ctx.sandbox is not None
    try:
        await ctx.sandbox.write_text(ctx.session_key, str(path), str(content))
    except SandboxUnavailable as exc:
        return f"沙箱不可用：{exc}"
    return f"已写入 {path}"


async def _sandbox_read_file(path: str, *, ctx: ToolContext, **_kwargs: Any) -> str:
    assert ctx.sandbox is not None
    try:
        return _clip(await ctx.sandbox.read_text(ctx.session_key, str(path)))
    except SandboxUnavailable as exc:
        return f"沙箱不可用：{exc}"


async def _load_skill(
    name: str, path: str = "", *, ctx: ToolContext, **_kwargs: Any
) -> str:
    """Read a skill's SKILL.md (or one of its files) from the sandbox."""
    assert ctx.sandbox is not None
    skill = next((item for item in ctx.skills if item.name == str(name).strip()), None)
    if skill is None:
        available = ", ".join(item.name for item in ctx.skills) or "（无）"
        return f"没有名为 {name} 的 skill。可用：{available}"

    if not path:
        if skill.skill_md:
            return _clip(skill.skill_md)
        try:
            listing = await ctx.sandbox.execute(
                ctx.session_key, f"ls -1 {skill.directory} 2>/dev/null | head -n 60"
            )
        except SandboxUnavailable as exc:
            return f"沙箱不可用：{exc}"
        return f"{skill.name} 没有 SKILL.md，目录内容：\n{_clip(listing.output)}"

    relative = str(path).lstrip("/")
    if ".." in relative.split("/"):
        return "路径不能包含 .."
    target = f"{skill.directory}/{relative}"
    try:
        return _clip(await ctx.sandbox.read_text(ctx.session_key, target))
    except SandboxUnavailable as exc:
        return f"读取失败：{exc}"


_ARTIFACT_BUCKET = "agent-artifacts"
_MAX_DEPLOY_FILES = 120
_MAX_DEPLOY_BYTES = 40_000_000


async def _deploy(
    path: str,
    target_dirname: str,
    entry_files: list[str],
    *,
    ctx: ToolContext,
    **_kwargs: Any,
) -> str:
    """Publish sandbox artifacts to MinIO and return presigned entry URLs."""
    assert ctx.sandbox is not None
    source = str(path or "").strip()
    directory = str(target_dirname or "").strip().strip("/")
    if not source.startswith("/"):
        return "path 必须是沙箱内的绝对路径"
    if not directory or ".." in directory.split("/"):
        return "target_dirname 必须是非空相对目录名"
    entries = [str(item).strip().lstrip("/") for item in (entry_files or []) if str(item).strip()]
    if not entries:
        return "entry_files 至少需要一个入口文件名"

    try:
        files = await ctx.sandbox.list_files(ctx.session_key, source)
    except SandboxUnavailable as exc:
        return f"沙箱不可用：{exc}"
    if not files:
        return f"产物路径不存在或为空：{source}"
    if len(files) > _MAX_DEPLOY_FILES:
        return f"产物文件过多（{len(files)} > {_MAX_DEPLOY_FILES}），请先清理无关文件"

    prefix = f"{ctx.ticket.tenant_id}/{ctx.ticket.user_id}/{directory}"
    uploaded: list[str] = []
    failures: dict[str, str] = {}
    total = 0
    try:
        ctx.s3.ensure_bucket(_ARTIFACT_BUCKET)
    except Exception as exc:  # surface honestly instead of pretending success
        return f"对象存储不可用：{exc}"

    for absolute in files:
        if absolute.startswith(source):
            relative = absolute[len(source) :].lstrip("/")
        else:
            relative = absolute.rsplit("/", 1)[-1]
        try:
            payload = await ctx.sandbox.read_bytes(ctx.session_key, absolute)
        except SandboxUnavailable as exc:
            failures[relative] = str(exc)
            continue
        if total + len(payload) > _MAX_DEPLOY_BYTES:
            failures[relative] = "超过单次部署体积上限"
            continue
        total += len(payload)
        key = f"{prefix}/{relative}"
        try:
            ctx.s3.put_object(_ARTIFACT_BUCKET, key, payload, content_type=_content_type(relative))
        except Exception as exc:
            failures[relative] = f"{type(exc).__name__}: {exc}"
            continue
        uploaded.append(relative)

    urls = [
        ctx.s3.presign_get(_ARTIFACT_BUCKET, f"{prefix}/{entry}")
        for entry in entries
        if entry in uploaded
    ]
    return json.dumps(
        {
            "total_count": len(files),
            "success_count": len(uploaded),
            "failure_count": len(failures),
            "failures": failures,
            "urls": urls,
            "hint": "urls 为 7 天有效的直链，可直接给用户访问" if urls else "没有入口文件上传成功",
        },
        ensure_ascii=False,
    )


def _content_type(name: str) -> str:
    lowered = name.lower()
    mapping = {
        ".html": "text/html; charset=utf-8",
        ".htm": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".pdf": "application/pdf",
        ".md": "text/markdown; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
    }
    for suffix, value in mapping.items():
        if lowered.endswith(suffix):
            return value
    return "application/octet-stream"


def _html_to_text(html: str) -> str:
    try:
        from bs4 import BeautifulSoup
    except ImportError:  # pragma: no cover - packaging guard
        return re.sub(r"<[^>]+>", " ", html)
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    return soup.get_text("\n")


def _squash(text: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]{2,}", " ", text)).strip()


__all__ = ["AskUser", "Tool", "ToolContext", "Toolset", "build_toolset"]
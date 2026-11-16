"""Nacos-owned runtime sections (``knowledge-hub.yaml`` schema).

These models describe *behaviour* (chunking, retrieval weights, JEV thresholds),
never connection facts. Connection facts live in the ``*_settings`` modules and
are read from the environment.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from knowledge_hub.config.llm_settings import EmbeddingSection, LLMSection


class ChunkingQuality(BaseModel):
    min_tokens: int = 20
    max_tokens: int = 1200
    drop_pure_navigation: bool = True


class ChunkingSection(BaseModel):
    template: str = "general"
    chunk_size: int = 1000
    chunk_overlap: int = 200
    min_chunk_chars: int = 40
    quality: ChunkingQuality = Field(default_factory=ChunkingQuality)


class DenseSection(BaseModel):
    enabled: bool = True
    top_k: int = 20
    metric: str = "COSINE"
    index: str = "HNSW"


class SparseSection(BaseModel):
    enabled: bool = True
    top_k: int = 20


class FusionSection(BaseModel):
    strategy: str = "rrf"
    k: int = 60


class RerankSection(BaseModel):
    enabled: bool = False
    strategy: str = "rrf"
    top_n: int = 8
    model: str = ""  # LiteLLM rerank alias; empty means "enabled flag has no effect"


class GraphSection(BaseModel):
    enabled: bool = False
    hops: int = 2
    include_communities: bool = True


class RetrievalSection(BaseModel):
    dense: DenseSection = Field(default_factory=DenseSection)
    sparse: SparseSection = Field(default_factory=SparseSection)
    fusion: FusionSection = Field(default_factory=FusionSection)
    rerank: RerankSection = Field(default_factory=RerankSection)
    graph: GraphSection = Field(default_factory=GraphSection)
    top_k: int = 8


class JevSection(BaseModel):
    enabled: bool = True
    model: str = "gpt-4.1-mini"
    timeout_ms: int = 3000
    min_confidence: float = 0.55
    scenes: dict[str, bool] = Field(
        default_factory=lambda: {
            "router": True,
            "judge": True,
            "chunk_quality": False,
            "conflict": False,
        }
    )


class IndexSection(BaseModel):
    max_concurrency: int = 2
    embedding_batch_size: int = 16
    snapshot_prefix: str = "snapshots"


class AgentSection(BaseModel):
    """Nacos ``agent`` section: which AgentSpec drives the chat engine."""

    name: str = "knowledge-hub-agent"
    label: str = "production"
    # Used only when the Nacos AI registry has no published AgentSpec.
    fallback_prompt: str = ""
    #: Optional Nacos *prompt* resource appended to the deterministic RAG persona.
    #: Kept separate from the AgentSpec prompt on purpose: an AgentSpec describes a
    #: tool-using agent, and feeding that persona to the plain retrieval path makes
    #: the model narrate tool calls instead of answering from the retrieved chunks.
    chat_policy_prompt: str = ""
    #: 规划中间件：回答前先让模型产出一份简短计划（要查什么、要调哪个工具），
    #: 结构化 JSON、3s 预算，失败就当没有计划继续跑。
    plan_enabled: bool = True
    #: 复核中间件：答案产完后自查一遍（是否答非所问、是否编造、是否有泄露风险），
    #: 判为 need_fix 时按建议改写一次。
    review_enabled: bool = True
    #: 安全扫描：命中系统提示词回显、密钥样式、内部地址等直接拦截并换成安全答复。
    security_scan_enabled: bool = True


class ImageParserSection(BaseModel):
    """图片理解：从对象存储取图，带上标题路径与前后文，交给多模态模型生成可检索的描述。"""

    enabled: bool = True
    #: 图片所在的桶（飞书导入默认 feishu-images）
    bucket_name: str = "feishu-images"
    #: 拿图片前后各几段文本作上下文（遇到图片跳过）
    sibling_count: int = 3
    #: 多模态模型别名（网关里 mode=image 的那个）
    vl_model_name: str = "image-basic"
    #: Nacos 上的提示词 key；取不到就用代码里的兼底提示词
    prompt_key: str = "image_parser_prompt"


class AppConfig(BaseModel):
    llm: LLMSection = Field(default_factory=LLMSection)
    embedding: EmbeddingSection = Field(default_factory=EmbeddingSection)
    chunking: ChunkingSection = Field(default_factory=ChunkingSection)
    retrieval: RetrievalSection = Field(default_factory=RetrievalSection)
    jev: JevSection = Field(default_factory=JevSection)
    index: IndexSection = Field(default_factory=IndexSection)
    agent: AgentSection = Field(default_factory=AgentSection)
    image_parser: ImageParserSection = Field(default_factory=ImageParserSection)


__all__ = [
    "AgentSection",
    "ImageParserSection",
    "AppConfig",
    "ChunkingQuality",
    "ChunkingSection",
    "DenseSection",
    "EmbeddingSection",
    "FusionSection",
    "GraphSection",
    "IndexSection",
    "JevSection",
    "LLMSection",
    "RerankSection",
    "RetrievalSection",
    "SparseSection",
]

"""LLM access settings and the Nacos-owned runtime model sections.

Two layers live here on purpose:

* :class:`LLMSettings` - ``.env`` layer: gateway endpoint, credentials and the
  process-level timeouts/max token ceiling. These are *connection* facts.
* :class:`LLMSection` / :class:`EmbeddingSection` - ``Nacos`` layer
  (``knowledge-hub.yaml``): model aliases and sampling parameters. docs/12 §2
  forbids putting model names in ``.env``, so the aliases are overridable by
  Nacos and only defaulted here.

The effective chat model for a request is neither of these: it comes from the
Nacos AgentSpec (see :mod:`knowledge_hub.config.nacos`), falling back to
:class:`LLMSection` when no spec is available.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from knowledge_hub.config.base import DomainSettings


class LLMSettings(DomainSettings):
    """``.env`` connection facts for the LiteLLM gateway."""

    litellm_base_url: str = "http://127.0.0.1:4000/v1"
    litellm_api_key: str = ""
    openai_api_key: str = ""
    openai_base_url: str = ""
    openai_default_model: str = "gpt-4.1-mini"
    openai_embedding_model: str = "text-embedding"
    embedding_dim: int = 0

    request_timeout_s: float = Field(default=60.0, gt=0)
    # Hard ceiling for a streamed answer so a stalled upstream can never hang SSE.
    stream_timeout_s: float = Field(default=120.0, gt=0)
    chat_max_tokens: int = Field(default=2048, gt=0)
    embedding_batch_size: int = Field(default=10, gt=0)
    embedding_encoding_format: str = "float"

    @property
    def configured(self) -> bool:
        return bool(self.litellm_base_url)


class LLMSection(BaseModel):
    """Nacos ``llm`` section: the default chat alias when no AgentSpec exists."""

    chat_model: str = "gpt-4.1-mini"
    base_url: str = "http://127.0.0.1:4000/v1"
    temperature: float = 0.2
    max_tokens: int = 2048
    stream_timeout_s: float = 120.0


class EmbeddingSection(BaseModel):
    """Nacos ``embedding`` section."""

    model: str = "text-embedding"
    dimensions: int = 1024
    batch_size: int = 10
    encoding_format: str = "float"


__all__ = ["EmbeddingSection", "LLMSection", "LLMSettings"]

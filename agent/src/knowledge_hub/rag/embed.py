"""Embedding stage: LiteLLM OpenAI-compatible ``/embeddings``, batched."""

from __future__ import annotations

import logging
from collections.abc import Sequence

from knowledge_hub.config.settings import EmbeddingSection
from knowledge_hub.errors import EmbeddingError
from knowledge_hub.tools.llm import LLMClient

logger = logging.getLogger(__name__)


class Embedder:
    def __init__(self, llm: LLMClient, section: EmbeddingSection) -> None:
        self.llm = llm
        self.section = section
        self.batch_size = max(1, int(section.batch_size))

    @property
    def expected_dim(self) -> int:
        return int(self.section.dimensions)

    async def embed_texts(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self.batch_size):
            batch = list(texts[start : start + self.batch_size])
            batch_vectors = await self.llm.embed(
                batch,
                model=self.section.model,
                encoding_format=self.section.encoding_format,
            )
            if len(batch_vectors) != len(batch):
                raise EmbeddingError("embedding batch size mismatch")
            for vector in batch_vectors:
                self._check_dim(vector)
            vectors.extend(batch_vectors)
        return vectors

    async def embed_query(self, text: str) -> list[float]:
        vectors = await self.embed_texts([text])
        return vectors[0]

    def _check_dim(self, vector: Sequence[float]) -> None:
        expected = self.expected_dim
        if not vector:
            raise EmbeddingError("embedding vector is empty")
        if expected > 0 and len(vector) != expected:
            raise EmbeddingError(
                f"embedding dimension mismatch: expected {expected}, received {len(vector)}"
            )


__all__ = ["Embedder"]

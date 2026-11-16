"""LiteLLM (OpenAI-compatible) client: embeddings, chat, streaming chat, rerank.

All model traffic goes through this module so error translation to contract codes
(``MODEL_UNAVAILABLE``) happens in exactly one place.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import httpx

from knowledge_hub.errors import EmbeddingError, LLMTimeout, LLMUnavailable

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class StreamDelta:
    text: str = ""
    usage: dict[str, Any] | None = None
    model: str = ""
    finished: bool = False


class LLMClient:
    def __init__(
        self,
        base_url: str,
        api_key: str = "",
        *,
        timeout_s: float = 60.0,
        transport: httpx.AsyncBaseTransport | None = None,
        max_retries: int = 2,
    ) -> None:
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key or ""
        self.timeout_s = timeout_s
        self.max_retries = max_retries
        self._client = httpx.AsyncClient(timeout=timeout_s, transport=transport)

    # ----------------------------------------------------------------- utils
    def _url(self, path: str) -> str:
        return f"{self.base_url}/{path.lstrip('/')}"

    @property
    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def aclose(self) -> None:
        await self._client.aclose()

    @staticmethod
    def _sleep_backoff(attempt: int) -> float:
        return min(2.0, 0.25 * (2**attempt))

    # ------------------------------------------------------------ embeddings
    async def embed(
        self,
        inputs: Sequence[str],
        *,
        model: str,
        dimensions: int | None = None,
        encoding_format: str = "float",
    ) -> list[list[float]]:
        if not inputs:
            return []
        payload: dict[str, Any] = {
            "model": model,
            "input": list(inputs),
            "encoding_format": encoding_format,
        }
        if dimensions and dimensions > 0:
            payload["dimensions"] = dimensions

        last_error: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                resp = await self._client.post(
                    self._url("/embeddings"), json=payload, headers=self._headers
                )
            except httpx.TimeoutException as exc:
                last_error = exc
            except httpx.TransportError as exc:
                raise LLMUnavailable("embedding service unreachable") from exc
            else:
                if resp.status_code >= 400:
                    # 4xx is a configuration problem; retrying will not help.
                    raise EmbeddingError(f"embedding request rejected ({resp.status_code})")
                try:
                    body = resp.json()
                except ValueError as exc:
                    raise EmbeddingError("embedding response was not JSON") from exc
                data = body.get("data") or []
                vectors: list[list[float]] = [[] for _ in inputs]
                for item in data:
                    index = int(item.get("index", -1))
                    vector = item.get("embedding") or []
                    if 0 <= index < len(vectors):
                        vectors[index] = [float(x) for x in vector]
                if any(not vector for vector in vectors):
                    raise EmbeddingError("embedding response incomplete")
                return vectors
            await asyncio.sleep(self._sleep_backoff(attempt))
        raise EmbeddingError("embedding request timed out") from last_error

    # ------------------------------------------------------------------ chat
    async def chat(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        model: str,
        temperature: float = 0.0,
        max_tokens: int = 1024,
        timeout_s: float | None = None,
        response_format: Mapping[str, Any] | None = None,
        extra_body: Mapping[str, Any] | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model,
            "messages": list(messages),
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        if tools:
            # 函数调用必须显式带上 schemas：之前没传，模型只能把"要调用工具"写成正文 JSON。
            payload["tools"] = list(tools)
            payload["tool_choice"] = tool_choice or "auto"
        if response_format is not None:
            payload["response_format"] = dict(response_format)
        if extra_body:
            payload.update(dict(extra_body))
        try:
            resp = await self._client.post(
                self._url("/chat/completions"),
                json=payload,
                headers=self._headers,
                timeout=timeout_s or self.timeout_s,
            )
        except httpx.TimeoutException as exc:
            raise LLMTimeout("chat completion timed out") from exc
        except httpx.TransportError as exc:
            raise LLMUnavailable("chat completion service unreachable") from exc
        if resp.status_code >= 400:
            raise LLMUnavailable(f"chat completion rejected ({resp.status_code})")
        try:
            return resp.json()
        except ValueError as exc:
            raise LLMUnavailable("chat completion response was not JSON") from exc

    async def chat_json(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        model: str,
        json_schema: Mapping[str, Any],
        schema_name: str = "decision",
        temperature: float = 0.0,
        max_tokens: int = 512,
        timeout_s: float | None = None,
    ) -> dict[str, Any]:
        """要一个 JSON 对象回来。

        网关/模型对结构化输出的支持很不一致：一部分只认 ``json_schema``，
        一部分只认函数调用，还有的什么都不认（只会写散文）。所以按
        json_schema → 工具调用 → json_object → 纯提示 逐级降级。
        之前只发 json_schema，不支持的结构化调用（图谱抽取）会静默变成"抽不到东西"。
        """
        # 1) 原生 JSON schema
        try:
            body = await self.chat(
                messages,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout_s=timeout_s,
                response_format={
                    "type": "json_schema",
                    "json_schema": {"name": schema_name, "strict": True, "schema": dict(json_schema)},
                },
            )
            return _parse_json_object(_first_message_content(body))
        except (LLMUnavailable, ValueError) as exc:
            last_error: Exception = exc

        # 2) 强制函数调用：把 schema 当参数，模型不必自己"写"JSON 文本
        try:
            body = await self.chat(
                messages,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout_s=timeout_s,
                tools=[{
                    "type": "function",
                    "function": {
                        "name": schema_name,
                        "description": "按给定 schema 提交结构化结果",
                        "parameters": dict(json_schema),
                    },
                }],
                tool_choice={"type": "function", "function": {"name": schema_name}},
            )
            arguments = _first_tool_arguments(body)
            if arguments:
                return _parse_json_object(arguments)
        except (LLMUnavailable, ValueError) as exc:
            last_error = exc

        # 3) JSON 模式（不约束具体字段）
        try:
            body = await self.chat(
                messages,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout_s=timeout_s,
                response_format={"type": "json_object"},
            )
            return _parse_json_object(_first_message_content(body))
        except (LLMUnavailable, ValueError) as exc:
            last_error = exc

        # 4) 纯提示兜底：把"只要 JSON"说死，再尽力解析
        try:
            guard = {"role": "user", "content": "只输出一个 JSON 对象，不要解释、不要代码块、不要前后缀。"}
            body = await self.chat(
                [*messages, guard],
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout_s=timeout_s,
            )
            return _parse_json_object(_first_message_content(body))
        except (LLMUnavailable, ValueError) as exc:
            last_error = exc

        raise LLMUnavailable(f"structured output unsupported: {last_error}")

    async def chat_stream(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        model: str,
        temperature: float = 0.2,
        max_tokens: int = 2048,
        timeout_s: float | None = None,
        include_usage: bool = True,
        extra_body: Mapping[str, Any] | None = None,
    ) -> AsyncIterator[StreamDelta]:
        payload: dict[str, Any] = {
            "model": model,
            "messages": list(messages),
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": True,
        }
        if include_usage:
            payload["stream_options"] = {"include_usage": True}
        if extra_body:
            payload.update(dict(extra_body))

        try:
            async with self._client.stream(
                "POST",
                self._url("/chat/completions"),
                json=payload,
                headers=self._headers,
                timeout=timeout_s or self.timeout_s,
            ) as resp:
                if resp.status_code >= 400:
                    await resp.aread()
                    raise LLMUnavailable(f"chat stream rejected ({resp.status_code})")
                async for raw_line in resp.aiter_lines():
                    line = raw_line.strip()
                    if not line or line.startswith(":"):
                        continue
                    if line.startswith("data:"):
                        line = line[5:].strip()
                    if line == "[DONE]":
                        yield StreamDelta(finished=True, model=model)
                        return
                    try:
                        chunk = json.loads(line)
                    except ValueError:
                        continue
                    usage = chunk.get("usage")
                    choices = chunk.get("choices") or []
                    text = ""
                    finished = False
                    if choices:
                        choice = choices[0]
                        delta = choice.get("delta") or {}
                        text = delta.get("content") or ""
                        finished = bool(choice.get("finish_reason"))
                    if usage:
                        yield StreamDelta(usage=usage, model=str(chunk.get("model") or model))
                    if text:
                        yield StreamDelta(text=text, model=model)
                    if finished:
                        yield StreamDelta(finished=True, model=model)
                        return
        except httpx.TimeoutException as exc:
            raise LLMTimeout("chat stream timed out") from exc
        except httpx.TransportError as exc:
            raise LLMUnavailable("chat completion service unreachable") from exc

    # ---------------------------------------------------------------- rerank
    async def rerank(
        self,
        query: str,
        documents: Sequence[str],
        *,
        model: str,
        top_n: int | None = None,
    ) -> list[tuple[int, float]]:
        payload: dict[str, Any] = {"model": model, "query": query, "documents": list(documents)}
        if top_n:
            payload["top_n"] = top_n
        try:
            resp = await self._client.post(
                self._url("/rerank"), json=payload, headers=self._headers
            )
        except httpx.TimeoutException as exc:
            raise LLMTimeout("rerank timed out") from exc
        except httpx.TransportError as exc:
            raise LLMUnavailable("rerank service unreachable") from exc
        if resp.status_code >= 400:
            raise LLMUnavailable(f"rerank rejected ({resp.status_code})")
        body = resp.json()
        results = body.get("results") or body.get("data") or []
        ranked: list[tuple[int, float]] = []
        for item in results:
            index = int(item.get("index", -1))
            score = float(item.get("relevance_score", item.get("score", 0.0)))
            if 0 <= index < len(documents):
                ranked.append((index, score))
        return ranked


def _first_message_content(body: Mapping[str, Any]) -> str:
    choices = body.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [part.get("text", "") for part in content if isinstance(part, Mapping)]
        return "".join(parts)
    return ""


def _first_tool_arguments(body: Mapping[str, Any]) -> str:
    """强制函数调用时，结构化结果在 tool_calls[0].function.arguments 里。"""
    choices = body.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    calls = message.get("tool_calls") or []
    if not calls:
        return ""
    function = (calls[0] or {}).get("function") or {}
    arguments = function.get("arguments")
    return arguments if isinstance(arguments, str) else ""


def _parse_json_object(content: str) -> dict[str, Any]:
    text = (content or "").strip()
    if not text:
        raise ValueError("empty model response")
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("model response did not contain a JSON object")
    parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("model response JSON is not an object")
    return parsed


__all__ = ["LLMClient", "StreamDelta"]

"""Config resolution: deep merge, ``${ENV:default}`` expansion, env overrides.

Pure functions with no I/O, so the precedence rules stay unit-testable without
Nacos, a network, or an environment.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from typing import Any

_PLACEHOLDER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}")
_MAX_PLACEHOLDER_DEPTH = 5


def deep_merge(base: Mapping[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    """Recursive merge where ``override`` wins on scalars."""
    merged: dict[str, Any] = dict(base)
    for key, value in override.items():
        current = merged.get(key)
        if isinstance(current, Mapping) and isinstance(value, Mapping):
            merged[key] = deep_merge(current, value)
        else:
            merged[key] = value
    return merged


def resolve_placeholders(
    value: Any, env: Mapping[str, str] | None = None, _depth: int = 0
) -> Any:
    """Expand ``${ENV_VAR}`` / ``${ENV_VAR:default}`` recursively."""
    source = os.environ if env is None else env
    if _depth > _MAX_PLACEHOLDER_DEPTH:
        return value
    if isinstance(value, str):

        def _sub(match: re.Match[str]) -> str:
            name = match.group(1)
            default = match.group(2) or ""
            return source.get(name, default)

        resolved = _PLACEHOLDER.sub(_sub, value)
        if resolved != value:
            return resolve_placeholders(resolved, source, _depth + 1)
        return resolved
    if isinstance(value, dict):
        return {k: resolve_placeholders(v, source, _depth) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_placeholders(v, source, _depth) for v in value]
    return value


def _explicit_env(name: str, env: Mapping[str, str]) -> str | None:
    value = env.get(name)
    if value is None or value == "":
        return None
    return value


def apply_env_overrides(config: dict[str, Any], env: Mapping[str, str]) -> list[str]:
    """Env vars win over Nacos values for the endpoints/aliases they own."""
    overrides: list[str] = []
    llm = config.setdefault("llm", {})
    if (value := _explicit_env("OPENAI_DEFAULT_MODEL", env)) is not None:
        llm["chat_model"] = value
        overrides.append("llm.chat_model")
    if (value := _explicit_env("LITELLM_BASE_URL", env)) is not None:
        llm["base_url"] = value
        overrides.append("llm.base_url")
    embedding = config.setdefault("embedding", {})
    if (value := _explicit_env("OPENAI_EMBEDDING_MODEL", env)) is not None:
        embedding["model"] = value
        overrides.append("embedding.model")
    if (value := _explicit_env("EMBEDDING_DIM", env)) is not None:
        embedding["dimensions"] = value
        overrides.append("embedding.dimensions")
    return overrides


__all__ = ["apply_env_overrides", "deep_merge", "resolve_placeholders"]

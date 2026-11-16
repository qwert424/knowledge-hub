"""HTTP layer (FastAPI app, schemas, SSE framing, container)."""

from typing import Any

__all__ = ["Container", "build_container", "create_app"]


def __getattr__(name: str) -> Any:
    # Lazy so importing a submodule does not build the FastAPI app eagerly.
    if name in {"Container", "build_container"}:
        from knowledge_hub.api import container as container_module

        return getattr(container_module, name)
    if name == "create_app":
        from knowledge_hub.api.main import create_app

        return create_app
    raise AttributeError(name)

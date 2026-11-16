"""Redis Stream index worker."""

from typing import Any

__all__ = ["IndexWorker"]


def __getattr__(name: str) -> Any:
    # Lazy so `python -m knowledge_hub.worker.main` does not double-import.
    if name == "IndexWorker":
        from knowledge_hub.worker.main import IndexWorker

        return IndexWorker
    raise AttributeError(name)

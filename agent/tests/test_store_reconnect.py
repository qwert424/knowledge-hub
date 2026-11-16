"""ChunkStore handle invalidation.

Milvus 重启后，进程内缓存的 Collection 句柄会绑在已关闭的 gRPC 通道上。
ensure_collection 命中缓存就直接返回，于是「容器活着但检索永久失败」。
这里锁住修复：连接代数一变，缓存句柄必须被丢掉。
"""

from __future__ import annotations

from typing import Any

from knowledge_hub.config.settings import EnvSettings
from knowledge_hub.rag.store import ChunkStore


class _FakeSession:
    def __init__(self) -> None:
        self.generation = 0


def _store(env_settings: EnvSettings) -> ChunkStore:
    return ChunkStore(env_settings, session=_FakeSession())  # type: ignore[arg-type]


def test_stale_handles_are_dropped_after_reconnect(env_settings: EnvSettings) -> None:
    store = _store(env_settings)
    store._collections["kb_chunks_8"] = object()  # noqa: SLF001 - 直接构造缓存
    store._sparse_support["kb_chunks_8"] = True  # noqa: SLF001

    store._drop_stale_handles()  # noqa: SLF001 - 同一代，什么都不做
    assert "kb_chunks_8" in store._collections  # noqa: SLF001

    store.session.generation += 1  # type: ignore[attr-defined]
    store._drop_stale_handles()  # noqa: SLF001
    assert store._collections == {}  # noqa: SLF001
    assert store._sparse_support == {}  # noqa: SLF001


def test_generation_tracks_session(env_settings: EnvSettings) -> None:
    store = _store(env_settings)
    session: Any = store.session
    assert store._generation == session.generation  # noqa: SLF001
    session.generation = 3
    store._drop_stale_handles()  # noqa: SLF001
    assert store._generation == 3  # noqa: SLF001

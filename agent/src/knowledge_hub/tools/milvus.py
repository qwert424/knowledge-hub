"""Milvus connection factory (lazy, never connects at import time)."""

from __future__ import annotations

import logging
import threading
import time

from knowledge_hub.config.settings import EnvSettings
from knowledge_hub.errors import MilvusUnavailable

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_alias_counter = 0


def next_alias(prefix: str = "kh") -> str:
    global _alias_counter
    with _lock:
        _alias_counter += 1
        return f"{prefix}_{_alias_counter}"


def _list_databases(alias: str) -> list[str]:
    from pymilvus import utility

    if hasattr(utility, "list_databases"):  # pymilvus < 3
        return list(utility.list_databases(using=alias))
    from pymilvus.orm import db as db_module  # pymilvus >= 3

    return list(db_module.list_database(using=alias))


def _create_database(alias: str, name: str) -> None:
    from pymilvus import utility

    if hasattr(utility, "create_database"):  # pymilvus < 3
        utility.create_database(name, using=alias)
        return
    from pymilvus.orm import db as db_module  # pymilvus >= 3

    db_module.create_database(name, using=alias)


class MilvusSession:
    """Owns one pymilvus connection alias and the target database."""

    def __init__(self, env: EnvSettings, *, alias: str | None = None) -> None:
        self.env = env
        self.alias = alias or next_alias()
        self.timeout_s = max(0.5, env.milvus.timeout_ms / 1000.0)
        self._connected = False
        self._db_ready = False
        # 熔断窗口：向量库不可用时立刻失败，避免每次问答都卡满检索预算
        self._breaker_s = max(5.0, self.timeout_s * 3)
        self._fail_until = 0.0
        # 连接代数：断开/重连时 +1。ChunkStore 用它判断手上的 Collection 句柄是否已经失效
        # （Milvus 重启后旧 Collection 绑在关闭的通道上，不重建就永远搜不出东西）。
        self._generation = 0

    @property
    def generation(self) -> int:
        return self._generation

    # ------------------------------------------------------------- internals
    def _check_breaker(self) -> None:
        remaining = self._fail_until - time.monotonic()
        if remaining > 0:
            raise MilvusUnavailable(
                f"milvus unavailable, retry in {remaining:.1f}s (backoff)"
            )

    def note_failure(self) -> None:
        """标记一次连接级失败：丢弃旧通道并开启退避窗口。"""
        self._fail_until = time.monotonic() + self._breaker_s
        try:
            from pymilvus import connections

            if self._connected:
                connections.disconnect(self.alias)
        except Exception:  # pragma: no cover - best effort
            pass
        self._connected = False
        self._db_ready = False
        self._generation += 1

    def note_success(self) -> None:
        self._fail_until = 0.0

    def _connect(self, *, db_name: str | None = None) -> None:
        from pymilvus import connections

        self._check_breaker()

        kwargs: dict[str, object] = {
            "alias": self.alias,
            "uri": self.env.milvus.uri,
            "timeout": self.timeout_s,
        }
        if db_name:
            kwargs["db_name"] = db_name
        if self.env.milvus.token:
            kwargs["token"] = self.env.milvus.token
        try:
            connections.connect(**kwargs)
        except Exception as exc:  # pymilvus raises bare MilvusException subclasses
            raise MilvusUnavailable(f"milvus connect failed: {exc}") from exc
        self._connected = True

    # ---------------------------------------------------------------- public
    def connect(self) -> str:
        if not self._connected:
            self._connect()
        if not self._db_ready:
            self.ensure_database()
        return self.alias

    def ensure_database(self) -> None:
        from pymilvus import connections

        name = (self.env.milvus.db_name or "default").strip() or "default"
        if name == "default":
            self._db_ready = True
            return
        try:
            databases = set(_list_databases(self.alias))
            if name not in databases:
                _create_database(self.alias, name)
                logger.info("created milvus database %s", name)
            connections.disconnect(self.alias)
            self._connected = False
            self._connect(db_name=name)
            self._db_ready = True
        except MilvusUnavailable:
            raise
        except Exception as exc:
            raise MilvusUnavailable(f"milvus database init failed: {exc}") from exc

    def health(self) -> bool:
        try:
            from pymilvus import utility

            if not self._connected:
                self._connect()
            utility.list_collections(using=self.alias)
            return True
        except Exception as exc:
            logger.debug("milvus health probe failed: %s", exc)
            return False

    def close(self) -> None:
        try:
            from pymilvus import connections

            if self._connected:
                connections.disconnect(self.alias)
        except Exception:  # pragma: no cover - best effort
            pass
        finally:
            self._connected = False
            self._db_ready = False
            self._generation += 1

    def list_collections(self) -> list[str]:
        from pymilvus import utility

        self.connect()
        try:
            return list(utility.list_collections(using=self.alias))
        except Exception as exc:
            raise MilvusUnavailable(f"milvus list_collections failed: {exc}") from exc


__all__ = ["MilvusSession", "next_alias"]

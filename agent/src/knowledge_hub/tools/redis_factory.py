"""Redis client factory shared by the worker and health probes."""

from __future__ import annotations

from knowledge_hub.config.settings import EnvSettings

STREAM_INDEX = "kh:stream:index.job.created"
STREAM_ACL = "kh:stream:acl.sync"
STREAM_GRAPH = "kh:stream:graph.jobs"
CONSUMER_GROUP = "kh-workers"
IDEMPOTENCY_PREFIX = "kh:worker:idem:"
DLQ_SUFFIX = ".dlq"


def redis_url(env: EnvSettings) -> str:
    return env.redis.url


def dlq_key(stream: str) -> str:
    return f"{stream}{DLQ_SUFFIX}"


def idempotency_key(event_id: str) -> str:
    return f"{IDEMPOTENCY_PREFIX}{event_id}"


async def create_async_redis(env: EnvSettings, *, socket_timeout: float | None = None):
    """Async Redis client.

    ``socket_timeout`` must exceed the blocking ``XREADGROUP`` timeout, otherwise
    every blocking read raises a read timeout and the worker logs a warning loop
    instead of idling quietly.
    """
    from redis.asyncio import Redis

    kwargs: dict[str, object] = {"decode_responses": True}
    if socket_timeout and socket_timeout > 0:
        kwargs["socket_timeout"] = float(socket_timeout)
    return Redis.from_url(redis_url(env), **kwargs)


__all__ = [
    "CONSUMER_GROUP",
    "DLQ_SUFFIX",
    "IDEMPOTENCY_PREFIX",
    "STREAM_ACL",
    "STREAM_GRAPH",
    "STREAM_INDEX",
    "create_async_redis",
    "dlq_key",
    "idempotency_key",
    "redis_url",
]

"""Cache-aside helpers: values are stored in Redis as JSON text, each with an expiry.

The route does the work: try cache_get; on a miss, query the database and cache_set the result.
Whatever writes the underlying data must cache_delete the key, or readers see stale data
until the TTL runs out.
"""

import json
import logging
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import RedisError

log = logging.getLogger(__name__)

# Like the login rate limit, every call fails open: with Redis down the cache is just
# skipped and the route reads the database, which is slower but still correct.


async def cache_get(redis: Redis | None, key: str) -> Any | None:
    """The cached value, or None on a miss (or with no Redis)."""
    if redis is None:
        return None
    try:
        raw = await redis.get(key)
    except RedisError:
        log.warning("Redis unavailable, cache read skipped", exc_info=True)
        return None
    return None if raw is None else json.loads(raw)


async def cache_set(redis: Redis | None, key: str, value: Any, ttl: int) -> None:
    if redis is None:
        return
    try:
        # ex=ttl: SET and EXPIRE in one command. The TTL is a safety net: even if an
        # invalidation is ever missed, a stale value lives at most this long.
        await redis.set(key, json.dumps(value), ex=ttl)
    except RedisError:
        log.warning("Redis unavailable, value not cached", exc_info=True)


async def cache_delete(redis: Redis | None, key: str) -> None:
    if redis is None:
        return
    try:
        await redis.delete(key)
    except RedisError:
        log.warning("Redis unavailable, cache entry not invalidated", exc_info=True)

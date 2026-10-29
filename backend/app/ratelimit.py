"""Login brute-force protection: count failed logins in Redis, block after too many.

One counter per (client IP, username) pair, e.g. key `login:fail:203.0.113.7:neo`.
The counter deletes itself WINDOW_SECONDS after the first failure, so blocks lift on their own.
"""

import logging

from fastapi import Request
from redis.asyncio import Redis
from redis.exceptions import RedisError

log = logging.getLogger(__name__)

MAX_FAILURES = 5
WINDOW_SECONDS = 15 * 60


def failed_login_key(request: Request, username: str) -> str:
    ip = request.client.host if request.client else "unknown"
    return f"login:fail:{ip}:{username.lower()}"


# Every Redis call below "fails open": if Redis is down, log it and let the login go through.
# Locking every user out because Redis is down would be worse than briefly losing the limit.


async def seconds_blocked(redis: Redis | None, key: str) -> int:
    """0 if this client may try to log in, otherwise how many seconds until it may."""
    if redis is None:
        return 0
    try:
        count = await redis.get(key)
        if count is None or int(count) < MAX_FAILURES:
            return 0
        return max(await redis.ttl(key), 1)
    except RedisError:
        log.warning("Redis unavailable, login rate limit skipped", exc_info=True)
        return 0


async def record_failure(redis: Redis | None, key: str) -> None:
    if redis is None:
        return
    try:
        # MULTI/EXEC: both commands run together, so the counter can't end up without an expiry.
        # nx=True sets the expiry only on the first failure; later ones don't extend the window.
        async with redis.pipeline(transaction=True) as pipe:
            pipe.incr(key)
            pipe.expire(key, WINDOW_SECONDS, nx=True)
            await pipe.execute()
    except RedisError:
        log.warning("Redis unavailable, failed login not counted", exc_info=True)


async def clear_failures(redis: Redis | None, key: str) -> None:
    if redis is None:
        return
    try:
        await redis.delete(key)
    except RedisError:
        log.warning("Redis unavailable, failed-login counter not cleared", exc_info=True)

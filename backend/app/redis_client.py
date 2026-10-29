"""The one shared Redis client, used by the login rate limit and the cache."""

from redis.asyncio import Redis
from redis.asyncio.retry import Retry
from redis.backoff import NoBackoff

from app.config import settings

# Created once and shared; it connects lazily on the first command, not here.
# No retries (redis-py's default is 10 with backoff): with Redis down, a request should wait
# at most the 1s timeout, not several seconds per Redis call.
_redis = (
    Redis.from_url(settings.REDIS_URL, socket_timeout=1, socket_connect_timeout=1, retry=Retry(NoBackoff(), 0))
    if settings.REDIS_URL
    else None
)


def get_redis() -> Redis | None:
    """FastAPI dependency, so tests can swap in a fake Redis."""
    return _redis

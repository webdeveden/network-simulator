from redis.asyncio import Redis
from redis.asyncio.retry import Retry
from redis.backoff import NoBackoff

from app.main import app
from app.ratelimit import MAX_FAILURES, WINDOW_SECONDS
from app.redis_client import get_redis
from tests.conftest import auth_headers

WRONG = {"username": "neo", "password": "wrongpass"}
RIGHT = {"username": "neo", "password": "matrix123"}


async def test_blocks_after_too_many_failures(client, redis):
    await auth_headers(client)
    for _ in range(MAX_FAILURES):
        assert (await client.post("/api/auth/login", json=WRONG)).status_code == 401

    blocked = await client.post("/api/auth/login", json=WRONG)
    assert blocked.status_code == 429
    assert 0 < int(blocked.headers["Retry-After"]) <= WINDOW_SECONDS
    # Even the right password is refused while blocked
    assert (await client.post("/api/auth/login", json=RIGHT)).status_code == 429

    # The counter lives in Redis and expires on its own
    key = "login:fail:127.0.0.1:neo"
    assert int(await redis.get(key)) == MAX_FAILURES
    assert 0 < await redis.ttl(key) <= WINDOW_SECONDS


async def test_successful_login_resets_counter(client):
    await auth_headers(client)
    for _ in range(MAX_FAILURES - 1):
        await client.post("/api/auth/login", json=WRONG)
    assert (await client.post("/api/auth/login", json=RIGHT)).status_code == 200

    # Back to a full set of attempts
    for _ in range(MAX_FAILURES):
        assert (await client.post("/api/auth/login", json=WRONG)).status_code == 401


async def test_block_is_per_username(client):
    await auth_headers(client, "neo")
    await auth_headers(client, "trinity")
    for _ in range(MAX_FAILURES):
        await client.post("/api/auth/login", json=WRONG)

    ok = await client.post("/api/auth/login", json={"username": "trinity", "password": "matrix123"})
    assert ok.status_code == 200


async def test_login_still_works_when_redis_is_down(client):
    await auth_headers(client)
    # Nothing listens on port 1: every Redis call fails, and login must fail open
    down = Redis(port=1, socket_connect_timeout=0.2, retry=Retry(NoBackoff(), 0))
    app.dependency_overrides[get_redis] = lambda: down
    try:
        assert (await client.post("/api/auth/login", json=WRONG)).status_code == 401
        assert (await client.post("/api/auth/login", json=RIGHT)).status_code == 200
    finally:
        await down.aclose()

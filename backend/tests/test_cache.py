from redis.asyncio import Redis
from redis.asyncio.retry import Retry
from redis.backoff import NoBackoff

from app.main import app
from app.redis_client import get_redis
from app.routers.missions import PROGRESS_TTL_SECONDS
from tests.conftest import auth_headers

TOPO = {"devices": [], "links": []}
URL = "/api/missions/hello-world/complete"


async def test_progress_miss_then_hit(client, redis):
    h = await auth_headers(client)
    await client.post(URL, json={"stars": 2, "time": 90, "cost": 10, "topology": TOPO}, headers=h)

    first = await client.get("/api/progress", headers=h)
    second = await client.get("/api/progress", headers=h)
    assert first.headers["X-Cache"] == "MISS"
    assert second.headers["X-Cache"] == "HIT"
    assert first.json() == second.json() == [
        {"mission_id": "hello-world", "stars": 2, "best_time": 90, "best_cost": 10}
    ]

    # Stored in Redis with an expiry, and without the bulky topology
    key = (await redis.keys("cache:progress:user:*"))[0]
    assert 0 < await redis.ttl(key) <= PROGRESS_TTL_SECONDS
    assert b"topology" not in await redis.get(key)


async def test_completing_a_mission_invalidates(client):
    h = await auth_headers(client)
    await client.post(URL, json={"stars": 1, "time": 90, "cost": 10, "topology": TOPO}, headers=h)
    await client.get("/api/progress", headers=h)  # now cached with 1 star

    await client.post(URL, json={"stars": 3, "time": 60, "cost": 10, "topology": TOPO}, headers=h)
    after = await client.get("/api/progress", headers=h)
    # Without the invalidation this would be a HIT still showing 1 star
    assert after.headers["X-Cache"] == "MISS"
    assert after.json()[0]["stars"] == 3


async def test_cache_is_per_user(client):
    alice = await auth_headers(client, "alice")
    bob = await auth_headers(client, "bob")
    await client.post(URL, json={"stars": 3, "time": 90, "cost": 10, "topology": TOPO}, headers=alice)
    await client.get("/api/progress", headers=alice)

    assert (await client.get("/api/progress", headers=bob)).json() == []


async def test_progress_works_when_redis_is_down(client):
    h = await auth_headers(client)
    await client.post(URL, json={"stars": 2, "time": 90, "cost": 10, "topology": TOPO}, headers=h)
    down = Redis(port=1, socket_connect_timeout=0.2, retry=Retry(NoBackoff(), 0))
    app.dependency_overrides[get_redis] = lambda: down
    try:
        r = await client.get("/api/progress", headers=h)
        assert r.status_code == 200
        assert r.headers["X-Cache"] == "MISS"
        assert r.json()[0]["stars"] == 2
    finally:
        await down.aclose()

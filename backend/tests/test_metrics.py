from prometheus_client import REGISTRY
from redis.asyncio import Redis
from redis.asyncio.retry import Retry
from redis.backoff import NoBackoff

from app.main import app
from app.ratelimit import MAX_FAILURES
from app.redis_client import get_redis
from tests.conftest import auth_headers

WRONG = {"username": "neo", "password": "wrongpass"}
RIGHT = {"username": "neo", "password": "matrix123"}


def sample(name: str, **labels: str) -> float:
    """Current value of a counter. Counters are process-wide and keep counting across tests,
    so tests compare before and after instead of expecting exact totals."""
    return REGISTRY.get_sample_value(name, labels) or 0.0


async def test_metrics_endpoint_lists_http_and_netsim_metrics(client):
    await client.get("/api/missions")
    r = await client.get("/metrics")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    # Labelled by route template, not the concrete URL
    assert 'http_requests_total{handler="/api/missions",method="GET",status="200"}' in r.text
    assert "netsim_login_attempts_total" in r.text
    # Prometheus scraping itself every 15s would only add noise
    assert 'handler="/metrics"' not in r.text


async def test_login_attempts_are_counted_by_result(client):
    await auth_headers(client)
    before = {res: sample("netsim_login_attempts_total", result=res) for res in ("success", "failure", "blocked")}

    await client.post("/api/auth/login", json=RIGHT)
    for _ in range(MAX_FAILURES + 2):
        await client.post("/api/auth/login", json=WRONG)

    assert sample("netsim_login_attempts_total", result="success") - before["success"] == 1
    assert sample("netsim_login_attempts_total", result="failure") - before["failure"] == MAX_FAILURES
    assert sample("netsim_login_attempts_total", result="blocked") - before["blocked"] == 2


async def test_cache_hits_and_misses_are_counted(client):
    h = await auth_headers(client)
    hit = sample("netsim_cache_requests_total", cache="progress", result="hit")
    miss = sample("netsim_cache_requests_total", cache="progress", result="miss")

    for _ in range(3):
        await client.get("/api/progress", headers=h)

    assert sample("netsim_cache_requests_total", cache="progress", result="miss") - miss == 1
    assert sample("netsim_cache_requests_total", cache="progress", result="hit") - hit == 2


async def test_redis_errors_are_counted(client):
    h = await auth_headers(client)
    before = sample("netsim_redis_errors_total", operation="cache_get")
    down = Redis(port=1, socket_connect_timeout=0.2, retry=Retry(NoBackoff(), 0))
    app.dependency_overrides[get_redis] = lambda: down
    try:
        assert (await client.get("/api/progress", headers=h)).status_code == 200
    finally:
        await down.aclose()
    assert sample("netsim_redis_errors_total", operation="cache_get") - before == 1

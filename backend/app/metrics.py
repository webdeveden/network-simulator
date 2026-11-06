"""Prometheus metrics: NetSim-specific counters on top of the per-endpoint HTTP metrics.

Prometheus scrapes GET /metrics (see app/main.py) every few seconds. Counters only ever go up;
dashboards turn them into "per second" with rate(). Label values must stay a small fixed set
(never usernames, IPs or ids): every distinct combination becomes its own time series.
"""

from prometheus_client import Counter

LOGIN_ATTEMPTS = Counter(
    "netsim_login_attempts_total",
    "Login attempts by outcome: success, failure (wrong username or password), blocked (rate limited)",
    ["result"],
)

CACHE_REQUESTS = Counter(
    "netsim_cache_requests_total",
    "Cache lookups by cache name and result (hit or miss)",
    ["cache", "result"],
)

# Redis failures are logged and skipped (fail open), so without this counter nobody would notice
REDIS_ERRORS = Counter(
    "netsim_redis_errors_total",
    "Redis calls that failed and were skipped",
    ["operation"],
)

# Create every label combination at 0 up front. Otherwise a series only appears after its first
# event, and Prometheus/Grafana can't tell "zero so far" from "not reporting at all".
for _result in ("success", "failure", "blocked"):
    LOGIN_ATTEMPTS.labels(result=_result)
for _result in ("hit", "miss"):
    CACHE_REQUESTS.labels(cache="progress", result=_result)
for _op in ("ratelimit_check", "ratelimit_record", "ratelimit_clear", "cache_get", "cache_set", "cache_delete"):
    REDIS_ERRORS.labels(operation=_op)

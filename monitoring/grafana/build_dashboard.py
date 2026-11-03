"""Generates dashboards/netsim.json, the NetSim Grafana dashboard.

Standard library only. Run from anywhere:  python3 monitoring/grafana/build_dashboard.py
then reload Grafana:                         docker compose restart grafana

You don't have to use this: editing in the Grafana UI and exporting the JSON over the file
works too. If you do both, the next run of this script overwrites the UI changes.

Each panel() call below is one panel: its type, title, PromQL queries and grid position.
Everything else in the JSON (data source, legend, styling) is boilerplate filled in here.
"""

import json
from pathlib import Path

OUT = Path(__file__).parent / "dashboards" / "netsim.json"

# Must match uid in provisioning/datasources/prometheus.yml
DS = {"type": "prometheus", "uid": "prometheus"}

panels = []
pid = 0


def panel(kind, title, targets, x, y, w, h, unit=None, desc=None, extra=None):
    """Adds one panel.

    kind:     "timeseries" (line chart) or "stat" (one big number)
    targets:  list of (PromQL query, legend) pairs; one line per series. In the legend,
              {{label}} shows that label's value, e.g. {{result}} -> success / failure
    x, y:     top-left corner on Grafana's grid: 24 columns wide, rows of about 30px
    w, h:     width (columns) and height (rows)
    unit:     Grafana unit id: "reqps", "s", "bytes", "percentunit" (0.25 shows as 25%)
    desc:     hover text on the panel's (i) icon
    extra:    more fieldConfig defaults: thresholds, mappings, min, decimals
    """
    global pid
    pid += 1
    p = {
        "id": pid, "type": kind, "title": title, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        # refId A, B, C... names each query inside the panel
        "targets": [{"refId": chr(65 + i), "datasource": DS, "expr": e, "legendFormat": l} for i, (e, l) in enumerate(targets)],
        "fieldConfig": {"defaults": {}, "overrides": []},
        "options": {},
    }
    if unit: p["fieldConfig"]["defaults"]["unit"] = unit
    if desc: p["description"] = desc
    if kind == "timeseries":
        p["fieldConfig"]["defaults"]["custom"] = {"lineWidth": 2, "fillOpacity": 10, "showPoints": "never"}
        p["options"] = {"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi"}}
    if kind == "stat":
        # lastNotNull: show the newest value; background: color the whole tile by threshold
        p["options"] = {"reduceOptions": {"calcs": ["lastNotNull"]}, "colorMode": "background", "graphMode": "none", "textMode": "value"}
    if extra:
        for k, v in extra.items():
            p["fieldConfig"]["defaults"][k] = v
    panels.append(p)


def row(title, y):
    """A full-width section header."""
    global pid
    pid += 1
    panels.append({"id": pid, "type": "row", "title": title, "collapsed": False, "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}, "panels": []})


def thresholds(*steps):
    """Colors by value, e.g. ("red", None), ("green", 1): red below 1, green from 1 up."""
    return {"mode": "absolute", "steps": [{"color": c, "value": v} for c, v in steps]}


# In queries, Grafana fills in $__rate_interval (a window that fits the zoom level and scrape
# interval, about 1m here) and $__range (the whole time range picked at the top right).

# ---------------------------------------------------------------- Overview: four big numbers
row("Overview", 0)
panel("stat", "Backend up", [('up{job="backend"}', "")], 0, 1, 6, 4,
      desc="1 = Prometheus can scrape the backend, 0 = it's down",
      extra={"mappings": [{"type": "value", "options": {"0": {"text": "DOWN"}, "1": {"text": "UP"}}}],
             "thresholds": thresholds(("red", None), ("green", 1))})
panel("stat", "Requests / second", [("sum(rate(http_requests_total[$__rate_interval]))", "")], 6, 1, 6, 4,
      unit="reqps", extra={"thresholds": thresholds(("blue", None))})
panel("stat", "5xx error rate", [('sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) or vector(0)', "")], 12, 1, 6, 4,
      unit="percentunit", desc="Share of requests that failed on the server side, last 5 minutes",
      extra={"decimals": 1, "thresholds": thresholds(("green", None), ("orange", 0.01), ("red", 0.05))})
# "> 0" drops the result when there were no reads, so Grafana shows "No data" instead of NaN (0/0)
panel("stat", "Progress cache hit ratio", [
      ('sum(increase(netsim_cache_requests_total{result="hit"}[$__range])) / (sum(increase(netsim_cache_requests_total[$__range])) > 0)', "")], 18, 1, 6, 4,
      unit="percentunit", desc="Of all /api/progress reads in the selected time range, how many Redis answered (no Postgres query)",
      extra={"decimals": 0, "thresholds": thresholds(("red", None), ("orange", 0.5), ("green", 0.8))})

# ---------------------------------------------------------------- Traffic, errors, latency
row("API traffic (golden signals)", 5)
panel("timeseries", "Requests / second by status", [
      ("sum by (status) (rate(http_requests_total[$__rate_interval]))", "{{status}}")], 0, 6, 12, 8, unit="reqps")
panel("timeseries", "Latency (all endpoints)", [
      ("histogram_quantile(0.50, sum by (le) (rate(http_request_duration_highr_seconds_bucket[$__rate_interval])))", "p50 (median)"),
      ("histogram_quantile(0.95, sum by (le) (rate(http_request_duration_highr_seconds_bucket[$__rate_interval])))", "p95"),
      ("histogram_quantile(0.99, sum by (le) (rate(http_request_duration_highr_seconds_bucket[$__rate_interval])))", "p99")], 12, 6, 12, 8,
      unit="s", desc="p95 = 95% of requests were faster than this line")
panel("timeseries", "Requests / second by endpoint", [
      ("sum by (method, handler) (rate(http_requests_total[$__rate_interval]))", "{{method}} {{handler}}")], 0, 14, 24, 8, unit="reqps")

# ---------------------------------------------------------------- The Redis features
row("Security and cache (Redis features)", 22)
panel("timeseries", "Login attempts / minute", [
      ("sum by (result) (rate(netsim_login_attempts_total[$__rate_interval])) * 60", "{{result}}")], 0, 23, 12, 8,
      desc="blocked = rate limited (429). A spike in failure + blocked means password guessing.",
      extra={"min": 0})
panel("timeseries", "Progress cache hits vs misses / minute", [
      ("sum by (result) (rate(netsim_cache_requests_total[$__rate_interval])) * 60", "{{result}}")], 12, 23, 12, 8, extra={"min": 0})

# ---------------------------------------------------------------- Exporters: Redis and Postgres
row("Infrastructure", 31)
panel("timeseries", "Redis errors (fail open)", [
      ("sum by (operation) (increase(netsim_redis_errors_total[$__rate_interval]))", "{{operation}}")], 0, 32, 6, 7,
      desc="Redis calls the backend skipped because Redis was unreachable", extra={"min": 0})
panel("timeseries", "Redis keys", [('sum(redis_db_keys)', "keys")], 6, 32, 6, 7,
      desc="Failed-login counters plus cached responses", extra={"min": 0})
panel("timeseries", "Redis memory", [("redis_memory_used_bytes", "used")], 12, 32, 6, 7, unit="bytes")
panel("timeseries", "Postgres connections", [("sum by (datname) (pg_stat_database_numbackends{datname!~\"template.*|postgres\"})", "{{datname}}")], 18, 32, 6, 7,
      extra={"min": 0})

dashboard = {
    "uid": "netsim",            # stable id: the URL is /d/netsim
    "title": "NetSim", "tags": ["netsim"], "timezone": "browser",
    "schemaVersion": 39, "version": 1, "editable": True,
    "refresh": "10s",           # re-run every query every 10 seconds
    "time": {"from": "now-30m", "to": "now"},
    "panels": panels,
}

OUT.write_text(json.dumps(dashboard, indent=2) + "\n")
print(f"wrote {OUT} ({len(panels)} panels)")

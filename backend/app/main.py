from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from prometheus_fastapi_instrumentator import Instrumentator

from app.config import settings
from app.routers import auth, missions, topologies

app = FastAPI(title="NetSim API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(topologies.router)
app.include_router(missions.router)

# Request count, status and duration for every endpoint, served at GET /metrics for Prometheus.
# Labels use the route template (/api/missions/{mission_id}), not the real path, so the
# number of time series stays small. Keep exact status codes: 401 vs 429 matters here.
# /metrics sits outside /api/, so nginx never forwards it: only containers inside the
# Docker network (Prometheus) can read it.
Instrumentator(
    should_group_status_codes=False,
    excluded_handlers=["/metrics", "/api/health"],
).instrument(app).expose(app, include_in_schema=False)


@app.get("/api/health")
async def health():
    return {"status": "ok"}

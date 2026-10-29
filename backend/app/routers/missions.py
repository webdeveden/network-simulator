from fastapi import APIRouter, Depends, HTTPException, Response, status
from redis.asyncio import Redis
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.cache import cache_delete, cache_get, cache_set
from app.database import get_session
from app.missions import MISSIONS, MISSIONS_BY_ID
from app.models import Progress, User, utcnow
from app.redis_client import get_redis
from app.schemas import CompletionWrite, ProgressRead
from app.security import get_current_user

router = APIRouter(prefix="/api", tags=["missions"])

PROGRESS_TTL_SECONDS = 10 * 60


def _progress_key(user_id: int) -> str:
    return f"cache:progress:user:{user_id}"


@router.get("/missions")
async def list_missions():
    return MISSIONS


@router.get("/missions/{mission_id}")
async def get_mission(mission_id: str):
    mission = MISSIONS_BY_ID.get(mission_id)
    if mission is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Mission not found")
    return mission


@router.post("/missions/{mission_id}/complete", response_model=ProgressRead)
async def complete_mission(
    mission_id: str,
    body: CompletionWrite,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    redis: Redis | None = Depends(get_redis),
):
    if mission_id not in MISSIONS_BY_ID:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Mission not found")
    progress = (
        await session.exec(
            select(Progress).where(Progress.user_id == user.id, Progress.mission_id == mission_id)
        )
    ).first()
    if progress is None:
        progress = Progress(
            user_id=user.id,
            mission_id=mission_id,
            stars=body.stars,
            best_time=body.time,
            best_cost=body.cost,
            topology=body.topology,
        )
    else:
        if body.stars >= progress.stars:
            progress.topology = body.topology
        progress.stars = max(progress.stars, body.stars)
        progress.best_time = min(progress.best_time, body.time)
        progress.best_cost = min(progress.best_cost, body.cost)
        progress.completed_at = utcnow()
    session.add(progress)
    await session.commit()
    # Invalidate after the commit: deleting first would let a request in between re-cache the old rows
    await cache_delete(redis, _progress_key(user.id))
    await session.refresh(progress)
    return progress


@router.get("/progress", response_model=list[ProgressRead])
async def list_progress(
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    redis: Redis | None = Depends(get_redis),
):
    key = _progress_key(user.id)
    # X-Cache shows in the browser's Network tab (and curl -i) whether Redis answered
    if (cached := await cache_get(redis, key)) is not None:
        response.headers["X-Cache"] = "HIT"
        return cached
    rows = (await session.exec(select(Progress).where(Progress.user_id == user.id))).all()
    # Cache only the fields the response returns, not each row's saved topology
    progress = [ProgressRead.model_validate(r, from_attributes=True).model_dump() for r in rows]
    await cache_set(redis, key, progress, PROGRESS_TTL_SECONDS)
    response.headers["X-Cache"] = "MISS"
    return progress

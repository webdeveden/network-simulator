from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.database import get_session
from app.missions import MISSIONS, MISSIONS_BY_ID
from app.models import Progress, User, utcnow
from app.schemas import CompletionWrite, ProgressRead
from app.security import get_current_user

router = APIRouter(prefix="/api", tags=["missions"])


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
    await session.refresh(progress)
    return progress


@router.get("/progress", response_model=list[ProgressRead])
async def list_progress(
    user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)
):
    return (await session.exec(select(Progress).where(Progress.user_id == user.id))).all()

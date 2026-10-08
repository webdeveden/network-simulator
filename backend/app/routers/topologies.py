from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.database import get_session
from app.models import Topology, User, utcnow
from app.schemas import TopologyRead, TopologyWrite
from app.security import get_current_user

router = APIRouter(prefix="/api/topologies", tags=["topologies"])


async def get_owned_topology(
    topology_id: int,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> Topology:
    topo = await session.get(Topology, topology_id)
    if topo is None or topo.owner_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Topology not found")
    return topo


@router.get("", response_model=list[TopologyRead])
async def list_topologies(
    user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)
):
    result = await session.exec(
        select(Topology).where(Topology.owner_id == user.id).order_by(Topology.updated_at.desc())
    )
    return result.all()


@router.post("", response_model=TopologyRead, status_code=201)
async def create_topology(
    body: TopologyWrite,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    topo = Topology(owner_id=user.id, name=body.name, data=body.data)
    session.add(topo)
    await session.commit()
    await session.refresh(topo)
    return topo


@router.get("/{topology_id}", response_model=TopologyRead)
async def get_topology(topo: Topology = Depends(get_owned_topology)):
    return topo


@router.put("/{topology_id}", response_model=TopologyRead)
async def update_topology(
    body: TopologyWrite,
    topo: Topology = Depends(get_owned_topology),
    session: AsyncSession = Depends(get_session),
):
    topo.name = body.name
    topo.data = body.data
    topo.updated_at = utcnow()
    session.add(topo)
    await session.commit()
    await session.refresh(topo)
    return topo


@router.delete("/{topology_id}", status_code=204)
async def delete_topology(
    topo: Topology = Depends(get_owned_topology), session: AsyncSession = Depends(get_session)
):
    await session.delete(topo)
    await session.commit()
    return Response(status_code=204)

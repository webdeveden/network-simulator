import os

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ.setdefault("SECRET_KEY", "test-secret-key-that-is-at-least-32-bytes")

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.database import get_session
from app.main import app

test_engine = create_async_engine(
    "sqlite+aiosqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)


async def _override_get_session():
    async with AsyncSession(test_engine, expire_on_commit=False) as session:
        yield session


app.dependency_overrides[get_session] = _override_get_session


@pytest_asyncio.fixture
async def client():
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)

    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="https://test") as ac:
            yield ac
    finally:
        async with test_engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.drop_all)


async def auth_headers(client: AsyncClient, username: str = "neo") -> dict[str, str]:
    r = await client.post("/api/auth/register", json={"username": username, "password": "matrix123"})
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}

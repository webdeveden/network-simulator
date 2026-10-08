from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import JSON, Column, UniqueConstraint
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True, unique=True, max_length=32)
    password_hash: str
    created_at: datetime = Field(default_factory=utcnow)


class Topology(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    owner_id: int = Field(foreign_key="user.id", index=True)
    name: str = Field(max_length=64)
    data: dict[str, Any] = Field(sa_column=Column(JSON, nullable=False))
    updated_at: datetime = Field(default_factory=utcnow)


class Progress(SQLModel, table=True):
    __table_args__ = (UniqueConstraint("user_id", "mission_id"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    mission_id: str = Field(max_length=64)
    stars: int
    best_time: int
    best_cost: int
    topology: dict[str, Any] = Field(sa_column=Column(JSON, nullable=False))
    completed_at: datetime = Field(default_factory=utcnow)

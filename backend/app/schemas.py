from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=6, max_length=128)


class UserRead(BaseModel):
    id: int
    username: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserRead


class TopologyWrite(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    data: dict[str, Any]


class TopologyRead(BaseModel):
    id: int
    name: str
    data: dict[str, Any]
    updated_at: datetime


class CompletionWrite(BaseModel):
    stars: int = Field(ge=1, le=3)
    time: int = Field(ge=0)
    cost: int = Field(ge=0)
    topology: dict[str, Any]


class ProgressRead(BaseModel):
    mission_id: str
    stars: int
    best_time: int
    best_cost: int

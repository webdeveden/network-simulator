from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.database import get_session
from app.models import User
from app.schemas import Credentials, TokenResponse, UserRead
from app.security import create_token, get_current_user, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _token_response(user: User) -> TokenResponse:
    return TokenResponse(
        access_token=create_token(user.id),
        user=UserRead(id=user.id, username=user.username),
    )


@router.post("/register", response_model=TokenResponse, status_code=201)
async def register(body: Credentials, session: AsyncSession = Depends(get_session)):
    existing = (await session.exec(select(User).where(User.username == body.username))).first()
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "Username already taken")
    user = User(username=body.username, password_hash=hash_password(body.password))
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return _token_response(user)


@router.post("/login", response_model=TokenResponse)
async def login(body: Credentials, session: AsyncSession = Depends(get_session)):
    user = (await session.exec(select(User).where(User.username == body.username))).first()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid username or password")
    return _token_response(user)


@router.get("/me", response_model=UserRead)
async def me(user: User = Depends(get_current_user)):
    return UserRead(id=user.id, username=user.username)

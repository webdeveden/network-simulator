from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Real env vars win over files. Locally (cwd backend/) the repo-root .env is read too;
    # in a container neither file exists and the platform injects the variables.
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")

    DATABASE_URL: str = "sqlite+aiosqlite:///./netsim.db"
    ALLOWED_ORIGINS: str = "http://localhost:5173,http://localhost:8080"

    # Required: signs login tokens. No default, so a missing key stops startup
    # instead of silently using a known one. HS256 wants at least 32 bytes.
    # Read from NETSIM_SECRET_KEY so another project's SECRET_KEY in the shell can't leak in.
    SECRET_KEY: str = Field(min_length=32, validation_alias="NETSIM_SECRET_KEY")
    TOKEN_TTL_DAYS: int = 7
    # Counts failed logins. Unset means no rate limiting (e.g. plain `uv run uvicorn` without Redis).
    REDIS_URL: str | None = None


settings = Settings()

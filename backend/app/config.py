from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str = "sqlite+aiosqlite:///./netsim.db"
    ALLOWED_ORIGINS: str = "http://localhost:5173,http://localhost:8080"

    SECRET_KEY: str = "change-me-in-.env"
    TOKEN_TTL_DAYS: int = 7


settings = Settings()

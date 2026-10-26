FROM python:3.12-slim

# uv binary from its official image, pinned to the version used locally
COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /uvx /bin/

WORKDIR /app

# Compile .pyc at install time (faster startup); copy files since the uv cache is a separate mount
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

# Dependencies first, so this layer is cached until pyproject.toml / uv.lock change.
# --frozen: fail if the lockfile is out of date; --no-dev: skip pytest & co.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

COPY . .

# Put the venv's alembic/uvicorn on PATH (docker-compose calls both)
ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

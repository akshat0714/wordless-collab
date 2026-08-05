FROM python:3.12-slim-trixie AS builder

COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
WORKDIR /srv/app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY wordless ./wordless
RUN uv sync --frozen --no-dev

FROM python:3.12-slim-trixie AS runtime

ENV PATH="/srv/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/srv/wordless \
    XDG_CACHE_HOME=/srv/wordless/cache \
    HF_HOME=/srv/wordless/cache/huggingface \
    HF_HUB_DISABLE_XET=1 \
    WORDLESS_REALTIME_DEV_MODE=false \
    WORDLESS_REALTIME_WORKSPACE=/srv/wordless \
    WORDLESS_REALTIME_DATABASE_PATH=realtime.sqlite3 \
    WORDLESS_REALTIME_MODEL_CACHE_DIR=cache/embeddings

RUN addgroup --system --gid 10001 wordless \
    && adduser --system --uid 10001 --ingroup wordless --home /nonexistent --no-create-home wordless \
    && mkdir -p /srv/wordless/cache/embeddings /srv/wordless/cache/huggingface \
    && chown -R wordless:wordless /srv/wordless

WORKDIR /srv/app
COPY --from=builder --chown=wordless:wordless /srv/app/.venv ./.venv
COPY --from=builder --chown=wordless:wordless /srv/app/wordless ./wordless

USER wordless
EXPOSE 8001
VOLUME ["/srv/wordless"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/health/ready', timeout=3).read()"]

CMD ["uvicorn", "--factory", "wordless.api.product_asgi:create_app", "--host", "0.0.0.0", "--port", "8001", "--no-access-log"]

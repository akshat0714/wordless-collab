"""Environment-driven ASGI factory for the controlled real-time pilot.

Run behind a private TLS-terminating gateway with::

    uvicorn --factory wordless.api.product_asgi:create_app

Unlike the local launcher, this factory does not enable development mode or
provision demo credentials. :class:`~wordless.realtime.config.ProductSettings`
therefore applies every production-mode startup check to the process
environment before the application begins serving requests.
"""

from __future__ import annotations

from collections.abc import Mapping

from fastapi import FastAPI

from wordless.api.product import create_product_app
from wordless.realtime.config import ProductSettings


def create_app(environ: Mapping[str, str] | None = None) -> FastAPI:
    """Build the production-mode pilot from explicit environment settings."""

    settings = ProductSettings.from_env(environ)
    if settings.dev_mode:
        raise ValueError(
            "the production ASGI factory requires WORDLESS_REALTIME_DEV_MODE=false"
        )
    return create_product_app(settings=settings, environ=environ)


__all__ = ["create_app"]

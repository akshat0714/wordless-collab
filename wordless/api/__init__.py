"""Local, read-only HTTP surface for Wordless Audit."""

from .main import app, create_app

__all__ = ["app", "create_app"]

#!/usr/bin/env python3
"""Run the loopback-only Wordless real-time pilot API."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Sequence

import uvicorn

from wordless.api.product import create_product_app
from wordless.realtime.auth import DEV_API_KEY, DEV_SIGNING_SECRET
from wordless.realtime.config import ProductSettings


_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _port(value: str) -> int:
    port = int(value)
    if not 1 <= port <= 65_535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run the single-process Wordless real-time pilot in local development "
            "mode. This launcher intentionally accepts loopback hosts only."
        )
    )
    parser.add_argument("--host", default="127.0.0.1", help="loopback host (default: %(default)s)")
    parser.add_argument(
        "--port",
        default=8001,
        type=_port,
        help="listen port (default: %(default)s)",
    )
    parser.add_argument(
        "--database",
        type=Path,
        help="SQLite path inside the workspace (default: .wordless/realtime.sqlite3)",
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="require the pinned embedding model to be present in the local cache",
    )
    parser.add_argument(
        "--log-level",
        choices=("critical", "error", "warning", "info", "debug", "trace"),
        default="info",
    )
    parser.add_argument(
        "--hide-local-credentials",
        action="store_true",
        help="do not print the built-in local-only demo credentials",
    )
    return parser


def _development_environment(args: argparse.Namespace) -> dict[str, str]:
    values = dict(os.environ)
    values["WORDLESS_REALTIME_DEV_MODE"] = "true"
    # The launcher advertises the built-in demo key, so do not accidentally
    # inherit a production tenant registry from the invoking shell.
    values.pop("WORDLESS_REALTIME_TENANTS_JSON", None)
    values.pop("WORDLESS_REALTIME_API_KEY_PEPPER", None)
    values.setdefault("WORDLESS_REALTIME_WORKSPACE", str(Path.cwd()))
    if args.database is not None:
        values["WORDLESS_REALTIME_DATABASE_PATH"] = str(args.database)
    if args.offline:
        values["WORDLESS_REALTIME_OFFLINE"] = "true"
    return values


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.host not in _LOOPBACK_HOSTS:
        parser.error("the local development launcher accepts loopback hosts only")

    environ = _development_environment(args)
    settings = ProductSettings.from_env(environ)
    app = create_product_app(settings=settings, environ=environ)

    print(f"Wordless real-time pilot: http://{args.host}:{args.port}")
    print(f"Interactive API contract: http://{args.host}:{args.port}/docs")
    print("Mode: local development, loopback only, single process, SQLite")
    if not args.hide_local_credentials:
        print(f"Local-only bearer key: {DEV_API_KEY}")
        print(f"Local-only signing secret: {DEV_SIGNING_SECRET}")
        print("These built-in credentials are public development fixtures; never reuse them.")

    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

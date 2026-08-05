#!/usr/bin/env python3
"""Run non-destructive checks against a deployed Zendesk Sandbox pilot.

The webhook credential is read from its generated secret file. It is never
accepted on argv and no request headers, secret values, or response bodies are
printed.
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
from pathlib import Path
import re
import ssl
import stat
import sys
from typing import Any


DOMAIN_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
INSTALLATION_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
MAX_LOCAL_FILE_BYTES = 1_048_576
MAX_RESPONSE_BYTES = 4_096


class SmokeError(RuntimeError):
    """A sanitized failure that is safe to show to an operator."""


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description=(
            "Run credential-safe health and authentication checks against the "
            "configured public Zendesk Sandbox endpoint."
        ),
        allow_abbrev=False,
    )
    result.add_argument(
        "--confirm-sandbox",
        action="store_true",
        help="Confirm that the configured endpoint is a Zendesk Sandbox pilot",
    )
    result.add_argument(
        "--deployment-dir",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="Deployment directory (default: the directory containing this script)",
    )
    result.add_argument(
        "--timeout-seconds",
        type=float,
        default=10.0,
        help="Per-request timeout between 1 and 30 seconds (default: 10)",
    )
    return result


def secure_read(path: Path, *, maximum_bytes: int = MAX_LOCAL_FILE_BYTES) -> str:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise SmokeError(f"cannot safely read required file: {path.name}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise SmokeError(f"required path is not a regular file: {path.name}")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise SmokeError(f"required file has group/other permissions: {path.name}")
        if metadata.st_size > maximum_bytes:
            raise SmokeError(f"required file is too large: {path.name}")
        chunks: list[bytes] = []
        remaining = maximum_bytes + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(65_536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) > maximum_bytes:
            raise SmokeError(f"required file is too large: {path.name}")
        try:
            return raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise SmokeError(f"required file is not UTF-8: {path.name}") from error
    finally:
        os.close(descriptor)


def check_secrets_directory(path: Path) -> None:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise SmokeError("secrets directory is missing") from error
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        raise SmokeError("secrets path must be a real directory")
    if stat.S_IMODE(metadata.st_mode) & 0o077:
        raise SmokeError("secrets directory has group/other permissions")


def parse_environment(value: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in value.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in line:
            raise SmokeError(".env.production contains an invalid line")
        key, setting = line.split("=", 1)
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in result:
            raise SmokeError(".env.production contains an invalid or duplicate key")
        result[key] = setting
    return result


def valid_public_domain(value: str) -> bool:
    return (
        value == value.lower()
        and len(value) <= 253
        and "." in value
        and all(DOMAIN_LABEL.fullmatch(label) is not None for label in value.split("."))
    )


def configured_installation(value: str) -> str:
    try:
        decoded: Any = json.loads(value)
    except json.JSONDecodeError as error:
        raise SmokeError("installations.json is not valid JSON") from error
    if not isinstance(decoded, list) or len(decoded) != 1 or not isinstance(decoded[0], dict):
        raise SmokeError("installations.json must contain exactly one pilot installation")
    installation = decoded[0]
    identifier = installation.get("id")
    authentication = installation.get("webhookAuth")
    if (
        not isinstance(identifier, str)
        or INSTALLATION_PATTERN.fullmatch(identifier) is None
        or not isinstance(authentication, dict)
        or authentication.get("mode") != "x_api_key"
        or authentication.get("secretRef") != "ZENDESK_WEBHOOK_SECRET"
    ):
        raise SmokeError("installation webhook authentication is not the expected X-API-Key configuration")
    return identifier


def webhook_secret(value: str) -> str:
    if value.endswith("\r\n"):
        value = value[:-2]
    elif value.endswith("\n"):
        value = value[:-1]
    if len(value.encode("utf-8")) < 32 or "\r" in value or "\n" in value:
        raise SmokeError("webhook secret file is invalid")
    return value


def request(
    domain: str,
    timeout: float,
    method: str,
    path: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
) -> tuple[int, bytes]:
    connection = http.client.HTTPSConnection(
        domain,
        443,
        timeout=timeout,
        context=ssl.create_default_context(),
    )
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read(MAX_RESPONSE_BYTES + 1)
        if len(payload) > MAX_RESPONSE_BYTES:
            raise SmokeError("public endpoint returned an oversized response")
        return response.status, payload
    except SmokeError:
        raise
    except (OSError, ssl.SSLError, http.client.HTTPException) as error:
        raise SmokeError(
            f"public endpoint request failed ({type(error).__name__})"
        ) from error
    finally:
        connection.close()


def require_status(label: str, actual: int, expected: int) -> None:
    if actual != expected:
        raise SmokeError(f"{label} returned HTTP {actual}; expected {expected}")
    print(f"PASS: {label}")


def require_health(label: str, status: int, payload: bytes, expected: str) -> None:
    require_status(label, status, 200)
    try:
        decoded = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SmokeError(f"{label} returned an invalid JSON body") from error
    if not isinstance(decoded, dict) or decoded.get("status") != expected:
        raise SmokeError(f"{label} returned an unexpected health state")


def main(argv: list[str] | None = None) -> int:
    arguments = parser().parse_args(argv)
    if not arguments.confirm_sandbox:
        raise SmokeError("refusing to run without --confirm-sandbox")
    if not 1 <= arguments.timeout_seconds <= 30:
        raise SmokeError("timeout must be between 1 and 30 seconds")

    deployment_dir = arguments.deployment_dir.expanduser().resolve()
    if not deployment_dir.is_dir():
        raise SmokeError("deployment directory does not exist")
    secrets_dir = deployment_dir / "secrets"
    check_secrets_directory(secrets_dir)
    environment = parse_environment(secure_read(deployment_dir / ".env.production"))
    domain = environment.get("PUBLIC_DOMAIN", "")
    if not valid_public_domain(domain):
        raise SmokeError("PUBLIC_DOMAIN is missing or invalid")
    installation_id = configured_installation(
        secure_read(secrets_dir / "installations.json")
    )
    secret = webhook_secret(secure_read(secrets_dir / "zendesk_webhook_secret"))
    webhook_path = f"/v1/webhooks/zendesk/{installation_id}"

    status, payload = request(domain, arguments.timeout_seconds, "GET", "/health/live")
    require_health("public liveness", status, payload, "ok")
    status, payload = request(domain, arguments.timeout_seconds, "GET", "/health/ready")
    require_health("public readiness", status, payload, "ready")

    status, _ = request(domain, arguments.timeout_seconds, "HEAD", webhook_path)
    require_status("missing webhook credential fails closed", status, 404)
    status, _ = request(
        domain,
        arguments.timeout_seconds,
        "HEAD",
        webhook_path,
        headers={"X-API-Key": "wordless-invalid-smoke-credential-000000000000"},
    )
    require_status("wrong webhook credential fails closed", status, 404)
    status, _ = request(
        domain,
        arguments.timeout_seconds,
        "HEAD",
        webhook_path,
        headers={"X-API-Key": secret},
    )
    require_status("configured webhook credential authenticates", status, 204)
    status, _ = request(
        domain,
        arguments.timeout_seconds,
        "POST",
        webhook_path,
        headers={"Content-Type": "application/json", "X-API-Key": secret},
        body=b"{",
    )
    require_status("authenticated malformed event is rejected without enqueue", status, 400)

    print("Sandbox smoke checks passed; no customer event was accepted.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (SmokeError, KeyboardInterrupt) as error:
        print(f"smoke failed: {error}", file=sys.stderr)
        raise SystemExit(1) from None

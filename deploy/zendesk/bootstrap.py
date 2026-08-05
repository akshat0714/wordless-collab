#!/usr/bin/env python3
"""Create a dedicated Zendesk pilot configuration without putting secrets on argv."""

from __future__ import annotations

import argparse
from getpass import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sys
from urllib.parse import quote, urlsplit


ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
INSTALLATION_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
SUBDOMAIN_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
DOMAIN_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
THRESHOLD_VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$")
PLACEHOLDER_THRESHOLD_VERSIONS = {
    "changeme",
    "default",
    "demo",
    "demo-floor-v1",
    "demo-v1",
    "pilot-v1",
    "placeholder",
    "replace-me",
    "test",
    "test-v1",
    "unset",
}
MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2"
MODEL_REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"


class BootstrapError(ValueError):
    """Safe configuration error with no secret value in its text."""


def identifier(value: str, label: str) -> str:
    if ID_PATTERN.fullmatch(value) is None:
        raise argparse.ArgumentTypeError(f"{label} is invalid")
    return value


def installation_id(value: str) -> str:
    if INSTALLATION_PATTERN.fullmatch(value) is None:
        raise argparse.ArgumentTypeError(
            "installation id must use lowercase letters, numbers, _ or -"
        )
    return value


def zendesk_subdomain(value: str) -> str:
    if SUBDOMAIN_PATTERN.fullmatch(value) is None:
        raise argparse.ArgumentTypeError("Zendesk subdomain is invalid")
    return value


def public_domain(value: str) -> str:
    if (
        value != value.lower()
        or len(value) > 253
        or "." not in value
        or any(DOMAIN_LABEL.fullmatch(label) is None for label in value.split("."))
    ):
        raise argparse.ArgumentTypeError(
            "public domain must be a lowercase fully-qualified DNS name"
        )
    return value


def evidence_resolver_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        any(character.isspace() for character in value)
        or
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise argparse.ArgumentTypeError(
            "evidence resolver URL must be HTTPS with no credentials, query, or fragment"
        )
    return value


def threshold(value: str) -> str:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("threshold must be a number") from exc
    if not 0 < parsed <= 3:
        raise argparse.ArgumentTypeError("threshold must be greater than 0 and at most 3")
    return value


def threshold_version(value: str) -> str:
    if (
        THRESHOLD_VERSION_PATTERN.fullmatch(value) is None
        or value.casefold() in PLACEHOLDER_THRESHOLD_VERSIONS
    ):
        raise argparse.ArgumentTypeError(
            "threshold version must be a non-placeholder evaluation identifier"
        )
    return value


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description=(
            "Generate a fail-closed dedicated Zendesk pilot configuration. "
            "Credentials are prompted with getpass and are never accepted as flags."
        ),
        allow_abbrev=False,
    )
    result.add_argument("--public-domain", required=True, type=public_domain)
    result.add_argument("--installation-id", required=True, type=installation_id)
    result.add_argument("--zendesk-subdomain", required=True, type=zendesk_subdomain)
    result.add_argument(
        "--zendesk-app-id",
        required=True,
        type=lambda value: identifier(value, "Zendesk app id"),
    )
    result.add_argument(
        "--zendesk-webhook-id",
        required=True,
        type=lambda value: identifier(value, "Zendesk webhook id"),
    )
    result.add_argument(
        "--zendesk-switchboard-integration-id",
        required=True,
        type=lambda value: identifier(value, "Zendesk Switchboard integration id"),
    )
    result.add_argument(
        "--zendesk-underlying-integration-id",
        required=True,
        type=lambda value: identifier(value, "Zendesk underlying integration id"),
    )
    result.add_argument(
        "--zendesk-human-switchboard-integration-id",
        required=True,
        type=lambda value: identifier(
            value, "Zendesk Agent Workspace Switchboard integration id"
        ),
    )
    result.add_argument(
        "--evidence-resolver-url",
        required=True,
        type=evidence_resolver_url,
    )
    result.add_argument("--threshold", required=True, type=threshold)
    result.add_argument("--threshold-version", required=True, type=threshold_version)
    result.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="Existing output directory (default: the directory containing this script)",
    )
    return result


def prompt_secret(label: str, *, minimum: int = 1, maximum: int = 65_536) -> str:
    value = getpass(f"{label}: ")
    if len(value) < minimum or len(value) > maximum or "\n" in value or "\r" in value:
        raise BootstrapError(f"{label} is invalid")
    return value


def random_secret() -> str:
    return secrets.token_urlsafe(32)


def derived_tenant_id(value: str) -> str:
    candidate = f"zd_{value}"
    if len(candidate) <= 63:
        return candidate
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]
    return f"{candidate[:54]}_{digest}"


def derived_key_id(value: str) -> str:
    compact = re.sub(r"[^A-Za-z0-9_-]", "_", value)
    candidate = f"zd_{compact}"
    if len(candidate) <= 32:
        return candidate
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]
    return f"{candidate[:23]}_{digest}"


def exclusive_write(path: Path, value: str) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        try:
            path.unlink()
        except OSError:
            pass
        raise
    os.chmod(path, 0o600, follow_symlinks=False)


def main(argv: list[str] | None = None) -> int:
    arguments = parser().parse_args(argv)
    if (
        arguments.zendesk_human_switchboard_integration_id
        == arguments.zendesk_switchboard_integration_id
    ):
        raise BootstrapError(
            "Zendesk Agent Workspace and Wordless Switchboard entry ids must differ"
        )
    output_dir = arguments.output_dir.expanduser().resolve()
    if not output_dir.is_dir():
        raise BootstrapError("output directory must already exist")
    environment_path = output_dir / ".env.production"
    secrets_dir = output_dir / "secrets"
    if environment_path.exists() or secrets_dir.exists():
        raise BootstrapError(
            "refusing to overwrite .env.production or secrets/; use a new empty directory"
        )
    if not sys.stdin.isatty():
        raise BootstrapError("an interactive TTY is required for hidden credential prompts")

    zendesk_key_id = prompt_secret("Zendesk integration-scoped key ID")
    zendesk_key_secret = prompt_secret(
        "Zendesk integration-scoped key secret", minimum=16
    )
    zendesk_webhook_secret = prompt_secret(
        "Zendesk webhook X-API-Key secret", minimum=32
    )

    postgres_password = random_secret()
    wordless_api_secret = random_secret()
    wordless_signing_secret = random_secret()
    wordless_customer_hmac_key = random_secret()
    wordless_api_key_pepper = random_secret()
    choice_signing_secret = random_secret()
    evidence_resolver_shared_secret = random_secret()
    tenant_id = derived_tenant_id(arguments.installation_id)
    key_id = derived_key_id(arguments.installation_id)
    wordless_api_key = f"wl_live_{key_id}.{wordless_api_secret}"

    tenants = {
        tenant_id: {
            "api_keys": [
                {
                    "id": key_id,
                    "secret": wordless_api_secret,
                    "scopes": [
                        "suggestions:read",
                        "suggestions:write",
                        "feedback:write",
                    ],
                }
            ],
            "customer_hmac_key": wordless_customer_hmac_key,
            "signing_secrets": [wordless_signing_secret],
        }
    }
    installation = [
        {
            "id": arguments.installation_id,
            "appId": arguments.zendesk_app_id,
            "webhookId": arguments.zendesk_webhook_id,
            "switchboardIntegrationId": arguments.zendesk_switchboard_integration_id,
            "underlyingIntegrationId": arguments.zendesk_underlying_integration_id,
            "humanSwitchboardIntegrationId": (
                arguments.zendesk_human_switchboard_integration_id
            ),
            "zendeskSubdomain": arguments.zendesk_subdomain,
            "webhookAuth": {
                "mode": "x_api_key",
                "secretRef": "ZENDESK_WEBHOOK_SECRET",
            },
            "choiceSigningSecretRef": "CHOICE_SIGNING_SECRET",
            "wordlessApiKeyRef": "WORDLESS_API_KEY",
            "wordlessSigningSecretRef": "WORDLESS_SIGNING_SECRET",
            "zendeskAuthentication": {
                "type": "basic",
                "scope": "integration",
                "keyIdRef": "ZENDESK_KEY_ID",
                "keySecretRef": "ZENDESK_KEY_SECRET",
            },
        }
    ]
    database_url = (
        "postgresql://wordless_gateway:"
        f"{quote(postgres_password, safe='')}@postgres:5432/wordless_gateway"
    )
    environment = "\n".join(
        [
            "# Non-secret deployment settings generated by bootstrap.py.",
            "COMPOSE_PROJECT_NAME=wordless-zendesk",
            f"PUBLIC_DOMAIN={arguments.public_domain}",
            f"EVIDENCE_RESOLVER_URL={arguments.evidence_resolver_url}",
            f"WORDLESS_THRESHOLD={arguments.threshold}",
            f"WORDLESS_THRESHOLD_VERSION={arguments.threshold_version}",
            f"WORDLESS_EMBED_MODEL_ID={MODEL_ID}",
            f"WORDLESS_EMBED_MODEL_REVISION={MODEL_REVISION}",
            "WORDLESS_OFFLINE=false",
            "WORDLESS_RATE_LIMIT_PER_MINUTE=120",
            "WORDLESS_MAX_INFERENCE_CONCURRENCY=4",
            "SUPPORTED_LOCALE_PREFIXES=en",
            "REQUIRE_KNOWN_LOCALE=true",
            "CHOICE_TTL_HOURS=1",
            "RETENTION_DAYS=30",
            "CADDY_IMAGE=caddy:2.11.4-alpine",
            "POSTGRES_IMAGE=postgres:17.10-alpine3.23",
            "ZENDESK_GATEWAY_IMAGE=wordless-zendesk-gateway:pilot",
            "WORDLESS_API_IMAGE=wordless-api:pilot",
            "",
        ]
    )

    os.umask(0o077)
    secrets_dir.mkdir(mode=0o700)
    os.chmod(secrets_dir, 0o700, follow_symlinks=False)
    secret_files = {
        "postgres_password": postgres_password,
        "database_url": database_url,
        "installations.json": json.dumps(
            installation, ensure_ascii=True, indent=2, sort_keys=True
        )
        + "\n",
        "evidence_resolver_shared_secret": evidence_resolver_shared_secret,
        "zendesk_webhook_secret": zendesk_webhook_secret,
        "zendesk_key_id": zendesk_key_id,
        "zendesk_key_secret": zendesk_key_secret,
        "choice_signing_secret": choice_signing_secret,
        "wordless_api_key": wordless_api_key,
        "wordless_signing_secret": wordless_signing_secret,
        "wordless_tenants.json": json.dumps(
            tenants, ensure_ascii=True, indent=2, sort_keys=True
        )
        + "\n",
        "wordless_api_key_pepper": wordless_api_key_pepper,
    }
    for name, value in secret_files.items():
        exclusive_write(secrets_dir / name, value)
    exclusive_write(environment_path, environment)

    webhook_url = (
        f"https://{arguments.public_domain}/v1/webhooks/zendesk/"
        f"{arguments.installation_id}"
    )
    print(f"Created {environment_path}")
    print(f"Created {secrets_dir} with mode 0700 and files with mode 0600")
    print(f"Zendesk webhook URL: {webhook_url}")
    print(
        "Share secrets/evidence_resolver_shared_secret with the resolver operator "
        "through the company's approved secret channel."
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BootstrapError, EOFError, KeyboardInterrupt, OSError) as error:
        print(f"bootstrap failed: {error}", file=sys.stderr)
        raise SystemExit(1) from None

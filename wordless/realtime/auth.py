"""Tenant authentication and exact-body request signature verification."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from .config import ProductSettings


DEV_API_KEY = "wl_live_demo.local_only_wordless_key_2026_07_25"
DEV_CUSTOMER_HMAC_KEY = "local-only-customer-hmac-key-2026-07-25"
DEV_SIGNING_SECRET = "local-only-signing-secret-2026-07-25"
DEV_API_KEY_PEPPER = "local-only-api-key-pepper-2026-07-25"
ALL_SCOPES = frozenset({"suggestions:read", "suggestions:write", "feedback:write"})
_TENANT_ID = re.compile(r"^[a-z][a-z0-9_-]{1,62}$")
_KEY_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$")
_API_KEY = re.compile(
    r"^wl_live_(?P<key_id>[A-Za-z0-9][A-Za-z0-9_-]{1,31})\.(?P<secret>[A-Za-z0-9_-]{24,128})$"
)


class AuthenticationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message


class _KeyInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$")
    secret: SecretStr = Field(min_length=24, max_length=128)
    scopes: tuple[
        Literal["suggestions:read", "suggestions:write", "feedback:write"], ...
    ] = (
        "suggestions:read",
        "suggestions:write",
        "feedback:write",
    )
    expires_at: datetime | None = None
    revoked: bool = False

    @field_validator("scopes")
    @classmethod
    def validate_scopes(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if not value or len(value) != len(set(value)):
            raise ValueError("API key scopes must be non-empty and unique")
        return value

    @field_validator("secret")
    @classmethod
    def validate_secret(cls, value: SecretStr) -> SecretStr:
        if re.fullmatch(r"[A-Za-z0-9_-]{24,128}", value.get_secret_value()) is None:
            raise ValueError("API key secrets must use URL-safe opaque characters")
        return value

    @field_validator("expires_at")
    @classmethod
    def validate_expiry(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("configured API key expiry must include a timezone")
        return value


class _TenantInput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    api_keys: tuple[_KeyInput, ...] = Field(min_length=1, max_length=4)
    customer_hmac_key: SecretStr = Field(min_length=32, max_length=256)
    signing_secrets: tuple[SecretStr, ...] = Field(min_length=1, max_length=2)

    @field_validator("signing_secrets")
    @classmethod
    def validate_signing_secrets(
        cls,
        values: tuple[SecretStr, ...],
    ) -> tuple[SecretStr, ...]:
        raw = tuple(value.get_secret_value() for value in values)
        if any(len(value) < 32 or len(value) > 256 for value in raw):
            raise ValueError("signing secrets must contain 32–256 characters")
        if len(raw) != len(set(raw)):
            raise ValueError("signing secrets must be unique")
        return values


@dataclass(frozen=True, repr=False)
class TenantPrincipal:
    tenant_id: str
    key_id: str
    scopes: frozenset[str]
    customer_hmac_key: bytes
    signing_secrets: tuple[bytes, ...]

    def require_scope(self, scope: str) -> None:
        if scope not in self.scopes:
            raise AuthenticationError(
                "insufficient_scope",
                "The API key does not have the required scope.",
            )


@dataclass(frozen=True, repr=False)
class _Credential:
    key_id: str
    digest: bytes
    principal: TenantPrincipal
    expires_at: datetime | None
    revoked: bool


def _reject_duplicate_keys(items: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in items:
        if key in value:
            raise ValueError(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def _key_digest(pepper: bytes, value: str) -> bytes:
    return hmac.new(pepper, value.encode("utf-8"), hashlib.sha256).digest()


def _configuration_secret(
    values: Mapping[str, str],
    *,
    value_name: str,
    file_name: str,
    maximum_bytes: int,
) -> str | None:
    """Read one bounded secret from an env value or an absolute mounted file."""

    direct = values.get(value_name)
    file_value = values.get(file_name)
    if direct is not None and file_value is not None:
        raise ValueError(f"configure only one of {value_name} or {file_name}")
    if file_value is None:
        return direct
    path = Path(file_value)
    if not path.is_absolute():
        raise ValueError(f"{file_name} must be an absolute path")
    try:
        payload = path.read_bytes()
    except OSError as exc:
        raise ValueError(f"{file_name} could not be read") from exc
    if not payload or len(payload) > maximum_bytes or b"\0" in payload:
        raise ValueError(f"{file_name} contains an invalid secret")
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(f"{file_name} must contain UTF-8 text") from exc
    # Docker/Kubernetes secret files commonly contain one editor-added newline.
    if text.endswith("\n"):
        text = text[:-1]
        if text.endswith("\r"):
            text = text[:-1]
    return text


class TenantRegistry:
    def __init__(self, *, credentials: tuple[_Credential, ...], pepper: bytes) -> None:
        if not credentials:
            raise ValueError("at least one tenant API key is required")
        self._credentials = credentials
        self._pepper = pepper
        self._dummy_digest = _key_digest(pepper, "invalid-api-key")

    @classmethod
    def from_env(
        cls,
        settings: ProductSettings,
        environ: Mapping[str, str] | None = None,
    ) -> "TenantRegistry":
        values = os.environ if environ is None else environ
        tenants_json = _configuration_secret(
            values,
            value_name="WORDLESS_REALTIME_TENANTS_JSON",
            file_name="WORDLESS_REALTIME_TENANTS_JSON_FILE",
            maximum_bytes=1_048_576,
        )
        pepper_text = _configuration_secret(
            values,
            value_name="WORDLESS_REALTIME_API_KEY_PEPPER",
            file_name="WORDLESS_REALTIME_API_KEY_PEPPER_FILE",
            maximum_bytes=4_096,
        )
        if settings.dev_mode and tenants_json is None:
            tenants_json = json.dumps(
                {
                    "demo": {
                        "api_keys": [
                            {
                                "id": "demo",
                                "secret": DEV_API_KEY.split(".", 1)[1],
                                "scopes": sorted(ALL_SCOPES),
                            }
                        ],
                        "customer_hmac_key": DEV_CUSTOMER_HMAC_KEY,
                        "signing_secrets": [DEV_SIGNING_SECRET],
                    }
                }
            )
            pepper_text = pepper_text or DEV_API_KEY_PEPPER
        if tenants_json is None or pepper_text is None:
            raise ValueError(
                "production mode requires WORDLESS_REALTIME_TENANTS_JSON and "
                "WORDLESS_REALTIME_API_KEY_PEPPER"
            )
        if len(pepper_text) < 32:
            raise ValueError("API key pepper must contain at least 32 characters")
        try:
            raw = json.loads(tenants_json, object_pairs_hook=_reject_duplicate_keys)
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
            raise ValueError("WORDLESS_REALTIME_TENANTS_JSON is invalid") from exc
        if not isinstance(raw, dict) or not raw:
            raise ValueError("WORDLESS_REALTIME_TENANTS_JSON must be a non-empty object")
        pepper = pepper_text.encode("utf-8")
        credentials: list[_Credential] = []
        seen_key_ids: set[str] = set()
        for tenant_id, raw_config in sorted(raw.items()):
            if not isinstance(tenant_id, str) or _TENANT_ID.fullmatch(tenant_id) is None:
                raise ValueError("tenant IDs must use lowercase letters, numbers, _ or -")
            # JSON-aware strict validation accepts JSON arrays for immutable
            # tuple fields while still rejecting coercions such as string
            # booleans. ``model_validate(..., strict=True)`` rejects every
            # valid JSON tenant document because arrays materialize as lists.
            config = _TenantInput.model_validate_json(
                json.dumps(
                    raw_config,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                ),
                strict=True,
            )
            for key in config.api_keys:
                if key.id in seen_key_ids:
                    raise ValueError("API key IDs must be globally unique")
                seen_key_ids.add(key.id)
                full_key = f"wl_live_{key.id}.{key.secret.get_secret_value()}"
                principal = TenantPrincipal(
                    tenant_id=tenant_id,
                    key_id=key.id,
                    scopes=frozenset(key.scopes),
                    customer_hmac_key=config.customer_hmac_key.get_secret_value().encode(
                        "utf-8"
                    ),
                    signing_secrets=tuple(
                        value.get_secret_value().encode("utf-8")
                        for value in config.signing_secrets
                    ),
                )
                credentials.append(
                    _Credential(
                        key_id=key.id,
                        digest=_key_digest(pepper, full_key),
                        principal=principal,
                        expires_at=key.expires_at,
                        revoked=key.revoked,
                    )
                )
        return cls(credentials=tuple(credentials), pepper=pepper)

    def authenticate(
        self,
        authorization: str | None,
        *,
        now: datetime | None = None,
    ) -> TenantPrincipal:
        if authorization is None or not authorization.startswith("Bearer "):
            raise AuthenticationError(
                "missing_api_key",
                "A Bearer API key is required.",
            )
        value = authorization.removeprefix("Bearer ")
        match = _API_KEY.fullmatch(value)
        presented = _key_digest(self._pepper, value)
        current = now or datetime.now(timezone.utc)
        selected: _Credential | None = None
        for credential in self._credentials:
            same_id = match is not None and credential.key_id == match.group("key_id")
            candidate = credential.digest if same_id else self._dummy_digest
            if hmac.compare_digest(candidate, presented) and same_id:
                selected = credential
        if selected is None or selected.revoked:
            raise AuthenticationError("invalid_api_key", "The API key is invalid.")
        if selected.expires_at is not None:
            expires_at = selected.expires_at
            if expires_at.tzinfo is None or expires_at.utcoffset() is None:
                raise ValueError("configured API key expiry must include a timezone")
            if expires_at <= current:
                raise AuthenticationError("expired_api_key", "The API key has expired.")
        return selected.principal


def verify_request_signature(
    principal: TenantPrincipal,
    body: bytes,
    *,
    timestamp_header: str | None,
    signature_header: str | None,
    method: str,
    path: str,
    idempotency_key: str,
    tolerance_seconds: int,
    now_seconds: int | None = None,
) -> None:
    if timestamp_header is None or signature_header is None:
        raise AuthenticationError(
            "missing_signature",
            "Signed requests require timestamp and signature headers.",
        )
    if re.fullmatch(r"[0-9]{1,20}", timestamp_header) is None:
        raise AuthenticationError(
            "invalid_signature",
            "The request signature is invalid.",
        )
    timestamp = int(timestamp_header)
    current = int(time.time()) if now_seconds is None else now_seconds
    if abs(current - timestamp) > tolerance_seconds:
        raise AuthenticationError(
            "stale_signature",
            "The request signature timestamp is outside the allowed window.",
        )
    if not signature_header.startswith("v1="):
        raise AuthenticationError("invalid_signature", "The request signature is invalid.")
    supplied = signature_header.removeprefix("v1=")
    if re.fullmatch(r"[0-9a-f]{64}", supplied) is None:
        raise AuthenticationError("invalid_signature", "The request signature is invalid.")
    try:
        signed = canonical_request_signature_bytes(
            timestamp=timestamp_header,
            method=method,
            path=path,
            idempotency_key=idempotency_key,
            body=body,
        )
    except (TypeError, UnicodeEncodeError, ValueError) as exc:
        raise AuthenticationError(
            "invalid_signature",
            "The request signature is invalid.",
        ) from exc
    valid = False
    for secret in principal.signing_secrets:
        expected = hmac.new(secret, signed, hashlib.sha256).hexdigest()
        valid = hmac.compare_digest(expected, supplied) or valid
    if not valid:
        raise AuthenticationError("invalid_signature", "The request signature is invalid.")


def canonical_request_signature_bytes(
    *,
    timestamp: str,
    method: str,
    path: str,
    idempotency_key: str,
    body: bytes,
) -> bytes:
    """Return the unambiguous bytes signed by request-signature version 1.

    The wire format is exactly ``b"v1:" + timestamp_ascii + b"\\n" +
    uppercase_method_ascii + b"\\n" + exact_path_utf8 + b"\\n" +
    idempotency_key_utf8 + b"\\n" + exact_body``.  The body is last and may
    contain arbitrary bytes; every preceding field rejects line breaks.
    """

    if not isinstance(body, bytes):
        raise TypeError("body must be exact request bytes")
    if not all(
        isinstance(value, str)
        for value in (timestamp, method, path, idempotency_key)
    ):
        raise TypeError("signature fields must be strings")
    if re.fullmatch(r"[0-9]{1,20}", timestamp) is None:
        raise ValueError("timestamp must be an ASCII integer")
    normalized_method = method.upper()
    if re.fullmatch(r"[A-Z]+", normalized_method) is None:
        raise ValueError("method must be an HTTP token")
    if not path.startswith("/") or any(value in path for value in ("\r", "\n", "\0")):
        raise ValueError("path must be an absolute line-safe request path")
    if not idempotency_key or any(
        value in idempotency_key for value in ("\r", "\n", "\0")
    ):
        raise ValueError("idempotency key must be line-safe")
    return (
        b"v1:"
        + timestamp.encode("ascii")
        + b"\n"
        + normalized_method.encode("ascii")
        + b"\n"
        + path.encode("utf-8")
        + b"\n"
        + idempotency_key.encode("utf-8")
        + b"\n"
        + body
    )


__all__ = [
    "ALL_SCOPES",
    "AuthenticationError",
    "DEV_API_KEY",
    "DEV_SIGNING_SECRET",
    "TenantPrincipal",
    "TenantRegistry",
    "canonical_request_signature_bytes",
    "verify_request_signature",
]

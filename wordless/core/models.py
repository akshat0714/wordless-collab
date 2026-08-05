"""Canonical data contracts shared by every Wordless module.

Vendor-specific records stop at the ingest boundary.  Everything beyond that
boundary uses these models, so the two safety-critical corpus invariants live
here rather than being repeated (and eventually forgotten) by adapters.
"""

from __future__ import annotations

from datetime import datetime
import hashlib
import hmac
import re
from typing import Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


_CUSTOMER_KEY_RE = re.compile(r"hmac-sha256:(?P<digest>[0-9a-fA-F]{64})\Z")


def _validate_nonempty_identifier(value: str, *, field_name: str) -> str:
    if not value:
        raise ValueError(f"{field_name} must not be empty")
    if value != value.strip():
        raise ValueError(f"{field_name} must not have leading or trailing whitespace")
    return value


class _CanonicalModel(BaseModel):
    """Strict base configuration for data crossing module boundaries."""

    model_config = ConfigDict(
        extra="forbid",
        validate_assignment=True,
        revalidate_instances="always",
    )


class Message(_CanonicalModel):
    author: Literal["customer", "agent", "system"]
    sent_at: datetime
    text: str
    redacted: bool = False


class StateFact(_CanonicalModel):
    source: str
    kind: str
    occurred_at: datetime
    fields: dict[str, Any]
    provenance: Literal["exported", "reconstructed", "inferred"]

    @field_validator("source", "kind")
    @classmethod
    def validate_identifiers(cls, value: str, info: Any) -> str:
        return _validate_nonempty_identifier(value, field_name=info.field_name)


class Resolution(_CanonicalModel):
    resolved_at: datetime
    original_label: str | None
    actions: list[str]
    closing_text: str


class Interaction(_CanonicalModel):
    id: str
    customer_key: str
    opened_at: datetime
    channel: Literal["email", "chat", "phone", "form", "web"]
    messages: list[Message]
    state_snapshot: list[StateFact]
    resolution: Resolution | None
    source_system: str
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("id", "source_system")
    @classmethod
    def validate_identifiers(cls, value: str, info: Any) -> str:
        return _validate_nonempty_identifier(value, field_name=info.field_name)

    @field_validator("customer_key")
    @classmethod
    def validate_customer_key(cls, value: str) -> str:
        """Require the explicit per-corpus HMAC representation.

        The canonical boundary intentionally rejects bare and ordinary SHA-256
        digests.  :func:`hash_customer_key` is the sole supported constructor;
        its namespace makes an accidental unsalted digest fail closed.
        """

        match = _CUSTOMER_KEY_RE.fullmatch(value)
        if match is None:
            raise ValueError(
                "customer_key must be an hmac-sha256 salted digest; use "
                "hash_customer_key(raw_identifier, corpus_salt)"
            )
        return f"hmac-sha256:{match.group('digest').lower()}"

    @model_validator(mode="after")
    def reject_post_opening_state(self) -> Self:
        """Prevent future state from leaking into historical replay results."""

        for index, fact in enumerate(self.state_snapshot):
            try:
                leaked = fact.occurred_at > self.opened_at
            except TypeError as exc:
                raise ValueError(
                    "opened_at and state_snapshot timestamps must use consistent "
                    "timezone awareness"
                ) from exc
            if leaked:
                raise ValueError(
                    "state_snapshot contains temporal leakage: fact at index "
                    f"{index} occurred at {fact.occurred_at.isoformat()}, after "
                    f"interaction opened at {self.opened_at.isoformat()}"
                )
        return self


def hash_customer_key(
    raw_identifier: str | bytes,
    corpus_salt: str | bytes,
) -> str:
    """Return a non-reversible, corpus-scoped customer key.

    The salt is used as an HMAC key and is never attached to the returned value
    or to an :class:`Interaction`.  Callers should generate one high-entropy
    salt per corpus, retain it only for the duration of ingest, and then discard
    it separately from the normalized corpus.
    """

    if not isinstance(raw_identifier, (str, bytes)):
        raise TypeError("raw_identifier must be str or bytes")
    if not isinstance(corpus_salt, (str, bytes)):
        raise TypeError("corpus_salt must be str or bytes")
    raw = raw_identifier.encode("utf-8") if isinstance(raw_identifier, str) else raw_identifier
    salt = corpus_salt.encode("utf-8") if isinstance(corpus_salt, str) else corpus_salt
    if not raw:
        raise ValueError("raw_identifier must not be empty")
    if not salt:
        raise ValueError("corpus_salt must not be empty")
    digest = hmac.new(salt, raw, hashlib.sha256).hexdigest()
    return f"hmac-sha256:{digest}"


__all__ = [
    "Interaction",
    "Message",
    "Resolution",
    "StateFact",
    "hash_customer_key",
]

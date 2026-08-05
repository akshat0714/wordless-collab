"""Shared adapter boundary and canonical normalization helpers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterable, Iterator, Mapping, Sequence
from copy import deepcopy
from datetime import UTC, datetime
import re
from pathlib import Path
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field

from wordless.core.models import (
    Interaction,
    Message,
    Resolution,
    StateFact,
    hash_customer_key,
)
from wordless.core.redact import RedactionReport, Redactor, is_structured_schema_key


class AdapterError(ValueError):
    """Raised when an export cannot be normalized safely."""


class IngestSummary(BaseModel):
    """Deterministic summary of one streaming ingest."""

    model_config = ConfigDict(frozen=True)

    source_system: str
    interactions: int = Field(ge=0)
    redaction: RedactionReport


Author = Literal["customer", "agent", "system"]
Channel = Literal["email", "chat", "phone", "form", "web"]
_SCHEMA_LABEL = re.compile(r"\A[a-z][a-z0-9_.-]{0,63}\Z")


class Adapter(ABC):
    """Read-only streaming export adapter.

    A per-corpus salt is required when loading, but intentionally is never
    exposed in an interaction, report, or store.  ``detect`` remains usable
    without a salt so callers can choose an adapter before requesting one.
    """

    source_system: ClassVar[str]

    def __init__(
        self,
        corpus_salt: str | bytes | None = None,
        *,
        salt: str | bytes | None = None,
        redactor: Redactor | None = None,
        preserve_terms: Iterable[str] = (),
    ) -> None:
        if corpus_salt is not None and salt is not None:
            raise AdapterError("Pass either corpus_salt or salt, not both")
        if redactor is not None and type(redactor) is not Redactor:
            raise TypeError("redactor must be a concrete Redactor instance")
        if redactor is not None and not redactor.boundary_safe:
            raise ValueError(
                "redactor must use the available mandatory Presidio policy with the pinned model and without "
                "caller-controlled preservation terms"
            )
        self._corpus_salt = corpus_salt if corpus_salt is not None else salt
        self._redactor = redactor or Redactor(preserve_terms=tuple(preserve_terms))
        if type(self._redactor) is not Redactor or not self._redactor.boundary_safe:
            raise ValueError(
                "ingest requires the available mandatory Presidio policy with the pinned model and forbids "
                "caller-controlled preservation terms"
            )
        self._redaction_report = RedactionReport()
        self._interactions_loaded = 0

    @abstractmethod
    def detect(self, path: Path) -> bool:
        """Return whether ``path`` looks like this vendor's export."""

    @abstractmethod
    def load(self, path: Path) -> Iterator[Interaction]:
        """Stream redacted canonical interactions from ``path``."""

    @property
    def redaction_report(self) -> RedactionReport:
        """Return a defensive copy of the report accumulated so far."""

        return deepcopy(self._redaction_report)

    @property
    def redactor(self) -> Redactor:
        """The configured redactor, for an equivalent store-boundary rescan."""

        return self._redactor

    @property
    def summary(self) -> IngestSummary:
        return IngestSummary(
            source_system=self.source_system,
            interactions=self._interactions_loaded,
            redaction=self.redaction_report,
        )

    def reset_report(self) -> None:
        """Reset counters before deliberately re-reading the same corpus."""

        self._redaction_report = RedactionReport()
        self._interactions_loaded = 0

    def _salt(self) -> str | bytes:
        if self._corpus_salt is None or self._corpus_salt == b"" or self._corpus_salt == "":
            raise AdapterError(
                "A non-empty per-corpus salt is required to load an export; "
                "keep it outside the corpus store"
            )
        return self._corpus_salt

    def _finalize(
        self,
        *,
        interaction_id: Any,
        raw_customer_id: Any,
        opened_at: Any,
        channel: Any,
        messages: Iterable[Message | Mapping[str, Any]],
        state_snapshot: Iterable[StateFact | Mapping[str, Any]] = (),
        resolution: Resolution | Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
        source_system: str | None = None,
    ) -> Interaction:
        """Validate, redact, and return one canonical interaction.

        This is the only adapter exit.  Vendor adapters pass raw values here;
        no unredacted canonical object is ever yielded.
        """

        normalized_opened = parse_datetime(opened_at, field="opened_at")
        normalized_messages: list[Message] = []
        for item in messages:
            message = item if isinstance(item, Message) else Message.model_validate(item)
            normalized_messages.append(
                message.model_copy(
                    update={"sent_at": parse_datetime(message.sent_at, field="message.sent_at")},
                    deep=True,
                )
            )
        normalized_messages.sort(key=lambda item: item.sent_at)

        normalized_facts: list[StateFact] = []
        for item in state_snapshot:
            fact = item if isinstance(item, StateFact) else StateFact.model_validate(item)
            fact = fact.model_copy(
                update={
                    "occurred_at": parse_datetime(fact.occurred_at, field="state.occurred_at")
                },
                deep=True,
            )
            # Exports are current-state-heavy.  Selecting here prevents a later
            # record from ever reaching the canonical interaction validator.
            if comparable_datetime(fact.occurred_at) <= comparable_datetime(normalized_opened):
                normalized_facts.append(fact)
        normalized_facts.sort(
            key=lambda item: (
                comparable_datetime(item.occurred_at),
                item.source,
                item.kind,
            )
        )

        normalized_resolution: Resolution | None
        if resolution is None:
            normalized_resolution = None
        elif isinstance(resolution, Resolution):
            normalized_resolution = resolution.model_copy(
                update={
                    "resolved_at": parse_datetime(
                        resolution.resolved_at, field="resolution.resolved_at"
                    )
                },
                deep=True,
            )
        else:
            parsed_resolution = Resolution.model_validate(resolution)
            normalized_resolution = parsed_resolution.model_copy(
                update={
                    "resolved_at": parse_datetime(
                        parsed_resolution.resolved_at, field="resolution.resolved_at"
                    )
                },
                deep=True,
            )

        raw_interaction_id = clean_scalar(interaction_id)
        if not raw_interaction_id:
            raise AdapterError("Interaction ID must not be empty")

        raw_id = clean_scalar(raw_customer_id)
        if not raw_id:
            # Missing customer IDs must not collapse every unknown customer to
            # one hash.  Interaction ID is stable and contains no added PII.
            raw_id = f"missing-customer:{raw_interaction_id}"

        id_scan = self._redactor.redact_external_identifier(raw_interaction_id)
        id_prose_scan = self._redactor.redact(raw_interaction_id)
        if id_scan.changed or id_prose_scan.changed:
            digest = hash_customer_key(
                f"interaction:{raw_interaction_id}",
                self._salt(),
            ).removeprefix("hmac-sha256:")
            canonical_id = f"redacted-hmac-sha256:{digest}"
        else:
            canonical_id = raw_interaction_id

        safe_metadata, key_report = self._sanitize_mapping_keys(dict(metadata or {}))
        key_report = key_report.merge(id_scan.report, id_prose_scan.report)
        safe_facts: list[StateFact] = []
        for fact in normalized_facts:
            safe_fields, fields_report = self._sanitize_mapping_keys(fact.fields)
            key_report = key_report.merge(fields_report)
            safe_source, source_report = self._schema_label(fact.source, fallback="account")
            safe_kind, kind_report = self._schema_label(fact.kind, fallback="request")
            key_report = key_report.merge(source_report, kind_report)
            safe_facts.append(
                fact.model_copy(
                    update={
                        "source": safe_source,
                        "kind": safe_kind,
                        "fields": safe_fields,
                    },
                    deep=True,
                )
            )
        safe_source_system, source_system_report = self._schema_label(
            source_system or self.source_system,
            fallback=self.source_system,
        )
        key_report = key_report.merge(source_system_report)

        raw = Interaction(
            id=canonical_id,
            customer_key=hash_customer_key(raw_id, self._salt()),
            opened_at=normalized_opened,
            channel=normalize_channel(channel),
            messages=normalized_messages,
            state_snapshot=safe_facts,
            resolution=normalized_resolution,
            source_system=safe_source_system,
            metadata=safe_metadata,
        )
        redacted, report = self._redactor.redact_interaction(raw)
        if any(not message.redacted for message in redacted.messages):
            raise AdapterError("Redactor returned an interaction with an unredacted message")
        merged = self._redaction_report.merge(key_report, report)
        if merged is not None:
            # Support either fluent/immutable or mutating report implementations.
            self._redaction_report = merged
        self._interactions_loaded += 1
        return redacted

    def _schema_label(
        self,
        value: Any,
        *,
        fallback: str,
    ) -> tuple[str, RedactionReport]:
        """Keep only adapter-authored, lowercase categorical vocabulary."""

        text = clean_scalar(value)
        result = self._redactor.redact(text)
        if result.changed or not _SCHEMA_LABEL.fullmatch(text):
            return fallback, result.report
        return text, result.report

    def _sanitize_mapping_keys(self, value: Any) -> tuple[Any, RedactionReport]:
        """Redact arbitrary export-provided mapping keys before persistence."""

        report = RedactionReport()
        if isinstance(value, Mapping):
            output: dict[Any, Any] = {}
            for index, (key, item) in enumerate(value.items()):
                safe_key = key
                if isinstance(key, str):
                    if is_structured_schema_key(key):
                        result = None
                    else:
                        result = self._redactor.redact(key)
                        report = report.merge(result.report)
                        safe_key = result.text
                    if safe_key in output:
                        safe_key = f"{safe_key}_{index}"
                safe_item, item_report = self._sanitize_mapping_keys(item)
                report = report.merge(item_report)
                output[safe_key] = safe_item
            return output, report
        if isinstance(value, list):
            output_list: list[Any] = []
            for item in value:
                safe_item, item_report = self._sanitize_mapping_keys(item)
                report = report.merge(item_report)
                output_list.append(safe_item)
            return output_list, report
        if isinstance(value, tuple):
            output_tuple: list[Any] = []
            for item in value:
                safe_item, item_report = self._sanitize_mapping_keys(item)
                report = report.merge(item_report)
                output_tuple.append(safe_item)
            return tuple(output_tuple), report
        if isinstance(value, (set, frozenset)):
            output_set: list[Any] = []
            for item in sorted(value, key=repr):
                safe_item, item_report = self._sanitize_mapping_keys(item)
                report = report.merge(item_report)
                output_set.append(safe_item)
            return output_set, report
        return value, report


def clean_scalar(value: Any, default: str = "") -> str:
    if value is None:
        return default
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).strip()


def comparable_datetime(value: datetime) -> datetime:
    """Return an aware UTC datetime suitable for safe comparisons."""

    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def parse_datetime(
    value: Any,
    *,
    field: str = "timestamp",
    default: datetime | None = None,
) -> datetime:
    """Parse ISO-8601 strings and Unix seconds/milliseconds deterministically."""

    if value is None or value == "":
        if default is not None:
            return comparable_datetime(default)
        raise AdapterError(f"Missing required {field}")
    if isinstance(value, datetime):
        return comparable_datetime(value)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        seconds = float(value)
        if abs(seconds) >= 100_000_000_000:
            seconds /= 1000.0
        try:
            return datetime.fromtimestamp(seconds, tz=UTC)
        except (OverflowError, OSError, ValueError) as exc:
            raise AdapterError(f"Invalid {field}: {value!r}") from exc
    text = clean_scalar(value)
    if text.isdigit() or (text.startswith("-") and text[1:].isdigit()):
        return parse_datetime(int(text), field=field, default=default)
    normalized = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        # A few exports use a space plus an English UTC suffix.
        if normalized.upper().endswith(" UTC"):
            try:
                parsed = datetime.fromisoformat(normalized[:-4]).replace(tzinfo=UTC)
            except ValueError:
                raise AdapterError(f"Invalid {field}: {value!r}") from exc
        else:
            raise AdapterError(f"Invalid {field}: {value!r}") from exc
    return comparable_datetime(parsed)


def normalize_author(value: Any, *, default: Author = "system") -> Author:
    if isinstance(value, int):
        # Chatwoot: incoming=0, outgoing=1, activity=2.
        return {0: "customer", 1: "agent", 2: "system"}.get(value, default)
    text = clean_scalar(value).casefold().replace("-", "_").replace(" ", "_")
    if text in {
        "customer",
        "contact",
        "requester",
        "user",
        "lead",
        "visitor",
        "incoming",
        "external",
    }:
        return "customer"
    if text in {
        "agent",
        "admin",
        "support",
        "teammate",
        "operator",
        "outgoing",
        "internal",
    }:
        return "agent"
    if text in {"system", "bot", "automation", "activity", "note"}:
        return "system"
    return default


def normalize_channel(value: Any) -> Channel:
    text = clean_scalar(value, "web").casefold().replace("-", "_").replace(" ", "_")
    if text in {"email", "mail"}:
        return "email"
    if text in {"chat", "messaging", "widget", "whatsapp", "sms", "social"} or any(
        token in text for token in ("chat", "widget", "whatsapp", "messaging")
    ):
        return "chat"
    if text in {"phone", "voice", "call"}:
        return "phone"
    if text in {"form", "ticket_form"}:
        return "form"
    return "web"


def ensure_sequence(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return list(value)
    return [value]

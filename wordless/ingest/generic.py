"""First-class YAML-mapped adapter for CSV, JSONL, JSON, and YAML exports."""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any, ClassVar

import yaml

from wordless.core.models import Interaction

from .base import (
    Adapter,
    AdapterError,
    clean_scalar,
    ensure_sequence,
    normalize_author,
    parse_datetime,
)
from .formats import choose_export_file, iter_records, lookup


class MappingError(AdapterError):
    """Raised when a generic adapter mapping is incomplete or inconsistent."""


DEFAULT_FIELDS: dict[str, Any] = {
    "id": ["id", "ticket_id", "conversation_id"],
    "customer_id": ["customer_id", "requester_id", "contact_id", "email"],
    "opened_at": ["opened_at", "created_at", "created"],
    "channel": ["channel", "via.channel", "source.channel"],
    "metadata": "metadata",
}

DEFAULT_MESSAGE_FIELDS: dict[str, Any] = {
    "author": ["author", "role", "author_type", "sender_type", "message_type"],
    "sent_at": ["sent_at", "created_at", "timestamp"],
    "text": ["text", "body", "content", "message", "description"],
}


class GenericAdapter(Adapter):
    """Normalize a customer export according to a versionable YAML mapping.

    Mapping shape (all dotted paths are relative to their current record)::

        format: csv                  # csv | tsv | jsonl | json | yaml
        file: tickets.csv            # optional when ``load`` receives a directory
        source_system: generic
        fields:
          id: ticket_id
          customer_id: requester_email
          opened_at: created_at
          channel: {value: email}
        messages:
          path: comments             # omit for one message per row
          fields: {author: role, sent_at: at, text: body}
          author_map: {requester: customer, staff: agent}
        state:
          path: linked_charges
          fields:
            source: {value: billing}
            kind: {value: charge}
            occurred_at: charged_at
            fields: {amount: amount, status: status}
        resolution:
          fields: {resolved_at: closed_at, original_label: category,
                   actions: actions, closing_text: closing_text}

    ``columns`` is accepted as an alias for ``fields``.  Literal values use
    ``{value: ...}``, which removes any ambiguity with a column name.
    """

    source_system: ClassVar[str] = "generic"

    def __init__(
        self,
        mapping_path: Path | str | Mapping[str, Any] | None = None,
        corpus_salt: str | bytes | None = None,
        **kwargs: Any,
    ) -> None:
        # Allow ``GenericAdapter(salt, mapping_path=...)`` only through named
        # arguments; a mapping is always the first positional value.
        if mapping_path is None:
            mapping: dict[str, Any] = {}
            self.mapping_path: Path | None = None
        elif isinstance(mapping_path, Mapping):
            mapping = dict(mapping_path)
            self.mapping_path = None
        else:
            self.mapping_path = Path(mapping_path)
            try:
                loaded = yaml.safe_load(self.mapping_path.read_text(encoding="utf-8"))
            except (OSError, yaml.YAMLError) as exc:
                raise MappingError(f"Could not read mapping {self.mapping_path}: {exc}") from exc
            if not isinstance(loaded, Mapping):
                raise MappingError("Generic adapter mapping must be a YAML object")
            mapping = dict(loaded)
        self.mapping = mapping
        self._validate_mapping()
        preserve_terms = ensure_sequence(mapping.get("preserve_terms"))
        supplied_preserve = ensure_sequence(kwargs.pop("preserve_terms", ()))
        if preserve_terms or supplied_preserve:
            raise MappingError(
                "preserve_terms is not allowed at the mandatory ingest boundary; "
                "use canonical structured order, amount, SKU, currency, or product fields"
            )
        super().__init__(
            corpus_salt=corpus_salt,
            **kwargs,
        )

    def _validate_mapping(self) -> None:
        format_name = clean_scalar(self.mapping.get("format", "")).casefold()
        if format_name and format_name not in {
            "csv",
            "tsv",
            "json",
            "jsonl",
            "ndjson",
            "yaml",
            "yml",
        }:
            raise MappingError(f"Unsupported format in mapping: {format_name!r}")
        for section in ("fields", "columns", "messages", "state", "resolution"):
            value = self.mapping.get(section)
            if value is not None and not isinstance(value, (str, list, Mapping)):
                raise MappingError(f"Mapping section {section!r} has an invalid type")

    def detect(self, path: Path) -> bool:
        try:
            export_file = self._export_file(Path(path))
        except AdapterError:
            return False
        configured = clean_scalar(self.mapping.get("format", "")).casefold()
        if configured:
            return True
        suffixes = {suffix.casefold() for suffix in export_file.suffixes}
        return bool(suffixes & {".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".yaml", ".yml"})

    def load(self, path: Path) -> Iterator[Interaction]:
        export_file = self._export_file(Path(path))
        format_name = clean_scalar(self.mapping.get("format")) or None
        root = self.mapping.get("root") or self.mapping.get("records_path")
        root_keys = tuple(ensure_sequence(root)) if root else ("records", "interactions", "tickets")
        delimiter = self.mapping.get("delimiter")
        for index, record in enumerate(
            iter_records(
                export_file,
                format_name=format_name,
                root_keys=tuple(clean_scalar(item) for item in root_keys),
                delimiter=clean_scalar(delimiter) if delimiter else None,
            ),
            start=1,
        ):
            yield self._normalize_record(record, index=index)

    def _export_file(self, path: Path) -> Path:
        configured = self.mapping.get("file") or self.mapping.get("filename")
        if path.is_dir() and configured:
            candidate = path / clean_scalar(configured)
            if not candidate.is_file():
                raise AdapterError(f"Mapped export file does not exist: {candidate}")
            return candidate
        return choose_export_file(path, preferred_names=(clean_scalar(configured),) if configured else ())

    def _normalize_record(self, record: Mapping[str, Any], *, index: int) -> Interaction:
        fields = dict(DEFAULT_FIELDS)
        configured_fields = self.mapping.get("fields") or self.mapping.get("columns") or {}
        if isinstance(configured_fields, Mapping):
            fields.update(configured_fields)

        messages = self._messages(record)
        opened_raw = resolve(record, fields.get("opened_at"))
        if opened_raw in (None, "") and messages:
            opened_raw = messages[0]["sent_at"]
        id_spec = fields.get("interaction_id") if "interaction_id" in configured_fields else fields.get("id")
        interaction_id = resolve(record, id_spec)
        if interaction_id in (None, ""):
            interaction_id = f"row-{index:08d}"
        customer_spec = (
            fields.get("customer_key")
            if "customer_key" in configured_fields and "customer_id" not in configured_fields
            else fields.get("customer_id")
        )
        raw_customer_id = resolve(record, customer_spec)
        metadata = decode_structured(resolve(record, fields.get("metadata")))
        if not isinstance(metadata, Mapping):
            metadata = {}

        opened = parse_datetime(opened_raw, field="opened_at")
        return self._finalize(
            interaction_id=interaction_id,
            raw_customer_id=raw_customer_id,
            opened_at=opened,
            channel=resolve(record, fields.get("channel"), "web"),
            messages=messages,
            state_snapshot=self._state_facts(record, opened_at=opened),
            resolution=self._resolution(record),
            metadata=metadata,
            source_system=clean_scalar(self.mapping.get("source_system"), "generic"),
        )

    def _messages(self, record: Mapping[str, Any]) -> list[dict[str, Any]]:
        config = self.mapping.get("messages")
        if config is None:
            raw_messages = decode_structured(record.get("messages") or record.get("comments"))
            if raw_messages is None:
                raw_messages = [record]
            top_level = self.mapping.get("fields") or self.mapping.get("columns") or {}
            fields = dict(DEFAULT_MESSAGE_FIELDS)
            if isinstance(top_level, Mapping):
                aliases = {
                    "author": ("message_author", "author"),
                    "sent_at": ("message_sent_at", "sent_at"),
                    "text": ("message_text", "text"),
                }
                for canonical, options in aliases.items():
                    for option in options:
                        if option in top_level:
                            fields[canonical] = top_level[option]
                            break
            author_map: Mapping[str, Any] = {}
        elif isinstance(config, str):
            raw_messages = decode_structured(lookup(record, config))
            fields = DEFAULT_MESSAGE_FIELDS
            author_map = {}
        elif isinstance(config, Mapping):
            path = config.get("path")
            raw_messages = decode_structured(resolve(record, path)) if path else [record]
            direct_fields = {
                key: config[key]
                for key in ("author", "sent_at", "text")
                if key in config
            }
            fields = config.get("fields") or config.get("columns") or direct_fields or DEFAULT_MESSAGE_FIELDS
            author_map = config.get("author_map") or {}
        else:
            raw_messages = config
            fields = DEFAULT_MESSAGE_FIELDS
            author_map = {}

        output: list[dict[str, Any]] = []
        for raw in ensure_sequence(raw_messages):
            if not isinstance(raw, Mapping):
                continue
            raw_author = resolve(raw, fields.get("author", DEFAULT_MESSAGE_FIELDS["author"]))
            raw_author_text = clean_scalar(raw_author)
            mapped_author = author_map.get(raw_author_text, raw_author)
            if mapped_author is raw_author:
                mapped_author = next(
                    (
                        mapped
                        for source, mapped in author_map.items()
                        if clean_scalar(source).casefold() == raw_author_text.casefold()
                    ),
                    raw_author,
                )
            sent_at = resolve(raw, fields.get("sent_at", DEFAULT_MESSAGE_FIELDS["sent_at"]))
            text = resolve(raw, fields.get("text", DEFAULT_MESSAGE_FIELDS["text"]), "")
            if sent_at in (None, ""):
                # A flat export often has one created_at used by both the ticket
                # and its initial message.
                sent_at = resolve(record, ["opened_at", "created_at", "created"])
            output.append(
                {
                    "author": normalize_author(mapped_author, default="customer"),
                    "sent_at": parse_datetime(sent_at, field="message.sent_at"),
                    "text": clean_scalar(text),
                    "redacted": False,
                }
            )
        return output

    def _state_facts(self, record: Mapping[str, Any], *, opened_at: Any) -> list[dict[str, Any]]:
        config = self.mapping.get("state") or self.mapping.get("state_snapshot")
        if config is None:
            raw_facts = decode_structured(record.get("state_snapshot") or record.get("state_facts"))
            if raw_facts is None:
                return []
            configs: list[Any] = [
                {
                    "path": {"value": raw_facts},
                    "fields": {
                        "source": "source",
                        "kind": "kind",
                        "occurred_at": "occurred_at",
                        "fields": "fields",
                    },
                }
            ]
        elif isinstance(config, list):
            configs = config
        else:
            configs = [config]

        output: list[dict[str, Any]] = []
        for item_config in configs:
            if isinstance(item_config, str):
                raw_values = decode_structured(lookup(record, item_config))
                fact_fields: Mapping[str, Any] = {}
            elif isinstance(item_config, Mapping):
                path_spec = item_config.get("path")
                raw_values = decode_structured(resolve(record, path_spec)) if path_spec else [record]
                fact_fields = item_config.get("fields") or item_config.get("columns") or item_config
            else:
                continue
            for raw in ensure_sequence(raw_values):
                if not isinstance(raw, Mapping):
                    continue
                source = resolve(raw, fact_fields.get("source"), "account", literal_fallback=True)
                kind = resolve(raw, fact_fields.get("kind"), "request", literal_fallback=True)
                occurred_spec = fact_fields.get("occurred_at")
                if occurred_spec is None:
                    continue
                occurred = resolve(raw, occurred_spec)
                if occurred in (None, ""):
                    continue
                data_spec = fact_fields.get("fields")
                if isinstance(data_spec, Mapping):
                    data = {key: resolve(raw, spec) for key, spec in data_spec.items()}
                else:
                    data = decode_structured(resolve(raw, data_spec)) if data_spec else {}
                if not isinstance(data, Mapping):
                    data = {"value": data}
                output.append(
                    {
                        "source": clean_scalar(source, "account"),
                        "kind": clean_scalar(kind, "request"),
                        "occurred_at": parse_datetime(
                            occurred, field="state.occurred_at"
                        ),
                        "fields": dict(data),
                        # A generic mapping represents linked exported state.
                        "provenance": "exported",
                    }
                )
        return output

    def _resolution(self, record: Mapping[str, Any]) -> dict[str, Any] | None:
        config = self.mapping.get("resolution")
        if config is None:
            top_level = self.mapping.get("fields") or self.mapping.get("columns") or {}
            top_level = top_level if isinstance(top_level, Mapping) else {}
            resolved_spec = top_level.get("resolved_at", ["resolved_at", "closed_at"])
            resolved_at = resolve(record, resolved_spec)
            if resolved_at in (None, ""):
                return None
            source: Mapping[str, Any] = record
            fields: Mapping[str, Any] = {
                "resolved_at": resolved_spec,
                "original_label": top_level.get(
                    "original_label", ["original_label", "category", "type"]
                ),
                "actions": top_level.get("actions", "actions"),
                "closing_text": top_level.get(
                    "closing_text", ["closing_text", "resolution"]
                ),
            }
        elif isinstance(config, str):
            nested = decode_structured(lookup(record, config))
            if not isinstance(nested, Mapping):
                return None
            source = nested
            fields = {}
        elif isinstance(config, Mapping):
            nested = decode_structured(resolve(record, config.get("path"))) if config.get("path") else record
            if not isinstance(nested, Mapping):
                return None
            source = nested
            fields = config.get("fields") or config.get("columns") or config
        else:
            return None

        resolved_at = resolve(source, fields.get("resolved_at", "resolved_at"))
        if resolved_at in (None, ""):
            return None
        actions = decode_structured(resolve(source, fields.get("actions", "actions")))
        return {
            "resolved_at": parse_datetime(resolved_at, field="resolution.resolved_at"),
            "original_label": nullable_text(
                resolve(source, fields.get("original_label", "original_label"))
            ),
            "actions": [clean_scalar(action) for action in ensure_sequence(actions) if clean_scalar(action)],
            "closing_text": clean_scalar(
                resolve(source, fields.get("closing_text", "closing_text"), "")
            ),
        }


def resolve(
    record: Mapping[str, Any],
    spec: Any,
    default: Any = None,
    *,
    literal_fallback: bool = False,
) -> Any:
    """Resolve a mapping path, ordered alternatives, or explicit literal."""

    if spec is None:
        return default
    if isinstance(spec, Mapping):
        if "value" in spec:
            return spec["value"]
        value = lookup(record, spec.get("path"), spec.get("default", default))
        return value
    if isinstance(spec, list):
        for option in spec:
            value = resolve(record, option)
            if value is not None and value != "":
                return value
        return default
    if isinstance(spec, str):
        sentinel = object()
        value = lookup(record, spec, sentinel)
        if value is not sentinel:
            return value
        return spec if literal_fallback else default
    return spec


def decode_structured(value: Any) -> Any:
    """Decode JSON cells used by flat CSV exports, leaving ordinary text alone."""

    if not isinstance(value, str):
        return value
    stripped = value.strip()
    if not stripped or stripped[0] not in "[{":
        return value
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return value


def nullable_text(value: Any) -> str | None:
    text = clean_scalar(value)
    return text or None

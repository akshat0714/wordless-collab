"""Private normalization helpers shared by fixed vendor adapters."""

from __future__ import annotations

import html
import re
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

from .base import clean_scalar, ensure_sequence
from .formats import choose_export_file, first, iter_records


_TAG = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"[\t\r\f\v ]+")
_BREAK = re.compile(r"<(?:br\s*/?|/p|/div|/li)>|<li[^>]*>", re.IGNORECASE)


def plain_text(value: Any) -> str:
    text = clean_scalar(value)
    if "<" in text and ">" in text:
        text = _BREAK.sub("\n", text)
        text = _TAG.sub("", text)
        text = html.unescape(text)
    lines = [_SPACE.sub(" ", line).strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def vendor_file(path: Path, names: Sequence[str]) -> Path:
    return choose_export_file(Path(path), preferred_names=names)


def vendor_records(path: Path, *, names: Sequence[str], root_keys: Sequence[str]):
    export_file = vendor_file(path, names)
    yield from iter_records(export_file, root_keys=root_keys)


def list_at(record: Mapping[str, Any], *paths: str) -> list[Any]:
    value = first(record, *paths)
    if isinstance(value, Mapping):
        # Intercom wraps lists as {"conversation_parts": [...]} and contacts
        # as {"contacts": [...]}.
        for path in paths:
            leaf = path.rsplit(".", 1)[-1]
            if leaf in value:
                value = value[leaf]
                break
        else:
            for candidate in value.values():
                if isinstance(candidate, list):
                    value = candidate
                    break
    return ensure_sequence(value)


def custom_fields(value: Any) -> dict[str, Any]:
    """Normalize vendor custom-field lists without preserving customer IDs."""

    if isinstance(value, Mapping):
        return {clean_scalar(key): item for key, item in value.items()}
    output: dict[str, Any] = {}
    for item in ensure_sequence(value):
        if not isinstance(item, Mapping):
            continue
        key = first(item, "name", "key", "id")
        if key is not None:
            output[clean_scalar(key)] = first(item, "value", "field_value")
    return output


def linked_facts(
    record: Mapping[str, Any],
    *,
    opened_at: Any,
    containers: Iterable[tuple[str, str, str]],
) -> list[dict[str, Any]]:
    """Turn explicitly linked exported records into rung-1 facts."""

    output: list[dict[str, Any]] = []
    for path, source, kind in containers:
        for item in list_at(record, path):
            if not isinstance(item, Mapping):
                continue
            occurred = first(
                item,
                "occurred_at",
                "created_at",
                "charged_at",
                "ordered_at",
                "updated_at",
                default=None,
            )
            # A current-state record with no source timestamp cannot be placed
            # at contact time honestly.  Exclude it from rung-1 evidence; the
            # reconstruction ladder will then report a lower-fidelity rung.
            if occurred in (None, ""):
                continue
            fields = {
                clean_scalar(key): value
                for key, value in item.items()
                if key
                not in {
                    "customer_id",
                    "contact_id",
                    "requester_id",
                    "user_id",
                    "email",
                    "name",
                    "address",
                    "phone",
                    "occurred_at",
                    "created_at",
                    "charged_at",
                    "ordered_at",
                    "updated_at",
                }
            }
            output.append(
                {
                    "source": source,
                    "kind": kind,
                    "occurred_at": occurred,
                    "fields": fields,
                    "provenance": "exported",
                }
            )
    return output

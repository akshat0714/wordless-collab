"""Streaming, read-only Intercom conversation export adapter."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any, ClassVar

from wordless.core.models import Interaction

from ._vendor import linked_facts, list_at, plain_text, vendor_file, vendor_records
from .base import Adapter, clean_scalar, normalize_author, parse_datetime
from .formats import first, peek_keys


class IntercomAdapter(Adapter):
    source_system: ClassVar[str] = "intercom"
    _NAMES = ("conversations.json", "conversations.jsonl", "conversations.ndjson")

    def detect(self, path: Path) -> bool:
        try:
            export_file = vendor_file(Path(path), self._NAMES)
        except (OSError, ValueError):
            return False
        if "intercom" in str(export_file).casefold():
            return True
        keys = peek_keys(export_file)
        return bool(keys & {"conversation_parts", "admin_assignee_id", "teammates"}) and "id" in keys

    def load(self, path: Path) -> Iterator[Interaction]:
        yield from (
            self._normalize(record)
            for record in vendor_records(
                path, names=self._NAMES, root_keys=("conversations", "data", "results")
            )
        )

    def _normalize(self, record: Mapping[str, Any]) -> Interaction:
        opened = parse_datetime(first(record, "created_at", "opened_at"), field="opened_at")
        contacts = list_at(record, "contacts.contacts", "contacts")
        contact = next((item for item in contacts if isinstance(item, Mapping)), {})
        customer_id = first(contact, "id", "external_id", "email", default=first(record, "contact_id"))

        raw_messages: list[Any] = []
        source = record.get("source")
        if isinstance(source, Mapping) and first(source, "body", "text") is not None:
            raw_messages.append(source)
        raw_messages.extend(list_at(record, "conversation_parts.conversation_parts", "conversation_parts"))
        messages: list[dict[str, Any]] = []
        for item in raw_messages:
            if not isinstance(item, Mapping):
                continue
            body = first(item, "body", "text", "content")
            if body is None:
                continue
            author = item.get("author") if isinstance(item.get("author"), Mapping) else {}
            author_type = first(author, "type", default=first(item, "author_type", "part_type"))
            messages.append(
                {
                    "author": normalize_author(author_type, default="system"),
                    "sent_at": parse_datetime(
                        first(item, "created_at", "delivered_at", default=opened),
                        field="message.sent_at",
                    ),
                    "text": plain_text(body),
                    "redacted": False,
                }
            )

        state = clean_scalar(first(record, "state", "status")).casefold()
        closed_at = first(record, "closed_at", "statistics.last_close_at")
        resolution = None
        if state in {"closed", "resolved"} or closed_at is not None:
            agents = [message for message in messages if message["author"] == "agent"]
            resolution = {
                "resolved_at": parse_datetime(
                    closed_at or first(record, "updated_at", default=opened),
                    field="resolution.resolved_at",
                ),
                "original_label": nullable(first(record, "topic", "category", "type")),
                "actions": [state or "closed"],
                "closing_text": agents[-1]["text"] if agents else "",
            }

        tags = list_at(record, "tags.tags", "tags")
        tag_names = [first(item, "name", default=item) if isinstance(item, Mapping) else item for item in tags]
        facts = linked_facts(
            record,
            opened_at=opened,
            containers=(
                ("orders", "orders", "order"),
                ("charges", "billing", "charge"),
                ("subscriptions", "billing", "subscription"),
                ("account", "account", "account"),
            ),
        )
        return self._finalize(
            interaction_id=record.get("id"),
            raw_customer_id=customer_id,
            opened_at=opened,
            channel=first(record, "source.delivered_as", "source.type", "channel", default="chat"),
            messages=messages,
            state_snapshot=facts,
            resolution=resolution,
            metadata={"tags": tag_names, "priority": record.get("priority")},
        )


def nullable(value: Any) -> str | None:
    text = clean_scalar(value)
    return text or None

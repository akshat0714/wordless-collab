"""Streaming, read-only Chatwoot conversation export adapter."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any, ClassVar

from wordless.core.models import Interaction

from ._vendor import custom_fields, linked_facts, list_at, plain_text, vendor_file, vendor_records
from .base import Adapter, clean_scalar, normalize_author, parse_datetime
from .formats import first, peek_keys


class ChatwootAdapter(Adapter):
    source_system: ClassVar[str] = "chatwoot"
    _NAMES = ("chatwoot.json", "conversations.json", "conversations.jsonl")

    def detect(self, path: Path) -> bool:
        try:
            export_file = vendor_file(Path(path), self._NAMES)
        except (OSError, ValueError):
            return False
        if "chatwoot" in export_file.name.casefold():
            return True
        keys = peek_keys(export_file)
        return "messages" in keys and bool(keys & {"contact", "inbox_id", "display_id"})

    def load(self, path: Path) -> Iterator[Interaction]:
        for record in vendor_records(
            path, names=self._NAMES, root_keys=("payload", "conversations", "data")
        ):
            yield self._normalize(record)

    def _normalize(self, record: Mapping[str, Any]) -> Interaction:
        opened = parse_datetime(first(record, "created_at", "timestamp", "opened_at"), field="opened_at")
        contact = record.get("contact") if isinstance(record.get("contact"), Mapping) else {}
        customer_id = first(contact, "id", "identifier", "email", default=first(record, "contact_id"))
        messages: list[dict[str, Any]] = []
        for item in list_at(record, "messages"):
            if not isinstance(item, Mapping):
                continue
            content = first(item, "content", "text", "processed_message_content")
            if content is None:
                continue
            message_type = item.get("message_type")
            sender_type = first(item, "sender_type", "sender.type")
            author = normalize_author(
                message_type if isinstance(message_type, int) else sender_type or message_type,
                default="system",
            )
            messages.append(
                {
                    "author": author,
                    "sent_at": parse_datetime(
                        first(item, "created_at", "timestamp", default=opened),
                        field="message.sent_at",
                    ),
                    "text": plain_text(content),
                    "redacted": False,
                }
            )

        status = clean_scalar(record.get("status")).casefold()
        resolution = None
        if status in {"resolved", "closed"}:
            agents = [message for message in messages if message["author"] == "agent"]
            resolution = {
                "resolved_at": parse_datetime(
                    first(record, "resolved_at", "updated_at", default=opened),
                    field="resolution.resolved_at",
                ),
                "original_label": nullable(first(record, "custom_attributes.category", "category")),
                "actions": [status],
                "closing_text": agents[-1]["text"] if agents else "",
            }
        facts = linked_facts(
            record,
            opened_at=opened,
            containers=(
                ("custom_attributes.orders", "orders", "order"),
                ("custom_attributes.charges", "billing", "charge"),
                ("custom_attributes.subscriptions", "billing", "subscription"),
                ("additional_attributes.account", "account", "account"),
            ),
        )
        return self._finalize(
            interaction_id=first(record, "id", "display_id"),
            raw_customer_id=customer_id,
            opened_at=opened,
            channel=first(record, "inbox.channel_type", "channel", default="chat"),
            messages=messages,
            state_snapshot=facts,
            resolution=resolution,
            metadata={
                "labels": record.get("labels") or [],
                "custom_fields": custom_fields(record.get("custom_attributes")),
            },
        )


def nullable(value: Any) -> str | None:
    text = clean_scalar(value)
    return text or None

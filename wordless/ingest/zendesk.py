"""Streaming, read-only Zendesk export adapter."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any, ClassVar

from wordless.core.models import Interaction

from ._vendor import custom_fields, linked_facts, list_at, plain_text, vendor_file, vendor_records
from .base import Adapter, clean_scalar, normalize_author, parse_datetime
from .formats import first, peek_keys


class ZendeskAdapter(Adapter):
    source_system: ClassVar[str] = "zendesk"
    _NAMES = ("tickets.json", "tickets.jsonl", "tickets.ndjson", "tickets.csv")

    def detect(self, path: Path) -> bool:
        try:
            export_file = vendor_file(Path(path), self._NAMES)
        except (OSError, ValueError):
            return False
        if "zendesk" in str(export_file).casefold():
            return True
        keys = peek_keys(export_file)
        return "requester_id" in keys and bool(keys & {"via", "status", "ticket_form_id"})

    def load(self, path: Path) -> Iterator[Interaction]:
        for record in vendor_records(path, names=self._NAMES, root_keys=("tickets", "results")):
            yield self._normalize(record)

    def _normalize(self, record: Mapping[str, Any]) -> Interaction:
        opened = parse_datetime(first(record, "created_at", "opened_at"), field="opened_at")
        requester = first(record, "requester_id", "requester.id", "requester.email", "submitter_id")
        comments = list_at(record, "comments", "ticket.comments", "events")
        messages: list[dict[str, Any]] = []
        for item in comments:
            if not isinstance(item, Mapping):
                continue
            event = item.get("comment") if isinstance(item.get("comment"), Mapping) else item
            body = first(event, "plain_body", "body", "html_body", "value")
            if body is None:
                continue
            author_id = first(event, "author_id", "author.id")
            author = (
                "customer"
                if clean_scalar(requester)
                and clean_scalar(author_id) == clean_scalar(requester)
                else normalize_author(first(event, "author.role", "author_type"), default="agent")
            )
            if event.get("public") is False and author == "agent":
                author = "system"
            messages.append(
                {
                    "author": author,
                    "sent_at": parse_datetime(
                        first(event, "created_at", "timestamp", default=opened),
                        field="message.sent_at",
                    ),
                    "text": plain_text(body),
                    "redacted": False,
                }
            )
        if not messages and first(record, "description", "subject") is not None:
            messages.append(
                {
                    "author": "customer",
                    "sent_at": opened,
                    "text": plain_text(first(record, "description", "subject")),
                    "redacted": False,
                }
            )

        status = clean_scalar(record.get("status")).casefold()
        resolution = None
        if status in {"solved", "closed"}:
            agent_messages = [message for message in messages if message["author"] == "agent"]
            resolution = {
                "resolved_at": parse_datetime(
                    first(record, "solved_at", "closed_at", "updated_at", default=opened),
                    field="resolution.resolved_at",
                ),
                "original_label": nullable(first(record, "type", "ticket_type", "form.name")),
                "actions": [status],
                "closing_text": agent_messages[-1]["text"] if agent_messages else "",
            }

        metadata = {
            "priority": record.get("priority"),
            "tags": record.get("tags") or [],
            "custom_fields": custom_fields(record.get("custom_fields")),
        }
        facts = linked_facts(
            record,
            opened_at=opened,
            containers=(
                ("orders", "orders", "order"),
                ("charges", "billing", "charge"),
                ("subscriptions", "billing", "subscription"),
                ("account_records", "account", "account"),
            ),
        )
        return self._finalize(
            interaction_id=first(record, "id", "ticket_id"),
            raw_customer_id=requester,
            opened_at=opened,
            channel=first(record, "via.channel", "channel", default="web"),
            messages=messages,
            state_snapshot=facts,
            resolution=resolution,
            metadata=metadata,
        )


def nullable(value: Any) -> str | None:
    text = clean_scalar(value)
    return text or None

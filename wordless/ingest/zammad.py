"""Streaming, read-only Zammad ticket export adapter."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any, ClassVar

from wordless.core.models import Interaction

from ._vendor import custom_fields, linked_facts, list_at, plain_text, vendor_file, vendor_records
from .base import Adapter, clean_scalar, normalize_author, parse_datetime
from .formats import first, peek_keys


class ZammadAdapter(Adapter):
    source_system: ClassVar[str] = "zammad"
    _NAMES = ("tickets.json", "tickets.jsonl", "zammad.json", "zammad.jsonl")

    def detect(self, path: Path) -> bool:
        try:
            export_file = vendor_file(Path(path), self._NAMES)
        except (OSError, ValueError):
            return False
        if "zammad" in export_file.name.casefold():
            return True
        keys = peek_keys(export_file)
        return "articles" in keys and bool(keys & {"state", "state_id", "customer_id"})

    def load(self, path: Path) -> Iterator[Interaction]:
        for record in vendor_records(path, names=self._NAMES, root_keys=("tickets", "data")):
            yield self._normalize(record)

    def _normalize(self, record: Mapping[str, Any]) -> Interaction:
        ticket = record.get("ticket") if isinstance(record.get("ticket"), Mapping) else record
        opened = parse_datetime(first(ticket, "created_at", "opened_at"), field="opened_at")
        customer_id = first(ticket, "customer_id", "customer.id", "customer.email")
        articles = list_at(record, "articles", "ticket.articles")
        messages: list[dict[str, Any]] = []
        for article in articles:
            if not isinstance(article, Mapping):
                continue
            body = first(article, "body", "content", "text")
            if body is None:
                continue
            sender = first(article, "sender.name", "sender", "sender_id", "created_by.role")
            sender_text = clean_scalar(sender).casefold()
            if clean_scalar(customer_id) and clean_scalar(
                first(article, "created_by_id", "customer_id")
            ) == clean_scalar(customer_id):
                author = "customer"
            elif "customer" in sender_text:
                author = "customer"
            else:
                author = normalize_author(sender, default="agent")
            if article.get("internal") is True:
                author = "system"
            messages.append(
                {
                    "author": author,
                    "sent_at": parse_datetime(
                        first(article, "created_at", "updated_at", default=opened),
                        field="message.sent_at",
                    ),
                    "text": plain_text(body),
                    "redacted": False,
                }
            )
        if not messages and ticket.get("title"):
            messages.append(
                {
                    "author": "customer",
                    "sent_at": opened,
                    "text": plain_text(ticket["title"]),
                    "redacted": False,
                }
            )

        raw_state = first(ticket, "state.name", "state", "status")
        if isinstance(raw_state, Mapping):
            raw_state = raw_state.get("name")
        state = clean_scalar(raw_state).casefold()
        resolution = None
        if state in {"closed", "resolved", "merged"}:
            agents = [message for message in messages if message["author"] == "agent"]
            resolution = {
                "resolved_at": parse_datetime(
                    first(ticket, "close_at", "closed_at", "updated_at", default=opened),
                    field="resolution.resolved_at",
                ),
                "original_label": nullable(first(ticket, "type", "category", "group.name")),
                "actions": [state],
                "closing_text": agents[-1]["text"] if agents else "",
            }
        facts = linked_facts(
            record,
            opened_at=opened,
            containers=(
                ("ticket.orders", "orders", "order"),
                ("ticket.charges", "billing", "charge"),
                ("ticket.subscriptions", "billing", "subscription"),
                ("ticket.account", "account", "account"),
            ),
        )
        return self._finalize(
            interaction_id=first(ticket, "id", "number"),
            raw_customer_id=customer_id,
            opened_at=opened,
            channel=first(ticket, "article_type", "channel", default="web"),
            messages=messages,
            state_snapshot=facts,
            resolution=resolution,
            metadata={
                "group": first(ticket, "group.name", "group"),
                "priority": first(ticket, "priority.name", "priority"),
                "custom_fields": custom_fields(ticket.get("custom_fields")),
            },
        )


def nullable(value: Any) -> str | None:
    text = clean_scalar(value)
    return text or None

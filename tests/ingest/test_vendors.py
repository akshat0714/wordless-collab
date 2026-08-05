from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from wordless.ingest import ChatwootAdapter, IntercomAdapter, ZammadAdapter, ZendeskAdapter


@pytest.mark.parametrize(
    ("adapter_type", "record", "expected_channel"),
    [
        (
            ZendeskAdapter,
            {
                "id": 10,
                "requester_id": 7,
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T01:00:00Z",
                "status": "solved",
                "via": {"channel": "email"},
                "comments": [
                    {
                        "author_id": 7,
                        "created_at": "2026-01-01T00:00:00Z",
                        "body": "Email me at person@example.com",
                    },
                    {
                        "author_id": 9,
                        "created_at": "2026-01-01T01:00:00Z",
                        "body": "I can see two charges of $84.00.",
                    },
                ],
                "charges": [
                    {
                        "created_at": "2025-12-31T23:00:00Z",
                        "amount": "$84.00",
                        "status": "succeeded",
                    }
                ],
            },
            "email",
        ),
        (
            IntercomAdapter,
            {
                "id": "i-1",
                "created_at": 1_767_225_600,
                "closed_at": 1_767_229_200,
                "state": "closed",
                "contacts": {"contacts": [{"id": "contact-1"}]},
                "source": {
                    "body": "person@example.com",
                    "created_at": 1_767_225_600,
                    "author": {"type": "user"},
                    "delivered_as": "chat",
                },
                "conversation_parts": {
                    "conversation_parts": [
                        {
                            "body": "Resolved",
                            "created_at": 1_767_229_200,
                            "author": {"type": "admin"},
                        }
                    ]
                },
            },
            "chat",
        ),
        (
            ChatwootAdapter,
            {
                "id": 22,
                "created_at": 1_767_225_600,
                "updated_at": 1_767_229_200,
                "status": "resolved",
                "contact": {"id": 8},
                "inbox": {"channel_type": "Channel::WebWidget"},
                "messages": [
                    {"message_type": 0, "created_at": 1_767_225_600, "content": "person@example.com"},
                    {"message_type": 1, "created_at": 1_767_229_200, "content": "Resolved"},
                ],
            },
            "chat",
        ),
        (
            ZammadAdapter,
            {
                "id": 33,
                "customer_id": 12,
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T01:00:00Z",
                "state": "closed",
                "channel": "web",
                "articles": [
                    {
                        "created_by_id": 12,
                        "created_at": "2026-01-01T00:00:00Z",
                        "body": "person@example.com",
                    },
                    {
                        "sender": "agent",
                        "created_at": "2026-01-01T01:00:00Z",
                        "body": "Resolved",
                    },
                ],
            },
            "web",
        ),
    ],
)
def test_vendor_adapter_normalizes_and_redacts(
    tmp_path: Path,
    adapter_type: type,
    record: dict[str, Any],
    expected_channel: str,
) -> None:
    path = tmp_path / f"{adapter_type.source_system}.jsonl"
    path.write_text(json.dumps(record) + "\n", encoding="utf-8")
    adapter = adapter_type(corpus_salt="salt")

    assert adapter.detect(path)
    interaction = next(adapter.load(path))

    assert interaction.source_system == adapter_type.source_system
    assert interaction.channel == expected_channel
    assert interaction.resolution is not None
    assert all(message.redacted for message in interaction.messages)
    assert "person@example.com" not in interaction.model_dump_json()
    assert adapter.redaction_report.entity_counts["EMAIL_ADDRESS"] == 1


def test_fixed_adapters_expose_no_customer_mutation_methods() -> None:
    forbidden = {"create", "update", "delete", "write", "send", "close_ticket", "reply"}
    for adapter_type in (ZendeskAdapter, IntercomAdapter, ChatwootAdapter, ZammadAdapter):
        assert forbidden.isdisjoint(adapter_type.__dict__)


def test_vendor_adapter_excludes_timestamp_less_current_state(
    tmp_path: Path,
) -> None:
    record = {
        "id": 10,
        "requester_id": 7,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T01:00:00Z",
        "status": "solved",
        "via": {"channel": "email"},
        "comments": [
            {
                "author_id": 7,
                "created_at": "2026-01-01T00:00:00Z",
                "body": "money one twice",
            }
        ],
        "charges": [
            {"amount": "$84.00", "status": "succeeded"},
            {"amount": "$84.00", "status": "succeeded"},
        ],
    }
    path = tmp_path / "zendesk.jsonl"
    path.write_text(json.dumps(record) + "\n", encoding="utf-8")

    interaction = next(ZendeskAdapter(corpus_salt="salt").load(path))

    assert interaction.state_snapshot == []

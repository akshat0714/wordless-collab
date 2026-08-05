from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from wordless.core.models import (
    Interaction,
    Message,
    Resolution,
    StateFact,
    hash_customer_key,
)


OPENED = datetime(2026, 1, 10, 12, tzinfo=timezone.utc)


_DEFAULT_KEY = object()


def _interaction(
    *,
    facts: list[StateFact] | None = None,
    customer_key: str | object = _DEFAULT_KEY,
) -> Interaction:
    return Interaction(
        id="ticket-1",
        customer_key=(
            hash_customer_key("customer-1", b"corpus salt")
            if customer_key is _DEFAULT_KEY
            else customer_key
        ),
        opened_at=OPENED,
        channel="chat",
        messages=[Message(author="customer", sent_at=OPENED, text="money twice")],
        state_snapshot=[] if facts is None else facts,
        resolution=Resolution(
            resolved_at=OPENED + timedelta(hours=1),
            original_label=None,
            actions=["refunded duplicate"],
            closing_text="The second charge was refunded.",
        ),
        source_system="fixture",
    )


def _fact(occurred_at: datetime) -> StateFact:
    return StateFact(
        source="billing",
        kind="charge",
        occurred_at=occurred_at,
        fields={"amount": 84.0},
        provenance="exported",
    )


def test_interaction_accepts_state_from_before_or_exactly_at_opening() -> None:
    interaction = _interaction(
        facts=[_fact(OPENED - timedelta(seconds=1)), _fact(OPENED)]
    )

    assert len(interaction.state_snapshot) == 2


def test_interaction_rejects_a_single_post_opening_fact() -> None:
    with pytest.raises(ValidationError, match="temporal leakage"):
        _interaction(facts=[_fact(OPENED + timedelta(microseconds=1))])


def test_interaction_rejects_mixed_naive_and_aware_state_timestamps() -> None:
    with pytest.raises(ValidationError, match="consistent timezone awareness"):
        _interaction(facts=[_fact(OPENED.replace(tzinfo=None))])


@pytest.mark.parametrize(
    "raw_key",
    [
        "customer@example.com",
        "customer-123",
        "",
        "a" * 63,
        "a" * 64,
        "g" * 64,
        f"sha256:{'a' * 64}",
        f"HMAC-SHA256:{'a' * 64}",
        f"hmac-sha256:{'a' * 63}",
    ],
)
def test_customer_key_rejects_raw_or_malformed_identifiers(raw_key: str) -> None:
    with pytest.raises(ValidationError, match="hmac-sha256"):
        _interaction(customer_key=raw_key)


def test_hash_customer_key_is_deterministic_and_scoped_to_corpus_salt() -> None:
    first = hash_customer_key("customer@example.com", b"first corpus")
    repeated = hash_customer_key("customer@example.com", b"first corpus")
    other_corpus = hash_customer_key("customer@example.com", b"second corpus")

    assert first == repeated
    assert first != other_corpus
    assert first.startswith("hmac-sha256:")
    assert "customer" not in first
    assert "first corpus" not in first
    assert _interaction(customer_key=first).customer_key == first


def test_hash_customer_key_rejects_empty_input_or_salt() -> None:
    with pytest.raises(ValueError, match="raw_identifier"):
        hash_customer_key("", "salt")
    with pytest.raises(ValueError, match="corpus_salt"):
        hash_customer_key("customer", "")


def test_hmac_sha256_digest_is_normalized_to_lowercase() -> None:
    interaction = _interaction(customer_key=f"hmac-sha256:{'A' * 64}")

    assert interaction.customer_key == f"hmac-sha256:{'a' * 64}"


def test_metadata_defaults_are_not_shared_and_unknown_fields_are_rejected() -> None:
    left = _interaction()
    right = _interaction()
    left.metadata["fixture"] = True

    assert right.metadata == {}
    with pytest.raises(ValidationError, match="extra_forbidden"):
        Interaction.model_validate({**right.model_dump(), "vendor_secret": "no"})

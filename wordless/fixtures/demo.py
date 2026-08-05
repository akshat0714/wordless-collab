"""A deterministic synthetic corpus for the end-to-end audit demo.

Every record is invented, redacted at construction, and labeled as synthetic
in metadata.  The corpus is a functional fixture, not evidence about real
customers, agents, organizations, accessibility, or production error rates.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal

from wordless.core.models import (
    Interaction,
    Message,
    Resolution,
    StateFact,
    hash_customer_key,
)


DEMO_ORGANIZATION = "Wordless synthetic fixture"
DEMO_CORPUS_NAME = "demo-synthetic-v1"
_BASE_TIME = datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)
_SYNTHETIC_SALT = b"wordless-demo-v1-synthetic-records-only"

Bucket = Literal["short", "medium", "long"]
DetectorId = Literal["duplicate_charge", "late_delivery", "wrong_item", "account_lock"]
Relation = Literal["matching", "contradictory"]


def _interaction_id(index: int) -> str:
    """Return a non-personal ID in the strict synthetic fixture namespace."""

    return f"demo-{index:03d}"


_FRAGMENTS: dict[Bucket, dict[DetectorId, str]] = {
    "short": {
        "duplicate_charge": "money one twice",
        "late_delivery": "still not come",
        "wrong_item": "order wrong thing help",
        "account_lock": "cannot get in",
    },
    "medium": {
        "duplicate_charge": "the card money appears two times on my account",
        "late_delivery": "the parcel should be here but it is not",
        "wrong_item": "the box has a different thing than I ordered",
        "account_lock": "the login keeps stopping me after I try it",
    },
    "long": {
        "duplicate_charge": "I checked the bank page this morning and the same purchase amount appears there two separate times",
        "late_delivery": "The tracking page has not changed and the package was supposed to reach my house several days ago",
        "wrong_item": "I opened the delivered box and found a blue mug even though the order page shows a blue kettle",
        "account_lock": "I remember the password now but the sign in page will not let me continue after the earlier attempts",
    },
}

_CLEAN_FRAGMENTS: dict[Bucket, tuple[str, str]] = {
    "short": ("where receipt", "need invoice please"),
    "medium": (
        "could you send the receipt for my recent purchase",
        "I need an invoice copy for the expense report",
    ),
    "long": (
        "I am preparing my monthly records and would like a copy of the receipt for the completed order",
        "Please send an itemized invoice for the purchase because our finance team needs it for reconciliation",
    ),
}

_MATCHING_RESOLUTIONS: dict[DetectorId, tuple[str, tuple[str, ...]]] = {
    "duplicate_charge": (
        "You were charged twice.",
        ("You were charged twice",),
    ),
    "late_delivery": (
        "Your delivery is late.",
        ("Your delivery is late",),
    ),
    "wrong_item": (
        "You received the wrong item.",
        ("You received the wrong item",),
    ),
    "account_lock": (
        "Your account is locked.",
        ("Your account is locked",),
    ),
}

_CONTRADICTORY_RESOLUTIONS: dict[DetectorId, tuple[str, str, tuple[str, ...]]] = {
    "duplicate_charge": (
        "return_policy",
        "We explained the standard return policy.",
        ("Shared the returns article",),
    ),
    "late_delivery": (
        "address_change",
        "We confirmed how to edit a future delivery address.",
        ("Shared address-change instructions",),
    ),
    "wrong_item": (
        "password_reset",
        "We sent instructions for choosing a new password.",
        ("Sent a password reset guide",),
    ),
    "account_lock": (
        "invoice_request",
        "We attached an itemized invoice for the purchase.",
        ("Sent an invoice copy",),
    ),
}


def _state_for(detector_id: DetectorId, opened_at: datetime, index: int) -> list[StateFact]:
    recent = opened_at - timedelta(hours=2)
    if detector_id == "duplicate_charge":
        amount = f"{80 + index}.00"
        return [
            StateFact(
                source="billing",
                kind="charge",
                occurred_at=recent,
                fields={
                    "charge_id": str(100_000 + index * 10 + 1),
                    "amount": amount,
                    "currency": "USD",
                    "status": "succeeded",
                },
                provenance="exported",
            ),
            StateFact(
                source="billing",
                kind="charge",
                occurred_at=recent + timedelta(minutes=6),
                fields={
                    "charge_id": str(100_000 + index * 10 + 2),
                    "amount": amount,
                    "currency": "USD",
                    "status": "succeeded",
                },
                provenance="exported",
            ),
        ]
    if detector_id == "late_delivery":
        return [
            StateFact(
                source="orders",
                kind="shipment",
                occurred_at=recent,
                fields={
                    "order_id": str(200_000 + index),
                    "status": "in_transit",
                    "expected_delivery_at": (opened_at - timedelta(days=2)).isoformat(),
                },
                provenance="exported",
            )
        ]
    if detector_id == "wrong_item":
        return [
            StateFact(
                source="orders",
                kind="order",
                occurred_at=recent,
                fields={
                    "order_id": str(200_000 + index),
                    "ordered_sku": "KETTLE-BLUE",
                    "delivered_sku": "MUG-BLUE",
                    "status": "delivered",
                },
                provenance="exported",
            )
        ]
    return [
        StateFact(
            source="account",
            kind="authentication",
            occurred_at=recent,
            fields={"status": "locked", "locked": True, "failed_attempts": 3 + index % 3},
            provenance="exported",
        )
    ]


def _clean_state(opened_at: datetime, index: int) -> list[StateFact]:
    return [
        StateFact(
            source="billing",
            kind="charge",
            occurred_at=opened_at - timedelta(days=1),
            fields={
                "charge_id": str(300_000 + index),
                "amount": "42.00",
                "currency": "USD",
                "status": "succeeded",
            },
            provenance="exported",
        ),
        StateFact(
            source="orders",
            kind="order",
            occurred_at=opened_at - timedelta(days=1),
            fields={
                "order_id": str(400_000 + index),
                "ordered_sku": "MUG-WHITE",
                "delivered_sku": "MUG-WHITE",
                "status": "delivered",
                "expected_delivery_at": (opened_at - timedelta(hours=12)).isoformat(),
            },
            provenance="exported",
        ),
        StateFact(
            source="account",
            kind="account",
            occurred_at=opened_at - timedelta(hours=1),
            fields={"status": "active", "locked": False, "failed_attempts": 0},
            provenance="exported",
        ),
    ]


def _interaction(
    *,
    index: int,
    bucket: Bucket,
    detector_id: DetectorId,
    relation: Relation,
) -> Interaction:
    opened_at = _BASE_TIME + timedelta(days=index)
    if relation == "matching":
        closing_text, actions = _MATCHING_RESOLUTIONS[detector_id]
        original_label = detector_id
        expected_outcome = "agreement@1"
    else:
        original_label, closing_text, actions = _CONTRADICTORY_RESOLUTIONS[detector_id]
        expected_outcome = "disagreement"
    return Interaction(
        id=_interaction_id(index),
        customer_key=hash_customer_key(f"synthetic-customer-{index}", _SYNTHETIC_SALT),
        opened_at=opened_at,
        channel=("chat", "email", "form", "web")[index % 4],
        messages=[
            Message(
                author="customer",
                sent_at=opened_at,
                text=_FRAGMENTS[bucket][detector_id],
                redacted=True,
            )
        ],
        state_snapshot=_state_for(detector_id, opened_at, index),
        resolution=Resolution(
            resolved_at=opened_at + timedelta(hours=1),
            original_label=original_label,
            actions=list(actions),
            closing_text=closing_text,
        ),
        source_system="wordless_synthetic_fixture",
        metadata={
            "data_classification": "synthetic_fixture",
            "fixture_name": DEMO_CORPUS_NAME,
            "synthetic": True,
            "fragment_bucket": bucket,
            "expected_detector": detector_id,
            "expected_resolution_relation": relation,
            "expected_replay_outcome": expected_outcome,
        },
    )


def _clean_interaction(*, index: int, bucket: Bucket, variant: int) -> Interaction:
    opened_at = _BASE_TIME + timedelta(days=index)
    return Interaction(
        id=_interaction_id(index),
        customer_key=hash_customer_key(f"synthetic-customer-{index}", _SYNTHETIC_SALT),
        opened_at=opened_at,
        channel=("chat", "email", "form", "web")[index % 4],
        messages=[
            Message(
                author="customer",
                sent_at=opened_at,
                text=_CLEAN_FRAGMENTS[bucket][variant],
                redacted=True,
            )
        ],
        state_snapshot=_clean_state(opened_at, index),
        resolution=Resolution(
            resolved_at=opened_at + timedelta(minutes=20),
            original_label="receipt_request" if variant == 0 else "invoice_request",
            actions=["Sent the requested document"],
            closing_text=(
                "We attached the requested receipt."
                if variant == 0
                else "We attached the requested invoice."
            ),
        ),
        source_system="wordless_synthetic_fixture",
        metadata={
            "data_classification": "synthetic_fixture",
            "fixture_name": DEMO_CORPUS_NAME,
            "synthetic": True,
            "fragment_bucket": bucket,
            "expected_detector": None,
            "expected_resolution_relation": "clean_account",
            "expected_replay_outcome": "abstain",
        },
    )


def demo_interactions() -> tuple[Interaction, ...]:
    """Return 30 fresh canonical interactions: 10 in each length bucket."""

    interactions: list[Interaction] = []
    index = 1
    for bucket in ("short", "medium", "long"):
        for detector_id in (
            "duplicate_charge",
            "late_delivery",
            "wrong_item",
            "account_lock",
        ):
            for relation in ("matching", "contradictory"):
                interactions.append(
                    _interaction(
                        index=index,
                        bucket=bucket,
                        detector_id=detector_id,
                        relation=relation,
                    )
                )
                index += 1
        for variant in range(2):
            interactions.append(_clean_interaction(index=index, bucket=bucket, variant=variant))
            index += 1
    return tuple(interactions)


__all__ = ["DEMO_CORPUS_NAME", "DEMO_ORGANIZATION", "demo_interactions"]

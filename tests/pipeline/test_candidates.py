from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from wordless.core.models import Interaction, Message, StateFact, hash_customer_key
from wordless.core.redact import Redactor
from wordless.pipeline.candidates import DEFAULT_DETECTORS, Detector, generate_hypotheses


FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "pipeline_interactions.json"


def _interactions() -> dict[str, Interaction]:
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return {item["id"]: Interaction.model_validate(item) for item in raw}


def _interaction_with_facts(
    interaction_id: str,
    opened_at: datetime,
    facts: list[StateFact],
) -> Interaction:
    return Interaction(
        id=interaction_id,
        customer_key=hash_customer_key("customer", "corpus salt"),
        opened_at=opened_at,
        channel="chat",
        messages=[
            Message(
                author="customer",
                sent_at=opened_at,
                text="Can you check this?",
                redacted=True,
            )
        ],
        state_snapshot=facts,
        resolution=None,
        source_system="fixture",
    )


def test_confirmed_detectors_match_each_evidence_fixture() -> None:
    interactions = _interactions()

    for interaction_id, detector_id in (
        ("duplicate-charge", "duplicate_charge"),
        ("late-delivery", "late_delivery"),
        ("wrong-item", "wrong_item"),
        ("account-lock", "account_lock"),
    ):
        hypotheses = generate_hypotheses(interactions[interaction_id])
        assert [hypothesis.detector_id for hypothesis in hypotheses] == [detector_id]
        assert hypotheses[0].evidence
        assert hypotheses[0].detail.endswith(".")


def test_clean_account_produces_zero_hypotheses() -> None:
    assert generate_hypotheses(_interactions()["clean-account"]) == ()


def test_unconfirmed_detector_never_runs() -> None:
    interaction = _interactions()["duplicate-charge"]
    approved = next(item for item in DEFAULT_DETECTORS if item.id == "duplicate_charge")
    proposed = Detector(**{**approved.model_dump(), "confirmed": False})

    assert generate_hypotheses(interaction, detectors=(proposed,)) == ()


def test_aggregate_duplicate_requires_successful_charge_status() -> None:
    opened = datetime(2026, 1, 1, tzinfo=UTC)

    def value(status: str | None) -> Interaction:
        fields: dict[str, object] = {"amount": "84.00", "currency": "USD", "count": 2}
        if status is not None:
            fields["status"] = status
        return Interaction(
            id=f"aggregate-{status or 'unknown'}",
            customer_key=hash_customer_key("customer", "corpus salt"),
            opened_at=opened,
            channel="chat",
            messages=[
                Message(
                    author="agent",
                    sent_at=opened,
                    text="I can see two charges of $84.",
                    redacted=True,
                )
            ],
            state_snapshot=[
                StateFact(
                    source="billing",
                    kind="charge",
                    occurred_at=opened,
                    fields=fields,
                    provenance="reconstructed",
                )
            ],
            resolution=None,
            source_system="fixture",
        )

    assert generate_hypotheses(value(None)) == ()
    assert generate_hypotheses(value("declined")) == ()
    hypotheses = generate_hypotheses(value("succeeded"))
    assert [item.detector_id for item in hypotheses] == ["duplicate_charge"]


def test_product_reference_tokenization_retains_wrong_item_signal() -> None:
    opened = datetime(2026, 1, 1, tzinfo=UTC)
    raw = Interaction(
        id="product-reference-mismatch",
        customer_key=hash_customer_key("customer", "corpus salt"),
        opened_at=opened,
        channel="chat",
        messages=[
            Message(author="customer", sent_at=opened, text="wrong thing", redacted=True)
        ],
        state_snapshot=[
            StateFact(
                source="orders",
                kind="fulfillment",
                occurred_at=opened,
                fields={
                    "ordered_product": "Turbo Kettle",
                    "ordered_sku": "KETTLE-100",
                    "received_product": "Travel Sleeve",
                    "received_sku": "SLEEVE-200",
                },
                provenance="exported",
            )
        ],
        resolution=None,
        source_system="fixture",
    )
    interaction, _report = Redactor().redact_interaction(raw)

    serialized = interaction.model_dump_json()
    assert "Turbo Kettle" not in serialized
    assert "Travel Sleeve" not in serialized
    hypotheses = generate_hypotheses(interaction)
    assert [item.detector_id for item in hypotheses] == ["wrong_item"]
    assert "product-ref:KETTLE-100" in hypotheses[0].detail
    assert "product-ref:SLEEVE-200" in hypotheses[0].detail


def test_equal_charges_for_different_orders_are_not_duplicates() -> None:
    opened = datetime(2026, 1, 1, 12, tzinfo=UTC)
    facts = [
        StateFact(
            source="billing",
            kind="charge",
            occurred_at=datetime(2026, 1, 1, 10, minute, tzinfo=UTC),
            fields={
                "charge_id": f"ch_{minute}",
                "order_id": f"ord_{minute}",
                "amount": "84.00",
                "currency": "USD",
                "status": "succeeded",
            },
            provenance="exported",
        )
        for minute in (1, 2)
    ]

    assert generate_hypotheses(
        _interaction_with_facts("different-orders", opened, facts)
    ) == ()


def test_latest_delivered_state_supersedes_an_old_overdue_state() -> None:
    opened = datetime(2026, 1, 5, 12, tzinfo=UTC)
    facts = [
        StateFact(
            source="shipping",
            kind="shipment",
            occurred_at=datetime(2026, 1, 3, 12, tzinfo=UTC),
            fields={
                "shipment_id": "ship_1",
                "order_id": "ord_1",
                "status": "overdue",
                "expected_delivery_at": "2026-01-02T12:00:00Z",
            },
            provenance="exported",
        ),
        StateFact(
            source="shipping",
            kind="shipment",
            occurred_at=datetime(2026, 1, 4, 12, tzinfo=UTC),
            fields={
                "shipment_id": "ship_1",
                "order_id": "ord_1",
                "status": "delivered",
                "expected_delivery_at": "2026-01-02T12:00:00Z",
            },
            provenance="exported",
        ),
    ]

    assert generate_hypotheses(
        _interaction_with_facts("delivered-latest", opened, facts)
    ) == ()


def test_delivered_sibling_shipment_does_not_hide_an_overdue_shipment() -> None:
    opened = datetime(2026, 1, 5, 12, tzinfo=UTC)
    facts = [
        StateFact(
            source="shipping",
            kind="shipment",
            occurred_at=datetime(2026, 1, 4, 12, tzinfo=UTC),
            fields={
                "shipment_id": "ship_delivered",
                "order_id": "ord_multi",
                "status": "delivered",
            },
            provenance="exported",
        ),
        StateFact(
            source="shipping",
            kind="shipment",
            occurred_at=datetime(2026, 1, 3, 12, tzinfo=UTC),
            fields={
                "shipment_id": "ship_overdue",
                "order_id": "ord_multi",
                "status": "overdue",
                "expected_delivery_at": "2026-01-02T12:00:00Z",
            },
            provenance="exported",
        ),
    ]

    hypotheses = generate_hypotheses(
        _interaction_with_facts("sibling-shipments", opened, facts)
    )

    assert [item.detector_id for item in hypotheses] == ["late_delivery"]
    assert hypotheses[0].evidence[0].fields["shipment_id"] == "ship_overdue"


def test_locked_account_with_fewer_than_three_attempts_does_not_match() -> None:
    opened = datetime(2026, 1, 1, 12, tzinfo=UTC)
    fact = StateFact(
        source="authentication",
        kind="account",
        occurred_at=opened,
        fields={
            "account_id": "acct_1",
            "status": "locked",
            "locked": True,
            "failed_attempts": 2,
        },
        provenance="exported",
    )

    assert generate_hypotheses(
        _interaction_with_facts("two-attempt-lock", opened, [fact])
    ) == ()


def test_latest_corrected_fulfillment_supersedes_old_wrong_item_state() -> None:
    opened = datetime(2026, 1, 3, 12, tzinfo=UTC)
    facts = [
        StateFact(
            source="orders",
            kind="fulfillment",
            occurred_at=datetime(2026, 1, 1, 12, tzinfo=UTC),
            fields={
                "order_id": "ord_1",
                "ordered_sku": "sku_a",
                "delivered_sku": "sku_b",
                "status": "wrong_item",
            },
            provenance="exported",
        ),
        StateFact(
            source="orders",
            kind="fulfillment",
            occurred_at=datetime(2026, 1, 2, 12, tzinfo=UTC),
            fields={
                "order_id": "ord_1",
                "ordered_sku": "sku_a",
                "delivered_sku": "sku_a",
                "status": "delivered",
            },
            provenance="exported",
        ),
    ]

    assert generate_hypotheses(
        _interaction_with_facts("corrected-fulfillment", opened, facts)
    ) == ()

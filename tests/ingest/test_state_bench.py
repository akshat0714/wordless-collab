from __future__ import annotations

import json
from pathlib import Path
import shutil

import pytest

from wordless.core.redact import Redactor
from wordless.ingest import ADAPTER_TYPES, StateBenchCustomerSupportAdapter
from wordless.ingest.base import AdapterError
from wordless.ingest.state_bench import (
    STATE_BENCH_ARCHIVE_SHA256,
    STATE_BENCH_COMMIT,
    STATE_BENCH_LICENSE,
    STATE_BENCH_VERSION,
    normalize_shipment_status,
)
from wordless.pipeline.candidates import DEFAULT_DETECTORS, evaluate_detector


FIXTURE = Path(__file__).parents[1] / "fixtures" / "ingest" / "state_bench"
PINNED = Path(".wordless/public/state-bench-v0.8.1")
LATE_DELIVERY = next(
    detector for detector in DEFAULT_DETECTORS if detector.id == "late_delivery"
)


def adapter() -> StateBenchCustomerSupportAdapter:
    return StateBenchCustomerSupportAdapter(
        corpus_salt="state-bench-fixture-test-salt",
    )


def test_detect_requires_join_directories_and_authoritative_split() -> None:
    value = adapter()
    trajectory = (
        FIXTURE
        / "datasets/train_task_trajectories/customer_support"
        / "149-hard_cancel_delivered_pivot_return.json"
    )
    assert value.detect(FIXTURE)
    assert value.detect(trajectory)
    assert not value.detect(FIXTURE.parent)


def test_joins_by_task_id_maps_logical_time_and_excludes_runtime_oracles() -> None:
    value = adapter()
    interactions = list(value.load(FIXTURE))

    assert [item.id for item in interactions] == [
        "state-bench:customer_support:9-hard_edge_post_return_restocking_fee_reversal_denied",
        "state-bench:customer_support:149-hard_cancel_delivered_pivot_return",
    ]
    interaction = interactions[1]
    assert interaction.source_system == "state_bench_customer_support"
    assert interaction.channel == "chat"
    assert interaction.opened_at.isoformat() == "2026-07-08T10:00:00+00:00"
    assert interaction.customer_key.startswith("hmac-sha256:")
    assert all(message.sent_at == interaction.opened_at for message in interaction.messages)
    assert [message.author for message in interaction.messages] == [
        "system",
        "customer",
        "agent",
        "customer",
    ]
    assert all(message.redacted for message in interaction.messages)
    assert "Alice Smith" not in interaction.model_dump_json()
    assert "<PERSON>" in interaction.messages[1].text
    assert all("[TASK_DONE]" not in message.text for message in interaction.messages)

    assert len(interaction.state_snapshot) == 2
    account = next(fact for fact in interaction.state_snapshot if fact.kind == "customer_account")
    assert account.source == "account"
    assert account.provenance == "exported"
    assert account.occurred_at == interaction.opened_at
    assert account.fields == {"record_present": True}
    fact = next(fact for fact in interaction.state_snapshot if fact.kind == "shipment")
    assert fact.source == "shipping"
    assert fact.kind == "shipment"
    assert fact.provenance == "exported"
    assert fact.occurred_at == interaction.opened_at
    assert fact.fields == {
        "order_id": "ORD-7262",
        "status": "processing",
        "order_status": "processing",
        "shipping_status": "processing",
        "promised_delivery_at": "2026-06-05T18:00:00",
    }

    assert interaction.resolution is not None
    assert interaction.resolution.resolved_at == interaction.opened_at
    assert interaction.resolution.original_label is None
    assert interaction.resolution.actions == ["cancel_order"]
    assert (
        interaction.resolution.closing_text
        == "I canceled the phone case and issued the corresponding refund."
    )

    assert interaction.metadata == {
        "task_id": "149-hard_cancel_delivered_pivot_return",
        "dataset_split": "train",
        "dataset_version": STATE_BENCH_VERSION,
        "source_url": (
            "https://github.com/microsoft/STATE-Bench/tree/" + STATE_BENCH_COMMIT
        ),
        "source_commit": STATE_BENCH_COMMIT,
        "source_archive_sha256": STATE_BENCH_ARCHIVE_SHA256,
        "license_name": STATE_BENCH_LICENSE,
        "license_url": (
            "https://github.com/microsoft/STATE-Bench/blob/"
            + STATE_BENCH_COMMIT
            + "/LICENSE"
        ),
        "temporal_granularity": "task_now",
    }
    forbidden_keys = {
        "opening_message",
        "task_summary",
        "task_type",
        "user_simulator",
        "task_requirements",
        "state_requirements",
        "state_diff",
        "scores",
        "task_completion_pass",
    }
    assert forbidden_keys.isdisjoint(interaction.metadata)
    serialized = interaction.model_dump_json()
    assert "DO_NOT_LEAK" not in serialized


def test_closed_order_status_overrides_stale_shipping_status_and_error_is_not_action() -> None:
    interaction = list(adapter().load(FIXTURE))[0]

    assert [message.author for message in interaction.messages] == [
        "system",
        "customer",
        "agent",
    ]
    assert all(message.text for message in interaction.messages)
    # The foreign customer's deliberately-lost order is excluded as well.
    assert len(interaction.state_snapshot) == 2
    fact = next(fact for fact in interaction.state_snapshot if fact.kind == "shipment")
    assert fact.fields["order_status"] == "fully_returned"
    assert fact.fields["shipping_status"] == "lost"
    assert fact.fields["status"] == "returned"
    assert (
        evaluate_detector(
            LATE_DELIVERY,
            interaction.state_snapshot,
            as_of=interaction.opened_at,
        )
        is None
    )
    assert interaction.resolution is not None
    assert interaction.resolution.original_label is None
    assert interaction.resolution.actions == []


def test_nonclosed_overdue_shipment_is_detector_eligible() -> None:
    interaction = list(adapter().load(FIXTURE))[1]
    hypothesis = evaluate_detector(
        LATE_DELIVERY,
        interaction.state_snapshot,
        as_of=interaction.opened_at,
    )
    assert hypothesis is not None
    assert [fact.fields["order_id"] for fact in hypothesis.evidence] == ["ORD-7262"]


def test_product_catalog_cannot_install_a_free_text_name_bypass(tmp_path: Path) -> None:
    copied = tmp_path / "state-bench"
    shutil.copytree(FIXTURE, copied)
    task_id = "149-hard_cancel_delivered_pivot_return"
    env_path = (
        copied
        / "state_bench/domains/customer_support/task_envs"
        / f"{task_id}.json"
    )
    environment = json.loads(env_path.read_text(encoding="utf-8"))
    environment["products"] = [
        {"product_id": "PROD-1", "name": "ProBook Travel Sleeve"}
    ]
    env_path.write_text(json.dumps(environment), encoding="utf-8")
    trajectory_path = (
        copied
        / "datasets/train_task_trajectories/customer_support"
        / f"{task_id}.json"
    )
    trajectory = json.loads(trajectory_path.read_text(encoding="utf-8"))
    trajectory["conversation"][1]["content"] = (
        "My name is Alice Smith. Cancel the ProBook Travel Sleeve."
    )
    trajectory_path.write_text(json.dumps(trajectory), encoding="utf-8")

    value = StateBenchCustomerSupportAdapter(corpus_salt="product-name-test-salt")
    interaction = next(
        item for item in value.load(copied) if item.metadata["task_id"] == task_id
    )

    assert "ProBook Travel Sleeve" not in interaction.messages[1].text
    assert "Alice Smith" not in interaction.messages[1].text


@pytest.mark.parametrize(
    ("order", "expected"),
    [
        ({"status": "fully_returned", "shipping_status": "lost"}, "returned"),
        ({"status": "canceled", "shipping_status": "in_transit"}, "cancelled"),
        ({"status": "delivered", "shipping_status": "damaged"}, "delivered"),
        ({"status": "shipped", "shipping_status": "in-transit"}, "in_transit"),
        ({"status": "processing", "shipping_status": ""}, "processing"),
    ],
)
def test_status_normalization_is_conservative(order: dict[str, str], expected: str) -> None:
    assert normalize_shipment_status(order) == expected


def test_public_fixture_adapter_is_not_in_sellable_registry() -> None:
    assert StateBenchCustomerSupportAdapter not in ADAPTER_TYPES


def test_split_manifest_must_exactly_match_trajectory_ids(tmp_path: Path) -> None:
    copied = tmp_path / "state-bench"
    shutil.copytree(FIXTURE, copied)
    split_path = (
        copied / "state_bench/domains/customer_support/splits/train_test.json"
    )
    split = json.loads(split_path.read_text(encoding="utf-8"))
    split["splits"]["train"].append("777-missing")
    split_path.write_text(json.dumps(split), encoding="utf-8")

    with pytest.raises(AdapterError, match="do not match splits.train"):
        next(adapter().load(copied))


def test_task_definition_must_match_filename_join(tmp_path: Path) -> None:
    copied = tmp_path / "state-bench"
    shutil.copytree(FIXTURE, copied)
    task_path = (
        copied
        / "state_bench/domains/customer_support/tasks"
        / "9-hard_edge_post_return_restocking_fee_reversal_denied.json"
    )
    task = json.loads(task_path.read_text(encoding="utf-8"))
    task["task_id"] = "different-task"
    task_path.write_text(json.dumps(task), encoding="utf-8")

    with pytest.raises(AdapterError, match="task ID mismatch"):
        next(adapter().load(copied))


@pytest.mark.skipif(
    not (PINNED / "datasets/train_task_trajectories/customer_support").is_dir(),
    reason="pinned STATE-Bench corpus has not been downloaded",
)
def test_pinned_corpus_joins_100_trajectories_with_ten_late_candidates() -> None:
    value = adapter()
    interactions = list(value.load(PINNED))

    assert len(interactions) == 100
    assert all(item.metadata["dataset_version"] == STATE_BENCH_VERSION for item in interactions)
    assert all(item.metadata["temporal_granularity"] == "task_now" for item in interactions)
    assert all(item.resolution is not None for item in interactions)
    assert all(item.state_snapshot for item in interactions)
    assert all(
        sum(fact.kind == "customer_account" for fact in item.state_snapshot) == 1
        for item in interactions
    )
    assert all(item.resolution.original_label is None for item in interactions if item.resolution)
    assert all(
        "[TASK_DONE]" not in message.text
        for item in interactions
        for message in item.messages
    )
    assert (
        sum(
            evaluate_detector(
                LATE_DELIVERY,
                item.state_snapshot,
                as_of=item.opened_at,
            )
            is not None
            for item in interactions
        )
        == 10
    )
    assert sum(len(item.resolution.actions) for item in interactions if item.resolution) == 115

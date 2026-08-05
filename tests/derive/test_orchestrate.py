from __future__ import annotations

from datetime import UTC, datetime, timedelta
import json

import numpy as np
import pytest

from wordless.core.llm import LLMClient
from wordless.core.models import Interaction, Message, StateFact, hash_customer_key
from wordless.core.redact import Redactor
from wordless.derive.orchestrate import run_derivation


def _interaction(index: int, intent: str, *, include_email: bool = False) -> Interaction:
    opened_at = datetime(2026, 1, 1, tzinfo=UTC)
    if intent == "duplicate_charge":
        text = "A duplicate charge appears twice on my account."
        state_snapshot = [
            StateFact(
                source="billing",
                kind="charge",
                occurred_at=opened_at - timedelta(minutes=30),
                fields={
                    "charge_id": str(100_000 + index * 10 + 1),
                    "status": "succeeded",
                    "amount": "12.00",
                    "currency": "USD",
                },
                provenance="exported",
            ),
            StateFact(
                source="billing",
                kind="charge",
                occurred_at=opened_at - timedelta(minutes=5),
                fields={
                    "charge_id": str(100_000 + index * 10 + 2),
                    "status": "succeeded",
                    "amount": "12.00",
                    "currency": "USD",
                },
                provenance="exported",
            ),
        ]
    else:
        text = "My delivery package is late."
        state_snapshot = [
            StateFact(
                source="orders",
                kind="shipment",
                occurred_at=opened_at - timedelta(hours=2),
                fields={
                    "order_id": str(200_000 + index),
                    "status": "in_transit",
                    "expected_delivery_at": (opened_at - timedelta(days=2)).isoformat(),
                },
                provenance="exported",
            )
        ]
    if include_email:
        text += " Contact alice@example.com."
    return Interaction(
        id=f"interaction-{index:06d}",
        customer_key=hash_customer_key(f"customer-{index}", "derive-test-salt"),
        opened_at=opened_at,
        channel="chat",
        messages=[
            Message(
                author="customer",
                sent_at=opened_at,
                text=text,
                # A forged flag must not bypass the orchestration rescan.
                redacted=True,
            )
        ],
        state_snapshot=state_snapshot,
        resolution=None,
        source_system="fixture",
    )


def _corpus(size_per_class: int = 12, *, include_email: bool = False):
    return tuple(
        [_interaction(index, "duplicate_charge", include_email=include_email) for index in range(size_per_class)]
        + [
            _interaction(index + size_per_class, "delivery", include_email=include_email)
            for index in range(size_per_class)
        ]
    )


def _prompt_payload(prompt: str) -> dict:
    return json.loads(prompt.rsplit("\n", 1)[-1])


class DerivationProvider:
    def __init__(self, *, malformed_labels: bool = False, leak_output: bool = False):
        self.malformed_labels = malformed_labels
        self.leak_output = leak_output
        self.requests = []

    def complete(self, request, *, model_id, timeout_seconds):
        del model_id, timeout_seconds
        self.requests.append(request)
        stage = request.metadata["stage"]
        if stage == "summarize":
            prefix = "alice@example.com says " if self.leak_output else ""
            if "duplicate charge" in request.prompt.casefold():
                return prefix + "Duplicate charge appears twice."
            return prefix + "Delivery package is late."
        if stage == "taxonomy":
            payload = _prompt_payload(request.prompt)
            groups = {
                "duplicate_charge": [
                    item["id"]
                    for item in payload["batch"]
                    if "charge" in item["summary"].casefold()
                ],
                "delivery": [
                    item["id"]
                    for item in payload["batch"]
                    if "delivery" in item["summary"].casefold()
                ],
            }
            labels = []
            if groups["duplicate_charge"]:
                labels.append(
                    {
                        "id": "duplicate_charge",
                        "name": "Duplicate charge",
                        "description": "A payment appears more than once.",
                        "support": len(groups["duplicate_charge"]),
                        "example_interaction_ids": groups["duplicate_charge"][:5],
                    }
                )
            if groups["delivery"]:
                labels.append(
                    {
                        "id": "delivery",
                        "name": "Delivery issue",
                        "description": "A shipment or package has not arrived on time.",
                        "support": len(groups["delivery"]),
                        "example_interaction_ids": groups["delivery"][:5],
                    }
                )
            return json.dumps(labels)
        if stage == "weak_label":
            payload = _prompt_payload(request.prompt)
            output = [
                {
                    "interaction_id": item["interaction_id"],
                    "label_id": (
                        "invented_label"
                        if self.malformed_labels
                        else (
                            "duplicate_charge"
                            if "charge" in item["summary"].casefold()
                            else "delivery"
                        )
                    ),
                }
                for item in payload["sample"]
            ]
            if self.leak_output:
                output[0]["private_note"] = "alice@example.com"
            return json.dumps(output)
        raise AssertionError(f"unexpected stage {stage}")


class IntentEmbedder:
    def __init__(self, *, forbidden: str | None = None):
        self.forbidden = forbidden
        self.inputs = []

    def encode(self, texts):
        self.inputs.extend(texts)
        if self.forbidden is not None:
            assert all(self.forbidden not in text for text in texts)
        return np.asarray(
            [[1.0, 0.0] if "charge" in text.casefold() else [0.0, 1.0] for text in texts],
            dtype=np.float32,
        )


def _client(provider, cache_dir) -> LLMClient:
    return LLMClient(
        provider=provider,
        provider_id="fixture",
        model_id="fixture/model",
        cache_dir=cache_dir,
        timeout_seconds=2,
        max_retries=0,
    )


def test_derivation_is_input_order_independent_and_predicts_full_corpus(tmp_path) -> None:
    corpus = _corpus()
    first_provider = DerivationProvider()
    second_provider = DerivationProvider()
    first = run_derivation(
        reversed(corpus),
        embedder=IntentEmbedder(),
        llm=_client(first_provider, tmp_path / "first"),
        sample_size=20,
        summary_batch_size=6,
        taxonomy_batch_size=50,
        label_batch_size=7,
        max_labels=2,
        seed=31,
    )
    second = run_derivation(
        corpus,
        embedder=IntentEmbedder(),
        llm=_client(second_provider, tmp_path / "second"),
        sample_size=20,
        summary_batch_size=6,
        taxonomy_batch_size=50,
        label_batch_size=7,
        max_labels=2,
        seed=31,
    )

    assert first.audit.model_dump(mode="json") == second.audit.model_dump(mode="json")
    assert len(first.audit.summary_batches) == 4
    assert [len(batch.interaction_ids) for batch in first.audit.summary_batches] == [6, 6, 6, 2]
    assert [len(batch.interaction_ids) for batch in first.audit.weak_label_batches] == [7, 7, 6]
    assert len(first.audit.predictions) == len(corpus)
    assert {prediction.label_id for prediction in first.audit.predictions} == {
        "delivery",
        "duplicate_charge",
    }
    assert first.audit.distillation_metrics.held_out_n == 5
    assert first.audit.distillation_metrics.held_out_correct == 5
    assert first.audit.human_ground_truth_used is False
    assert "not human-reviewed ground truth" in first.audit.truth_status
    assert all(not label.human_reviewed for label in first.audit.weak_labels)
    assert {
        outcome.taxonomy_label_id for outcome in first.audit.detector_outcomes
    } == {label.id for label in first.audit.taxonomy.labels}
    assert sum(
        outcome.member_count for outcome in first.audit.detector_outcomes
    ) == len(corpus)
    assert all(outcome.status == "proposed" for outcome in first.audit.detector_outcomes)
    assert all(
        outcome.proposal is not None
        and outcome.proposal.support == outcome.member_count
        and outcome.proposal.state_matches == outcome.member_count
        for outcome in first.audit.detector_outcomes
    )


def test_derivation_reuses_content_addressed_llm_cache(tmp_path) -> None:
    corpus = _corpus(size_per_class=5)
    provider = DerivationProvider()
    client = _client(provider, tmp_path / "cache")
    first = run_derivation(
        corpus,
        embedder=IntentEmbedder(),
        llm=client,
        summary_batch_size=3,
        taxonomy_batch_size=20,
        label_batch_size=4,
        max_labels=2,
    )
    calls_after_first = len(provider.requests)
    second = run_derivation(
        reversed(corpus),
        embedder=IntentEmbedder(),
        llm=client,
        summary_batch_size=3,
        taxonomy_batch_size=20,
        label_batch_size=4,
        max_labels=2,
    )

    assert len(provider.requests) == calls_after_first
    assert first.audit.sample_interaction_ids == second.audit.sample_interaction_ids
    assert [
        (item.interaction_id, item.text, item.interaction_hash)
        for item in first.audit.summaries
    ] == [
        (item.interaction_id, item.text, item.interaction_hash)
        for item in second.audit.summaries
    ]
    assert [item.label_id for item in first.audit.weak_labels] == [
        item.label_id for item in second.audit.weak_labels
    ]


def test_malformed_weak_labels_fall_back_or_fail_closed(tmp_path) -> None:
    corpus = _corpus(size_per_class=5)
    fallback = run_derivation(
        corpus,
        embedder=IntentEmbedder(),
        llm=_client(DerivationProvider(malformed_labels=True), tmp_path / "fallback"),
        taxonomy_batch_size=20,
        label_batch_size=4,
        max_labels=2,
        malformed_labels="fallback",
    )

    assert {item.label_id for item in fallback.audit.weak_labels} == {
        "delivery",
        "duplicate_charge",
    }
    assert all(
        item.source == "deterministic_fallback" for item in fallback.audit.weak_labels
    )
    assert all(batch.fallback_reason for batch in fallback.audit.weak_label_batches)
    assert all("invented_label" in (batch.model_output or "") for batch in fallback.audit.weak_label_batches)

    with pytest.raises(ValueError, match="weak-label batch 0 returned malformed"):
        run_derivation(
            corpus,
            embedder=IntentEmbedder(),
            llm=_client(DerivationProvider(malformed_labels=True), tmp_path / "reject"),
            taxonomy_batch_size=20,
            label_batch_size=4,
            max_labels=2,
            malformed_labels="raise",
        )


def test_offline_derivation_uses_explicit_deterministic_weak_labels() -> None:
    run = run_derivation(
        _corpus(size_per_class=4),
        embedder=IntentEmbedder(),
        max_labels=2,
        summary_batch_size=3,
        label_batch_size=3,
    )

    assert run.audit.taxonomy.method == "deterministic conservative offline rules"
    assert all(item.source == "deterministic_fallback" for item in run.audit.weak_labels)
    assert all(
        batch.fallback_reason == "no LLM client configured"
        for batch in run.audit.weak_label_batches
    )
    assert len(run.audit.predictions) == 8


def test_derivation_rescans_all_model_and_embedding_boundaries(tmp_path) -> None:
    corpus = _corpus(size_per_class=5, include_email=True)
    provider = DerivationProvider(leak_output=True)
    run = run_derivation(
        corpus,
        embedder=IntentEmbedder(forbidden="alice@example.com"),
        llm=_client(provider, tmp_path / "privacy"),
        taxonomy_batch_size=20,
        label_batch_size=4,
        max_labels=2,
    )

    assert provider.requests
    assert all("alice@example.com" not in request.prompt for request in provider.requests)
    serialized = json.dumps(run.audit.model_dump(mode="json"), sort_keys=True)
    assert "alice@example.com" not in serialized
    assert "<EMAIL_ADDRESS>" in serialized
    assert all(
        item.source == "deterministic_fallback" for item in run.audit.weak_labels
    )


def test_derivation_rejects_raw_boundaries_and_unredacted_members() -> None:
    corpus = _corpus(size_per_class=4)

    class RawClient:
        pass

    with pytest.raises(TypeError, match="concrete LLMClient"):
        run_derivation(
            corpus,
            embedder=IntentEmbedder(),
            llm=RawClient(),  # type: ignore[arg-type]
            max_labels=2,
        )
    with pytest.raises(ValueError, match="mandatory pinned Presidio"):
        run_derivation(
            corpus,
            embedder=IntentEmbedder(),
            redactor=Redactor(use_presidio=False),
            max_labels=2,
        )
    unsafe = list(corpus)
    unsafe[0].messages[0].redacted = False
    with pytest.raises(ValueError, match="unredacted"):
        run_derivation(unsafe, embedder=IntentEmbedder(), max_labels=2)

from datetime import UTC, datetime, timedelta

import numpy as np
import pytest
from pydantic import ValidationError

from wordless.core.models import Interaction, Message, StateFact, hash_customer_key
from wordless.derive.detectors import (
    DetectorDerivationOutcome,
    activate_approved_proposals,
    compile_approved_proposal,
    derive_detector_outcomes,
    detectors_yaml,
    load_detector_proposals_yaml,
    propose_detectors,
    review_detector,
)
from wordless.derive.distill import DistilledClassifier
from wordless.derive.summarize import summarize_interaction
from wordless.derive.taxonomy import build_taxonomy
from wordless.pipeline.candidates import evaluate_detector, generate_hypotheses
from wordless.pipeline.run import PipelineRunner


def interaction(
    redacted: bool = True,
    *,
    identifier: str = "i1",
    state_snapshot: list[StateFact] | None = None,
) -> Interaction:
    return Interaction(
        id=identifier,
        customer_key=hash_customer_key(identifier, "corpus salt"),
        opened_at=datetime(2026, 1, 1, tzinfo=UTC),
        channel="chat",
        messages=[Message(author="customer", sent_at=datetime(2026, 1, 1, tzinfo=UTC), text="money one twice", redacted=redacted)],
        state_snapshot=state_snapshot or [],
        resolution=None,
        source_system="fixture",
    )


def duplicate_charge_interaction(identifier: str = "i1") -> Interaction:
    opened_at = datetime(2026, 1, 1, tzinfo=UTC)
    return interaction(
        identifier=identifier,
        state_snapshot=[
            StateFact(
                source="payments",
                kind="charge",
                occurred_at=opened_at - timedelta(minutes=30),
                fields={
                    "charge_id": "1001",
                    "status": "succeeded",
                    "amount": "12.00",
                    "currency": "USD",
                },
                provenance="exported",
            ),
            StateFact(
                source="payments",
                kind="charge",
                occurred_at=opened_at - timedelta(minutes=5),
                fields={
                    "charge_id": "1002",
                    "status": "succeeded",
                    "amount": "12.00",
                    "currency": "USD",
                },
                provenance="exported",
            ),
        ],
    )


def test_summary_refuses_unredacted_and_falls_back_offline() -> None:
    with pytest.raises(ValueError, match="unredacted"):
        summarize_interaction(interaction(False))
    result = summarize_interaction(interaction())
    assert result.text == "money one twice."
    assert result.source == "fallback"


def test_summary_rescans_forged_flag_and_rejects_raw_llm_boundary() -> None:
    value = interaction()
    value.messages[0].text = "email alice@example.com"
    result = summarize_interaction(value)
    assert "alice@example.com" not in result.text
    assert "<EMAIL_ADDRESS>" in result.text

    class RawLLM:
        def generate(self, _request):
            raise AssertionError("raw model boundary must not run")

    with pytest.raises(TypeError, match="LLMClient"):
        summarize_interaction(value, llm=RawLLM())  # type: ignore[arg-type]


def test_taxonomy_valid_llm_json_and_raw_client_guard(tmp_path) -> None:
    from wordless.core.llm import LLMClient

    summary = summarize_interaction(interaction()).model_copy(
        update={"interaction_id": "alice@example.com"}
    )
    payload = (
        '[{"id":"billing","name":"Billing issue",'
        '"description":"A duplicate payment concern.","support":1,'
        '"example_interaction_ids":["redacted-interaction-000001"]}]'
    )
    client = LLMClient(
        provider=None,
        cache_dir=tmp_path,
        fallback=payload,
        offline=True,
    )
    taxonomy = build_taxonomy([summary], llm=client)
    assert taxonomy.labels[0].id == "billing"

    class RawLLM:
        def generate(self, _request):
            return None

    with pytest.raises(TypeError, match="LLMClient"):
        build_taxonomy([summary], llm=RawLLM())  # type: ignore[arg-type]


def test_taxonomy_iterates_merges_and_stops_at_saturation(tmp_path) -> None:
    from wordless.core.llm import LLMClient

    base = summarize_interaction(interaction())
    summaries = [
        base.model_copy(update={"interaction_id": f"i{index}", "text": f"case {index}"})
        for index in range(1, 9)
    ]
    responses = iter(
        [
            (
                '[{"id":"billing","name":"Billing issue",'
                '"description":"A payment concern in the batch.","support":2,'
                '"example_interaction_ids":["i1","i2"]}]'
            ),
            (
                '[{"id":"billing","name":"Billing issue",'
                '"description":"A payment concern in the batch.","support":1,'
                '"example_interaction_ids":["i3"]},'
                '{"id":"delivery","name":"Delivery issue",'
                '"description":"A shipment concern in the batch.","support":1,'
                '"example_interaction_ids":["i4"]}]'
            ),
            (
                '[{"id":"billing","name":"Billing issue",'
                '"description":"A payment concern in the batch.","support":1,'
                '"example_interaction_ids":["i5"]}]'
            ),
        ]
    )

    class SequencedProvider:
        def __init__(self):
            self.prompts = []

        def complete(self, request, *, model_id, timeout_seconds):
            self.prompts.append(request.prompt)
            return next(responses)

    provider = SequencedProvider()
    client = LLMClient(
        provider=provider,
        provider_id="fixture",
        model_id="fixture/model",
        cache_dir=tmp_path,
        timeout_seconds=1,
        max_retries=0,
    )
    taxonomy = build_taxonomy(summaries, llm=client, batch_size=2)

    assert len(provider.prompts) == 3
    assert all("i7" not in prompt and "i8" not in prompt for prompt in provider.prompts)
    assert taxonomy.sample_size == 6
    by_id = {label.id: label for label in taxonomy.labels}
    assert by_id["billing"].support == 4
    assert by_id["billing"].example_interaction_ids == ("i1", "i2", "i3", "i5")
    assert by_id["delivery"].support == 1
    assert "iterative LLM proposals" in taxonomy.method


def test_taxonomy_and_distillation_redact_before_model_boundaries(tmp_path) -> None:
    from wordless.core.llm import LLMClient

    class CapturingProvider:
        def __init__(self):
            self.prompts = []

        def complete(self, request, *, model_id, timeout_seconds):
            self.prompts.append(request.prompt)
            return "not json"

    provider = CapturingProvider()
    client = LLMClient(
        provider=provider,
        provider_id="fixture",
        model_id="fixture/model",
        cache_dir=tmp_path,
        timeout_seconds=1,
        max_retries=0,
        fallback="not json",
    )
    summary = summarize_interaction(interaction()).model_copy(
        update={"text": "Email alice@example.com about billing."}
    )
    build_taxonomy([summary], llm=client)
    assert provider.prompts
    assert "alice@example.com" not in provider.prompts[0]
    assert "<EMAIL_ADDRESS>" in provider.prompts[0]

    class InspectingEmbedder:
        def encode(self, texts):
            assert all("alice@example.com" not in text for text in texts)
            return np.asarray(
                [[1.0, 0.0] if "charge" in text else [0.0, 1.0] for text in texts],
                dtype=np.float32,
            )

    texts = [f"charge {index} alice@example.com" for index in range(10)] + [
        f"delivery {index} alice@example.com" for index in range(10)
    ]
    labels = ["billing"] * 10 + ["shipping"] * 10
    model = DistilledClassifier.fit(
        texts,
        labels,
        embedder=InspectingEmbedder(),
        seed=17,
    )
    model.predict(("charge alice@example.com",))


def test_taxonomy_is_capped_and_detectors_require_review() -> None:
    member = duplicate_charge_interaction()
    summary = summarize_interaction(member)
    taxonomy = build_taxonomy([summary])
    proposals = propose_detectors(
        taxonomy,
        members_by_label={"duplicate_charge": (member,)},
        minimum_support=1,
    )
    assert taxonomy.sample_size == 1
    assert proposals and not proposals[0].runnable
    assert proposals[0].support == 1
    assert proposals[0].state_members_examined == 1
    assert proposals[0].state_matches == 1
    assert "DEFAULT_DETECTORS" in proposals[0].state_method
    assert proposals[0].condition.parameters.model_dump() == {
        "runtime_detector_id": "duplicate_charge",
        "members_examined": 1,
        "matching_members": 1,
    }
    assert proposals[0].status == "proposed"
    assert proposals[0].precision_correct is None
    assert proposals[0].precision_sample_size is None
    assert proposals[0].precision_estimate is None
    assert proposals[0].precision_method == "not estimated; requires human-reviewed state evaluation"
    approved = review_detector(proposals[0], "approved", precision_correct=1, precision_sample_size=1)
    assert approved.runnable and approved.precision_estimate == 1
    assert approved.precision_method == "caller-supplied human review and state-evaluation counts"


def test_detector_derivation_skips_label_without_matching_state() -> None:
    member = interaction()
    taxonomy = build_taxonomy([summarize_interaction(member)])

    assert propose_detectors(
        taxonomy,
        members_by_label={"duplicate_charge": (member,)},
        minimum_support=1,
    ) == ()


def test_detector_derivation_uses_full_prediction_frequency_and_separate_matches() -> None:
    matching = duplicate_charge_interaction("i1")
    clean = interaction(identifier="i2")
    taxonomy = build_taxonomy([summarize_interaction(matching)])

    outcomes = derive_detector_outcomes(
        taxonomy,
        members_by_label={"duplicate_charge": (matching, clean)},
        minimum_support=2,
    )

    assert len(outcomes) == 1
    assert outcomes[0].status == "proposed"
    assert outcomes[0].member_count == 2
    assert outcomes[0].proposal is not None
    assert outcomes[0].proposal.support == 2
    assert outcomes[0].proposal.state_members_examined == 2
    assert outcomes[0].proposal.state_matches == 1


def test_novel_frequent_label_gets_state_based_proposal_or_explicit_no_condition() -> None:
    first = duplicate_charge_interaction("i1")
    second = duplicate_charge_interaction("i2")
    base = build_taxonomy([summarize_interaction(first)])
    refund = base.labels[0].model_copy(
        update={"id": "refund", "name": "Refund request", "support": 1}
    )
    taxonomy = base.model_copy(update={"labels": (refund,)})

    proposed = derive_detector_outcomes(
        taxonomy,
        members_by_label={"refund": (first, second)},
        minimum_support=2,
    )[0]
    unsupported = derive_detector_outcomes(
        taxonomy,
        members_by_label={
            "refund": (interaction(identifier="c1"), interaction(identifier="c2"))
        },
        minimum_support=2,
    )[0]

    assert proposed.status == "proposed"
    assert proposed.proposal is not None
    assert proposed.proposal.id == "refund"
    assert proposed.proposal.condition.operation == "duplicate_charge"
    evaluations = {
        item.runtime_detector_id: item for item in proposed.condition_evaluations
    }
    assert evaluations["duplicate_charge"].label_matches == 2
    assert evaluations["duplicate_charge"].corpus_members_examined == 2
    assert evaluations["duplicate_charge"].corpus_matches == 2
    assert unsupported.status == "no_supported_condition"
    assert unsupported.proposal is None
    assert set(unsupported.state_matches_by_condition) == {
        "account_lock",
        "duplicate_charge",
        "late_delivery",
        "wrong_item",
    }


def test_approved_proposal_compiles_and_replaces_runtime_template() -> None:
    member = duplicate_charge_interaction()
    taxonomy = build_taxonomy([summarize_interaction(member)])
    proposal = propose_detectors(
        taxonomy,
        members_by_label={"duplicate_charge": (member,)},
        minimum_support=1,
    )[0]
    rejected = review_detector(
        proposal,
        "rejected",
        precision_correct=0,
        precision_sample_size=1,
    )
    approved = review_detector(
        proposal,
        "approved",
        precision_correct=1,
        precision_sample_size=1,
    )

    with pytest.raises(ValueError, match="only an approved"):
        compile_approved_proposal(proposal)
    with pytest.raises(ValueError, match="only an approved"):
        compile_approved_proposal(rejected)

    compiled = compile_approved_proposal(approved)
    active = activate_approved_proposals((approved,))

    assert compiled.confirmed
    assert compiled.id == "duplicate_charge"
    assert compiled.derivation_proposal_id == proposal.id
    compiled_hypotheses = generate_hypotheses(member, detectors=(compiled,))
    assert [item.detector_id for item in compiled_hypotheses] == ["duplicate_charge"]
    assert compiled_hypotheses[0].derivation_proposal_id == proposal.id
    assert [item.id for item in active].count("duplicate_charge") == 1
    assert next(item for item in active if item.id == "duplicate_charge") == compiled

    mismatched_parameters = approved.condition.parameters.model_copy(
        update={"runtime_detector_id": "wrong_item"}
    )
    mismatched_condition = approved.condition.model_copy(
        update={"parameters": mismatched_parameters}
    )
    mismatched = approved.model_copy(
        update={"condition": mismatched_condition}
    )
    with pytest.raises(ValueError, match="canonical schema revalidation"):
        compile_approved_proposal(mismatched)

    forged_approval = proposal.model_copy(update={"status": "approved"})
    with pytest.raises(ValueError, match="canonical schema revalidation"):
        compile_approved_proposal(forged_approval)

    with pytest.raises(ValidationError, match="frozen"):
        approved.condition.parameters.matching_members = 0

    with pytest.raises(TypeError, match="runtime Detector"):
        PipelineRunner(embedder=FakeEmbedder(), detectors=(proposal,))  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="runtime Detector"):
        PipelineRunner(embedder=FakeEmbedder(), detectors=(approved,))  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="runtime Detector"):
        generate_hypotheses(member, detectors=(approved,))  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="runtime Detector"):
        evaluate_detector(approved, member.state_snapshot, as_of=member.opened_at)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="IDs must be unique"):
        PipelineRunner(embedder=FakeEmbedder(), detectors=(compiled, compiled))


def test_detector_outcome_rejects_contradictory_selected_counts() -> None:
    matching = duplicate_charge_interaction("i1")
    clean = interaction(identifier="i2")
    taxonomy = build_taxonomy([summarize_interaction(matching)])
    outcome = derive_detector_outcomes(
        taxonomy,
        members_by_label={"duplicate_charge": (matching, clean)},
        minimum_support=2,
    )[0]
    assert DetectorDerivationOutcome.model_validate_json(
        outcome.model_dump_json()
    ) == outcome
    payload = outcome.model_dump(mode="json", exclude_computed_fields=True)
    payload["proposal"]["state_matches"] = 2
    payload["proposal"]["condition"]["parameters"]["matching_members"] = 2

    with pytest.raises(ValidationError, match="audited condition result"):
        DetectorDerivationOutcome.model_validate(payload)


def test_detector_yaml_round_trips_strict_schema_without_computed_fields() -> None:
    member = duplicate_charge_interaction()
    taxonomy = build_taxonomy([summarize_interaction(member)])
    proposal = propose_detectors(
        taxonomy,
        members_by_label={"duplicate_charge": (member,)},
        minimum_support=1,
    )[0]
    approved = review_detector(
        proposal,
        "approved",
        precision_correct=1,
        precision_sample_size=1,
        precision_method="Reviewed by alice@example.com at +1 415-555-0123",
    )

    text = detectors_yaml((approved,))

    assert "precision_estimate" not in text
    assert "alice@example.com" not in text
    assert "415-555-0123" not in text
    assert "<EMAIL_ADDRESS>" in text
    assert "<PHONE_NUMBER>" in text
    assert load_detector_proposals_yaml(text) == (approved,)
    with pytest.raises(ValueError, match="strict validation"):
        load_detector_proposals_yaml(text + "  precision_estimate: 1.0\n")

    proposed_text = detectors_yaml((proposal,))
    duplicate_key_override = proposed_text + (
        "  precision_correct: 1\n"
        "  precision_sample_size: 1\n"
        "  status: approved\n"
    )
    with pytest.raises(ValueError, match="duplicate keys"):
        load_detector_proposals_yaml(duplicate_key_override)


def test_approved_edited_detector_text_is_redacted_before_embedding() -> None:
    member = duplicate_charge_interaction()
    taxonomy = build_taxonomy([summarize_interaction(member)])
    proposal = propose_detectors(
        taxonomy,
        members_by_label={"duplicate_charge": (member,)},
        minimum_support=1,
    )[0]
    approved = review_detector(
        proposal,
        "approved",
        precision_correct=1,
        precision_sample_size=1,
    )
    edited = approved.model_copy(
        update={
            "label": "Email alice@example.com now",
            "variants": ("Call +1 415-555-0123",),
        }
    )
    compiled = compile_approved_proposal(edited)

    class CapturingEmbedder:
        def __init__(self) -> None:
            self.calls = []

        def encode(self, texts):
            self.calls.append(tuple(texts))
            return np.tile(
                np.asarray([[1.0, 0.0]], dtype=np.float32),
                (len(texts), 1),
            )

    embedder = CapturingEmbedder()
    result = PipelineRunner(embedder=embedder, detectors=(compiled,)).run(member)
    model_text = " ".join(embedder.calls[0])

    assert result.candidates
    assert "alice@example.com" not in model_text
    assert "415-555-0123" not in model_text
    assert "<EMAIL_ADDRESS>" in model_text
    assert "<PHONE_NUMBER>" in model_text


def test_detector_derivation_rejects_duplicate_or_noncanonical_members() -> None:
    member = duplicate_charge_interaction()
    taxonomy = build_taxonomy([summarize_interaction(member)])
    label = taxonomy.labels[0].model_copy(update={"support": 2})
    doubled_taxonomy = taxonomy.model_copy(
        update={"labels": (label,), "sample_size": 2}
    )

    with pytest.raises(ValueError, match="IDs must be unique"):
        propose_detectors(
            doubled_taxonomy,
            members_by_label={"duplicate_charge": (member, member)},
            minimum_support=1,
        )
    with pytest.raises(TypeError, match="canonical Interaction"):
        propose_detectors(
            taxonomy,
            members_by_label={"duplicate_charge": (member.model_dump(),)},  # type: ignore[dict-item]
            minimum_support=1,
        )


class FakeEmbedder:
    def encode(self, texts):
        return np.asarray(
            [[1.0, 0.0] if "charge" in text else [0.0, 1.0] for text in texts],
            dtype=np.float32,
        )


def test_distilled_classifier_reports_held_out_denominator() -> None:
    texts = [f"charge {i}" for i in range(10)] + [f"delivery {i}" for i in range(10)]
    labels = ["billing"] * 10 + ["shipping"] * 10
    model = DistilledClassifier.fit(texts, labels, embedder=FakeEmbedder(), seed=17)
    assert model.metrics.held_out_n == 5
    assert model.metrics.held_out_correct == 5
    assert model.predict(("charge again", "delivery late")) == ("billing", "shipping")


class MagnitudeEmbedder:
    def encode(self, texts):
        return np.asarray(
            [
                [0.0, 0.0]
                if "zero" in text
                else ([4.0, 3.0] if "charge" in text else [0.0, 8.0])
                for text in texts
            ],
            dtype=np.float32,
        )


class RecordingEstimator:
    def __init__(self, **_kwargs):
        self.classes_ = np.asarray(["billing", "shipping"])
        self.fit_matrix = None
        self.predict_matrices = []
        self.probability_matrices = []

    def fit(self, matrix, _labels):
        self.fit_matrix = matrix.copy()
        return self

    def predict(self, matrix):
        self.predict_matrices.append(matrix.copy())
        return np.where(matrix[:, 0] > 0, "billing", "shipping")

    def predict_proba(self, matrix):
        self.probability_matrices.append(matrix.copy())
        billing = (matrix[:, 0] > 0).astype(np.float64)
        return np.column_stack((billing, 1.0 - billing))


def test_distillation_l2_normalizes_training_and_inference_embeddings(monkeypatch) -> None:
    monkeypatch.setattr("wordless.derive.distill.LogisticRegression", RecordingEstimator)
    texts = [f"charge {i}" for i in range(10)] + [f"delivery {i}" for i in range(10)]
    labels = ["billing"] * 10 + ["shipping"] * 10

    model = DistilledClassifier.fit(texts, labels, embedder=MagnitudeEmbedder(), seed=17)
    assert model.estimator.fit_matrix is not None
    np.testing.assert_allclose(np.linalg.norm(model.estimator.fit_matrix, axis=1), 1.0)

    model.predict(("charge again", "zero vector"))
    np.testing.assert_allclose(model.estimator.predict_matrices[-1], [[0.8, 0.6], [0.0, 0.0]])
    model.predict_proba(("delivery late", "zero vector"))
    np.testing.assert_allclose(model.estimator.probability_matrices[-1], [[0.0, 1.0], [0.0, 0.0]])

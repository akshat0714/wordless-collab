from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pytest

from wordless.core.models import Interaction, Message, Resolution, StateFact
from wordless.core.redact import Redactor
from wordless.pipeline.candidates import Hypothesis
from wordless.pipeline.rerank import Candidate
from wordless.pipeline.run import PipelineResult, PipelineRunner
from wordless.replay.engine import ReplayEngine, ReplayResult
from wordless.replay.judge import Judgment, ReplayJudge
from wordless.replay.metrics import aggregate_metrics, inter_rater_agreement


NOW = datetime(2026, 7, 20, 12, tzinfo=timezone.utc)


def test_replay_rejects_redactor_substitutes_that_could_bypass_sanitization() -> None:
    class RedactorSubclass(Redactor):
        pass

    with pytest.raises(TypeError, match="concrete Redactor"):
        ReplayEngine(
            pipeline=object(),
            judge=object(),
            redactor=RedactorSubclass(use_presidio=False),
        )


def _fact(provenance: str = "exported") -> StateFact:
    return StateFact(
        source="billing",
        kind="charge",
        occurred_at=NOW,
        fields={"amount": "84.00"},
        provenance=provenance,
    )


def _interaction(identifier: str, fragment: str, provenance: str = "exported") -> Interaction:
    return Interaction(
        id=identifier,
        customer_key=f"hmac-sha256:{identifier[0] * 64}",
        opened_at=NOW,
        channel="chat",
        messages=[Message(author="customer", sent_at=NOW, text=fragment, redacted=True)],
        state_snapshot=[_fact(provenance)],
        resolution=Resolution(
            resolved_at=NOW,
            original_label="fixture",
            actions=["Resolved fixture"],
            closing_text="Resolved fixture.",
        ),
        source_system="fixture",
    )


def _candidate(identifier: str, rank: int) -> Candidate:
    hypothesis = Hypothesis(
        detector_id=identifier,
        title=identifier.replace("_", " "),
        detail="Concrete fixture evidence.",
        evidence=(_fact(),),
        base_score=0.9,
    )
    return Candidate(
        **hypothesis.model_dump(),
        cosine_similarity=0.0,
        recency_boost=0.5,
        score=1.4,
        rank=rank,
    )


class FixedPipeline:
    def __init__(self, decisions: tuple[Candidate, ...]) -> None:
        self.decisions = decisions

    def run(self, interaction: Interaction) -> PipelineResult:
        hypotheses = tuple(
            Hypothesis.model_validate(candidate.model_dump(exclude={"cosine_similarity", "recency_boost", "score", "rank", "final_score"}))
            for candidate in self.decisions
        )
        return PipelineResult(
            interaction_id=interaction.id,
            fragment=interaction.messages[0].text,
            hypotheses=hypotheses,
            ranked_candidates=self.decisions,
            candidates=self.decisions,
            threshold=1.0,
            abstained=not self.decisions,
            abstention_reason=None if self.decisions else "no_evidence_hypotheses",
        )


class FixedJudge:
    def __init__(self, labels: dict[str, str]) -> None:
        self.labels = labels

    def judge(self, candidate: Candidate, _resolution: Resolution) -> Judgment:
        decision = self.labels[candidate.detector_id]
        return Judgment(
            detector_id=candidate.detector_id,
            candidate_rank=candidate.rank,
            decision=decision,
            embedding_similarity=0.0,
            stage="fallback",
            method="test fixture",
        )


class SpyEmbedder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []

    def encode(self, texts: tuple[str, ...]) -> np.ndarray:
        values = tuple(texts)
        self.calls.append(values)
        return np.ones((len(values), 2), dtype=np.float32)


def _interaction_with_pii_outside_the_message_flag() -> Interaction:
    return Interaction(
        id="pii-boundary",
        customer_key=f"hmac-sha256:{'a' * 64}",
        opened_at=NOW,
        channel="chat",
        messages=[
            Message(
                author="customer",
                sent_at=NOW,
                text="My name is Jane Doe; email jane@example.com about the wrong item.",
                redacted=True,
            )
        ],
        state_snapshot=[
            StateFact(
                source="orders",
                kind="order",
                occurred_at=NOW,
                fields={
                    "order_id": "ORD-123",
                    "ordered_sku": "Jane Doe",
                    "delivered_sku": "SKU-900",
                    "contact_note": "Email jane@example.com",
                    "status": "delivered",
                },
                provenance="exported",
            )
        ],
        resolution=Resolution(
            resolved_at=NOW,
            original_label="Jane Doe return",
            actions=["Email jane@example.com"],
            closing_text="Refunded Jane Doe at jane@example.com.",
        ),
        source_system="fixture",
        metadata={"owner": "Jane Doe", "contact": "jane@example.com"},
    )


def test_replay_redacts_all_model_and_candidate_evidence_inputs_deterministically() -> None:
    interaction = _interaction_with_pii_outside_the_message_flag()
    spy = SpyEmbedder()
    engine = ReplayEngine(
        pipeline=PipelineRunner(embedder=spy, threshold=0.0),
        judge=ReplayJudge(embedder=spy),
    )

    first = engine.replay(interaction)
    second = engine.replay(interaction)

    model_inputs = "\n".join(text for call in spy.calls for text in call)
    candidate_payload = first.pipeline.model_dump_json()
    assert "Jane Doe" not in model_inputs
    assert "jane@example.com" not in model_inputs
    assert "Jane Doe" not in candidate_payload
    assert "jane@example.com" not in candidate_payload
    assert "<PERSON>" in candidate_payload
    assert "<EMAIL_ADDRESS>" in candidate_payload
    assert first.model_dump_json() == second.model_dump_json()


def test_replay_outcomes_are_exclusive_and_rank_aware() -> None:
    first = _candidate("first", 1)
    second = _candidate("second", 2)
    interaction = _interaction("a-one", "brief words")

    agreement = ReplayEngine(
        pipeline=FixedPipeline((first, second)),
        judge=FixedJudge({"first": "no", "second": "yes"}),
    ).replay(interaction)
    disagreement = ReplayEngine(
        pipeline=FixedPipeline((first,)),
        judge=FixedJudge({"first": "no"}),
    ).replay(interaction.model_copy(update={"id": "b-two", "customer_key": f"hmac-sha256:{'b' * 64}"}))
    unclear = ReplayEngine(
        pipeline=FixedPipeline((first,)),
        judge=FixedJudge({"first": "unclear"}),
    ).replay(interaction.model_copy(update={"id": "c-three", "customer_key": f"hmac-sha256:{'c' * 64}"}))

    assert (agreement.outcome, agreement.match_rank) == ("agreement@3", 2)
    assert disagreement.outcome == "disagreement"
    assert unclear.outcome == "abstain"
    assert unclear.abstention_reason == "judge_unclear"


def _copy_result(
    source: ReplayResult,
    *,
    identifier: str,
    outcome: str,
    bucket: str,
    rung: str,
) -> ReplayResult:
    payload = source.model_dump()
    payload.update(
        interaction_id=identifier,
        outcome=outcome,
        match_rank=1 if outcome == "agreement@1" else (2 if outcome == "agreement@3" else None),
        fragment_bucket=bucket,
        provenance_rung=rung,
        degraded=rung in {"inferred", "none"},
        abstention_reason="judge_unclear" if outcome == "abstain" else None,
    )
    payload["pipeline"]["interaction_id"] = identifier
    return ReplayResult.model_validate(payload)


def test_metrics_segment_lengths_and_publish_denominators() -> None:
    seed = ReplayEngine(
        pipeline=FixedPipeline((_candidate("first", 1),)),
        judge=FixedJudge({"first": "yes"}),
    ).replay(_interaction("d-seed", "short"))
    results = (
        _copy_result(seed, identifier="d-one", outcome="agreement@1", bucket="<=5", rung="exported"),
        _copy_result(seed, identifier="e-two", outcome="agreement@3", bucket="6-15", rung="reconstructed"),
        _copy_result(seed, identifier="f-three", outcome="disagreement", bucket="16+", rung="inferred"),
        _copy_result(seed, identifier="a-four", outcome="abstain", bucket="<=5", rung="exported"),
    )

    metrics = aggregate_metrics(results)

    assert metrics.sample_size == 4
    assert metrics.overall.agreement_at_3.numerator == 2
    assert metrics.overall.agreement_at_3.denominator == 4
    assert metrics.by_fragment_length["<=5"].denominator == 2
    assert metrics.provenance_distribution["exported"].numerator == 2
    assert metrics.provenance_distribution["exported"].denominator == 4
    assert metrics.by_provenance["inferred"].disagreement.numerator == 1


def test_judge_agreement_reports_sample_and_method() -> None:
    result = inter_rater_agreement(["yes", "no", "unclear"], ["yes", "no", "no"])

    assert result.sample_size == 3
    assert result.exact_agreement.numerator == 2
    assert result.exact_agreement.denominator == 3
    assert result.publication_sample_met is False

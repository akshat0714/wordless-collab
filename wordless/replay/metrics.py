"""Replay metrics with explicit denominators, segments, and methods."""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from wordless.replay.engine import FragmentBucket, ProvenanceRung, ReplayResult
from wordless.replay.judge import JudgeDecision


class Rate(BaseModel):
    """A reported rate that cannot lose its numerator or denominator."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    numerator: int = Field(ge=0)
    denominator: int = Field(ge=0)
    value: float | None = Field(default=None, ge=0.0, le=1.0)
    method: str


class OutcomeMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    denominator: int = Field(ge=0)
    agreement_at_1: Rate
    agreement_at_3: Rate
    abstain: Rate
    disagreement: Rate


class ReplayMetrics(BaseModel):
    """Overall and segmented audit metrics from one deterministic replay."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    sample_size: int = Field(ge=0)
    overall: OutcomeMetrics
    by_fragment_length: dict[FragmentBucket, OutcomeMetrics]
    provenance_distribution: dict[ProvenanceRung, Rate]
    by_provenance: dict[ProvenanceRung, OutcomeMetrics]
    method: str


class InterRaterAgreement(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    sample_size: int = Field(ge=0)
    exact_matches: int = Field(ge=0)
    exact_agreement: Rate
    cohen_kappa: float | None = Field(default=None, ge=-1.0, le=1.0)
    publication_sample_met: bool
    recommended_sample: str = "50-100 hand-checked judgments"
    method: str = "exact label agreement and unweighted Cohen kappa on yes/no/unclear"


_BUCKETS: tuple[FragmentBucket, ...] = ("<=5", "6-15", "16+")
_RUNGS: tuple[ProvenanceRung, ...] = ("exported", "reconstructed", "inferred", "none")


def _rate(numerator: int, denominator: int, method: str) -> Rate:
    return Rate(
        numerator=numerator,
        denominator=denominator,
        value=numerator / denominator if denominator else None,
        method=method,
    )


def _outcomes(results: Sequence[ReplayResult]) -> OutcomeMetrics:
    denominator = len(results)
    agreement_at_1 = sum(result.outcome == "agreement@1" for result in results)
    # Agreement@3 is cumulative: a rank-one match is also present in the top 3.
    agreement_at_3 = sum(result.outcome in {"agreement@1", "agreement@3"} for result in results)
    abstain = sum(result.outcome == "abstain" for result in results)
    disagreement = sum(result.outcome == "disagreement" for result in results)
    return OutcomeMetrics(
        denominator=denominator,
        agreement_at_1=_rate(
            agreement_at_1,
            denominator,
            "top-ranked candidate judged yes / all replayed interactions",
        ),
        agreement_at_3=_rate(
            agreement_at_3,
            denominator,
            "any of up to three candidates judged yes / all replayed interactions",
        ),
        abstain=_rate(
            abstain,
            denominator,
            "pipeline or judge abstentions / all replayed interactions",
        ),
        disagreement=_rate(
            disagreement,
            denominator,
            "selected candidates all judged no / all replayed interactions",
        ),
    )


def aggregate_metrics(results: Sequence[ReplayResult]) -> ReplayMetrics:
    """Aggregate results without blending fragment or provenance segments."""

    values = tuple(results)
    ids = [result.interaction_id for result in values]
    if len(ids) != len(set(ids)):
        raise ValueError("replay results must have unique interaction ids")
    denominator = len(values)
    by_fragment = {
        bucket: _outcomes(tuple(result for result in values if result.fragment_bucket == bucket))
        for bucket in _BUCKETS
    }
    provenance_distribution = {
        rung: _rate(
            sum(result.provenance_rung == rung for result in values),
            denominator,
            "interactions assigned to provenance rung / all replayed interactions",
        )
        for rung in _RUNGS
    }
    by_provenance = {
        rung: _outcomes(tuple(result for result in values if result.provenance_rung == rung))
        for rung in _RUNGS
    }
    return ReplayMetrics(
        sample_size=denominator,
        overall=_outcomes(values),
        by_fragment_length=by_fragment,
        provenance_distribution=provenance_distribution,
        by_provenance=by_provenance,
        method=(
            "deterministic historical replay; agreement@3 includes agreement@1; "
            "fragment buckets use whitespace-delimited word counts"
        ),
    )


def inter_rater_agreement(
    predicted: Sequence[JudgeDecision | str],
    human: Sequence[JudgeDecision | str],
) -> InterRaterAgreement:
    """Measure the replay judge against a hand-checked sample."""

    predicted_values = tuple(str(value).casefold() for value in predicted)
    human_values = tuple(str(value).casefold() for value in human)
    if len(predicted_values) != len(human_values):
        raise ValueError("predicted and human labels must have equal length")
    allowed = {"yes", "no", "unclear"}
    if any(value not in allowed for value in (*predicted_values, *human_values)):
        raise ValueError("judge labels must be yes, no, or unclear")
    sample_size = len(predicted_values)
    exact_matches = sum(left == right for left, right in zip(predicted_values, human_values, strict=True))
    observed = exact_matches / sample_size if sample_size else None
    if sample_size:
        predicted_counts = Counter(predicted_values)
        human_counts = Counter(human_values)
        expected = sum(
            (predicted_counts[label] / sample_size) * (human_counts[label] / sample_size)
            for label in sorted(allowed)
        )
        if expected == 1.0:
            kappa = 1.0 if observed == 1.0 else None
        else:
            kappa = ((observed or 0.0) - expected) / (1.0 - expected)
    else:
        kappa = None
    return InterRaterAgreement(
        sample_size=sample_size,
        exact_matches=exact_matches,
        exact_agreement=_rate(exact_matches, sample_size, "exact yes/no/unclear matches / hand-checked judgments"),
        cohen_kappa=kappa,
        publication_sample_met=50 <= sample_size <= 100,
    )


summarize_replay = aggregate_metrics


__all__ = [
    "InterRaterAgreement",
    "OutcomeMetrics",
    "Rate",
    "ReplayMetrics",
    "aggregate_metrics",
    "inter_rater_agreement",
    "summarize_replay",
]

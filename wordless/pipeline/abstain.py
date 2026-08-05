"""Calibration and risk--coverage utilities for selective prediction."""

from __future__ import annotations

from collections.abc import Sequence
import math
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from wordless.pipeline.rerank import Candidate, MAX_CANDIDATES


class LabeledPrediction(BaseModel):
    """One scored prediction from a labeled calibration or evaluation split."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    score: float
    correct: bool

    @field_validator("score")
    @classmethod
    def finite_score(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("score must be finite")
        return value


class RiskCoveragePoint(BaseModel):
    """An empirical operating point with every numerator and denominator."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    threshold: float
    selected_count: int = Field(ge=0)
    correct_count: int = Field(ge=0)
    error_count: int = Field(ge=0)
    denominator: int = Field(ge=0)
    coverage: float = Field(ge=0.0, le=1.0)
    precision: float | None = Field(default=None, ge=0.0, le=1.0)
    risk: float | None = Field(default=None, ge=0.0, le=1.0)
    method: str = "empirical selective risk; accept score >= threshold"


class ThresholdCalibration(BaseModel):
    """Threshold fitted only on a named calibration split."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    threshold: float
    target_precision: float = Field(ge=0.0, le=1.0)
    minimum_coverage: float = Field(ge=0.0, le=1.0)
    achieved: bool
    selected_count: int = Field(ge=0)
    denominator: int = Field(ge=0)
    coverage: float = Field(ge=0.0, le=1.0)
    precision: float | None = Field(default=None, ge=0.0, le=1.0)
    risk: float | None = Field(default=None, ge=0.0, le=1.0)
    calibration_split: str
    method: str
    curve: tuple[RiskCoveragePoint, ...]


class SelectiveEvaluation(BaseModel):
    """Held-out evaluation at a frozen calibration threshold."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    threshold: float
    selected_count: int = Field(ge=0)
    correct_count: int = Field(ge=0)
    error_count: int = Field(ge=0)
    denominator: int = Field(ge=0)
    coverage: float = Field(ge=0.0, le=1.0)
    precision: float | None = Field(default=None, ge=0.0, le=1.0)
    risk: float | None = Field(default=None, ge=0.0, le=1.0)
    evaluation_split: str
    method: str = "frozen calibration threshold evaluated on held-out labels"


class CalibrationAndEvaluation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    calibration: ThresholdCalibration
    held_out: SelectiveEvaluation


def _coerce_examples(
    scores: Sequence[LabeledPrediction] | Sequence[float],
    correct: Sequence[bool] | None,
    *,
    ids: Sequence[str] | None = None,
) -> tuple[LabeledPrediction, ...]:
    values = tuple(scores)
    if correct is None:
        if all(isinstance(value, LabeledPrediction) for value in values):
            return tuple(value for value in values if isinstance(value, LabeledPrediction))
        raise TypeError("correct labels are required when scores are numeric")
    labels = tuple(correct)
    if len(values) != len(labels):
        raise ValueError("scores and correct labels must have equal length")
    identifiers = tuple(ids) if ids is not None else tuple(str(index) for index in range(len(values)))
    if len(identifiers) != len(values):
        raise ValueError("ids and scores must have equal length")
    return tuple(
        LabeledPrediction(id=identifier, score=float(score), correct=bool(label))
        for identifier, score, label in zip(identifiers, values, labels, strict=True)
    )


def _point_at(examples: Sequence[LabeledPrediction], threshold: float) -> RiskCoveragePoint:
    selected = tuple(example for example in examples if example.score >= threshold)
    correct_count = sum(example.correct for example in selected)
    selected_count = len(selected)
    denominator = len(examples)
    precision = correct_count / selected_count if selected_count else None
    risk = 1.0 - precision if precision is not None else None
    return RiskCoveragePoint(
        threshold=threshold,
        selected_count=selected_count,
        correct_count=correct_count,
        error_count=selected_count - correct_count,
        denominator=denominator,
        coverage=selected_count / denominator if denominator else 0.0,
        precision=precision,
        risk=risk,
    )


def risk_coverage_curve(
    scores: Sequence[LabeledPrediction] | Sequence[float],
    correct: Sequence[bool] | None = None,
    *,
    ids: Sequence[str] | None = None,
) -> tuple[RiskCoveragePoint, ...]:
    """Emit the complete empirical curve, including zero and full coverage."""

    examples = _coerce_examples(scores, correct, ids=ids)
    if not examples:
        return ()
    thresholds = sorted({example.score for example in examples}, reverse=True)
    zero_coverage_threshold = math.nextafter(thresholds[0], math.inf)
    return tuple(
        _point_at(examples, threshold)
        for threshold in (zero_coverage_threshold, *thresholds)
    )


def calibrate_threshold(
    scores: Sequence[LabeledPrediction] | Sequence[float],
    correct: Sequence[bool] | None = None,
    *,
    target_precision: float = 0.90,
    minimum_coverage: float = 0.0,
    calibration_split: str = "calibration",
    ids: Sequence[str] | None = None,
) -> ThresholdCalibration:
    """Choose maximum coverage meeting precision on a calibration split.

    Ties are resolved toward the higher threshold.  If no non-empty operating
    point satisfies the target, the returned threshold abstains on all labeled
    examples and ``achieved`` is false.
    """

    if not 0.0 <= target_precision <= 1.0:
        raise ValueError("target_precision must be between zero and one")
    if not 0.0 <= minimum_coverage <= 1.0:
        raise ValueError("minimum_coverage must be between zero and one")
    if not calibration_split.strip():
        raise ValueError("calibration_split must be non-empty")
    examples = _coerce_examples(scores, correct, ids=ids)
    if not examples:
        raise ValueError("at least one calibration prediction is required")
    curve = risk_coverage_curve(examples)
    eligible = [
        point
        for point in curve
        if point.selected_count
        and point.precision is not None
        and point.precision >= target_precision
        and point.coverage >= minimum_coverage
    ]
    if eligible:
        chosen = max(eligible, key=lambda point: (point.coverage, point.threshold))
        achieved = True
    else:
        chosen = curve[0]
        achieved = False
    return ThresholdCalibration(
        threshold=chosen.threshold,
        target_precision=target_precision,
        minimum_coverage=minimum_coverage,
        achieved=achieved,
        selected_count=chosen.selected_count,
        denominator=chosen.denominator,
        coverage=chosen.coverage,
        precision=chosen.precision,
        risk=chosen.risk,
        calibration_split=calibration_split,
        method=(
            "maximum empirical calibration coverage satisfying target precision; "
            "ties use the higher threshold"
        ),
        curve=curve,
    )


def evaluate_threshold(
    scores: Sequence[LabeledPrediction] | Sequence[float],
    correct: Sequence[bool] | None = None,
    *,
    threshold: float,
    evaluation_split: str = "held-out",
    ids: Sequence[str] | None = None,
) -> SelectiveEvaluation:
    """Evaluate, but never refit, a threshold on a held-out split."""

    if math.isnan(threshold):
        raise ValueError("threshold must not be NaN")
    if not evaluation_split.strip():
        raise ValueError("evaluation_split must be non-empty")
    examples = _coerce_examples(scores, correct, ids=ids)
    point = _point_at(examples, threshold)
    return SelectiveEvaluation(
        threshold=threshold,
        selected_count=point.selected_count,
        correct_count=point.correct_count,
        error_count=point.error_count,
        denominator=point.denominator,
        coverage=point.coverage,
        precision=point.precision,
        risk=point.risk,
        evaluation_split=evaluation_split,
    )


def calibrate_and_evaluate(
    calibration_scores: Sequence[LabeledPrediction] | Sequence[float],
    calibration_correct: Sequence[bool] | None,
    held_out_scores: Sequence[LabeledPrediction] | Sequence[float],
    held_out_correct: Sequence[bool] | None,
    *,
    target_precision: float = 0.90,
    minimum_coverage: float = 0.0,
) -> CalibrationAndEvaluation:
    calibration = calibrate_threshold(
        calibration_scores,
        calibration_correct,
        target_precision=target_precision,
        minimum_coverage=minimum_coverage,
    )
    held_out = evaluate_threshold(
        held_out_scores,
        held_out_correct,
        threshold=calibration.threshold,
    )
    return CalibrationAndEvaluation(calibration=calibration, held_out=held_out)


def select_candidates(
    candidates: Sequence[Candidate],
    *,
    threshold: float,
) -> tuple[Candidate, ...]:
    """Keep only candidates clearing the frozen floor, with the hard cap intact."""

    if math.isnan(threshold):
        raise ValueError("threshold must not be NaN")
    return tuple(candidate for candidate in candidates[:MAX_CANDIDATES] if candidate.score >= threshold)


def should_abstain(candidates: Sequence[Candidate], *, threshold: float) -> bool:
    return not select_candidates(candidates, threshold=threshold)


class CalibratedAbstainer:
    """Small immutable runtime surface around a previously fitted threshold."""

    def __init__(self, threshold: float) -> None:
        if math.isnan(threshold):
            raise ValueError("threshold must not be NaN")
        self.threshold = float(threshold)

    def select(self, candidates: Sequence[Candidate]) -> tuple[Candidate, ...]:
        return select_candidates(candidates, threshold=self.threshold)

    def abstains(self, candidates: Sequence[Candidate]) -> bool:
        return not self.select(candidates)


# Literature uses both names; keep the short one easy to discover.
fit_threshold = calibrate_threshold


__all__ = [
    "CalibratedAbstainer",
    "CalibrationAndEvaluation",
    "LabeledPrediction",
    "RiskCoveragePoint",
    "SelectiveEvaluation",
    "ThresholdCalibration",
    "calibrate_and_evaluate",
    "calibrate_threshold",
    "evaluate_threshold",
    "fit_threshold",
    "risk_coverage_curve",
    "select_candidates",
    "should_abstain",
]

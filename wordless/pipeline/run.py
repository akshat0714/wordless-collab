"""Deterministic orchestration of candidate generation, reranking, and abstention."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from wordless.core.models import Interaction
from wordless.core.redact import Redactor
from wordless.pipeline.abstain import ThresholdCalibration, select_candidates
from wordless.pipeline.candidates import (
    DEFAULT_DETECTORS,
    Detector,
    Hypothesis,
    generate_hypotheses,
)
from wordless.pipeline.concepts import contextual_query
from wordless.pipeline.rerank import Candidate, EmbeddingService, rerank_hypotheses


AbstentionReason = Literal[
    "no_evidence_hypotheses",
    "below_confidence_floor",
]


class PipelineResult(BaseModel):
    """One auditable pipeline decision, including candidates below the floor."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    interaction_id: str
    fragment: str
    hypotheses: tuple[Hypothesis, ...]
    ranked_candidates: tuple[Candidate, ...]
    candidates: tuple[Candidate, ...]
    threshold: float
    abstained: bool
    abstention_reason: AbstentionReason | None = None
    method: str = (
        "confirmed state detectors; base + recency + "
        "0.4*multi-prototype concept cosine; top 3"
    )

    @model_validator(mode="after")
    def validate_decision(self) -> "PipelineResult":
        if len(self.ranked_candidates) > 3 or len(self.candidates) > 3:
            raise ValueError("pipeline results may never contain more than three candidates")
        if self.abstained != (len(self.candidates) == 0):
            raise ValueError("abstained must agree with the selected candidate count")
        if self.abstained and self.abstention_reason is None:
            raise ValueError("an abstained result requires a reason")
        if not self.abstained and self.abstention_reason is not None:
            raise ValueError("a non-abstained result cannot have an abstention reason")
        return self


def first_customer_fragment(interaction: Interaction) -> str:
    """Return the chronologically first customer turn, or the valid empty input."""

    customer_turns = (
        (message.sent_at, index, message.text)
        for index, message in enumerate(interaction.messages)
        if message.author == "customer"
    )
    first = min(customer_turns, default=None, key=lambda item: (item[0], item[1]))
    return "" if first is None else first[2]


class PipelineRunner:
    """A stateless runner whose output is stable for the same validated input."""

    def __init__(
        self,
        *,
        embedder: EmbeddingService | Any,
        threshold: float | ThresholdCalibration = 0.0,
        detectors: Sequence[Detector] = DEFAULT_DETECTORS,
        redactor: Redactor | None = None,
    ) -> None:
        resolved_threshold = threshold.threshold if isinstance(threshold, ThresholdCalibration) else float(threshold)
        if math.isnan(resolved_threshold):
            raise ValueError("threshold must not be NaN")
        self.embedder = embedder
        self.threshold = resolved_threshold
        detector_values = tuple(detectors)
        if any(type(detector) is not Detector for detector in detector_values):
            raise TypeError(
                "detectors must contain concrete runtime Detector instances; "
                "compile approved derivation proposals first"
            )
        detector_ids = [detector.id for detector in detector_values]
        if len(detector_ids) != len(set(detector_ids)):
            raise ValueError("detector IDs must be unique within a pipeline runner")
        self.detectors = detector_values
        if redactor is not None and type(redactor) is not Redactor:
            raise TypeError("redactor must be a concrete Redactor instance")
        if redactor is not None and not redactor.boundary_safe:
            raise ValueError("redactor must keep mandatory Presidio policy enabled")
        # Corpus-aware callers can reuse the exact mandatory redactor configured
        # at ingest.  This preserves safe domain terms without creating a bypass:
        # every interaction is still rescanned at this model-facing boundary.
        self._redactor = redactor or Redactor()
        if not self._redactor.boundary_safe:
            raise ValueError(
                "pipeline requires the available mandatory pinned Presidio policy"
            )

    def run(self, interaction: Interaction) -> PipelineResult:
        if not isinstance(interaction, Interaction):
            raise TypeError("interaction must be an Interaction")
        # ``validate_assignment`` cannot observe in-place list/dict mutations or
        # a nested model being changed after Interaction construction.  Rebuild
        # from primitive data at this model-facing boundary so every canonical
        # validator runs again before any text reaches the embedder.
        interaction = Interaction.model_validate(
            interaction.model_dump(mode="python", round_trip=True)
        )
        if any(not message.redacted for message in interaction.messages):
            raise ValueError("Pipeline execution requires redacted ingest output")
        # A boolean marker is not proof that arbitrary nested text is clean.
        # Rescan at this model-facing boundary so a forged ``redacted=True``
        # value cannot disclose PII to an embedder.
        interaction, _report = self._redactor.redact_interaction(interaction)
        interaction = Interaction.model_validate(
            interaction.model_dump(mode="python", round_trip=True)
        )
        fragment = first_customer_fragment(interaction)
        ranking_fragment = contextual_query(fragment, interaction.metadata)
        hypotheses = generate_hypotheses(interaction, detectors=self.detectors)
        ranked = rerank_hypotheses(
            ranking_fragment,
            hypotheses,
            embedder=self.embedder,
            as_of=interaction.opened_at,
            redactor=self._redactor,
        )
        selected = select_candidates(ranked, threshold=self.threshold)
        if selected:
            reason = None
        elif not hypotheses:
            reason = "no_evidence_hypotheses"
        else:
            reason = "below_confidence_floor"
        return PipelineResult(
            interaction_id=interaction.id,
            fragment=fragment,
            hypotheses=hypotheses,
            ranked_candidates=ranked,
            candidates=selected,
            threshold=self.threshold,
            abstained=not selected,
            abstention_reason=reason,
        )

    def run_many(self, interactions: Iterable[Interaction]) -> tuple[PipelineResult, ...]:
        values = tuple(interactions)
        ids = [interaction.id for interaction in values]
        if len(ids) != len(set(ids)):
            raise ValueError("interaction ids must be unique within a pipeline run")
        ordered = sorted(values, key=lambda item: (item.opened_at, item.id))
        return tuple(self.run(interaction) for interaction in ordered)


def run_pipeline(
    interaction: Interaction,
    *,
    embedder: EmbeddingService | Any,
    threshold: float | ThresholdCalibration = 0.0,
    detectors: Sequence[Detector] = DEFAULT_DETECTORS,
    redactor: Redactor | None = None,
) -> PipelineResult:
    return PipelineRunner(
        embedder=embedder,
        threshold=threshold,
        detectors=detectors,
        redactor=redactor,
    ).run(interaction)


__all__ = [
    "AbstentionReason",
    "PipelineResult",
    "PipelineRunner",
    "first_customer_fragment",
    "run_pipeline",
]

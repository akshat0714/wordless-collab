"""Historical replay orchestration and outcome assignment."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, model_validator

from wordless.core.models import Interaction, StateFact
from wordless.core.redact import Redactor
from wordless.pipeline.run import PipelineResult, PipelineRunner
from wordless.replay.judge import Judgment, ReplayJudge


ReplayOutcome = Literal["agreement@1", "agreement@3", "abstain", "disagreement"]
FragmentBucket = Literal["<=5", "6-15", "16+"]
ProvenanceRung = Literal["exported", "reconstructed", "inferred", "none"]
ReplayAbstentionReason = Literal[
    "pipeline_abstain",
    "missing_resolution",
    "judge_unclear",
]


def count_fragment_words(fragment: str) -> int:
    """Count whitespace-delimited words, matching the report segmentation."""

    return len(fragment.split())


def fragment_length_bucket(fragment: str) -> FragmentBucket:
    count = count_fragment_words(fragment)
    if count <= 5:
        return "<=5"
    if count <= 15:
        return "6-15"
    return "16+"


def provenance_rung(facts: Iterable[StateFact]) -> ProvenanceRung:
    """Assign the best available interaction-level rung on the provenance ladder."""

    provenances = {fact.provenance for fact in facts}
    for rung in ("exported", "reconstructed", "inferred"):
        if rung in provenances:
            return rung  # type: ignore[return-value]
    return "none"


class ReplayResult(BaseModel):
    """Replay decision for one historical interaction."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    interaction_id: str
    outcome: ReplayOutcome
    match_rank: int | None = Field(default=None, ge=1, le=3)
    fragment_word_count: int = Field(ge=0)
    fragment_bucket: FragmentBucket
    provenance_rung: ProvenanceRung
    degraded: bool
    resolution_present: bool
    pipeline: PipelineResult
    judgments: tuple[Judgment, ...] = ()
    abstention_reason: ReplayAbstentionReason | None = None
    method: str = "two-stage embedding prefilter + LLM/fallback resolution judge"

    @model_validator(mode="after")
    def validate_outcome(self) -> "ReplayResult":
        if self.outcome == "agreement@1" and self.match_rank != 1:
            raise ValueError("agreement@1 requires match_rank 1")
        if self.outcome == "agreement@3" and self.match_rank not in {2, 3}:
            raise ValueError("agreement@3 requires match_rank 2 or 3")
        if self.outcome in {"abstain", "disagreement"} and self.match_rank is not None:
            raise ValueError("abstain/disagreement cannot have a match rank")
        if self.outcome == "abstain" and self.abstention_reason is None:
            raise ValueError("replay abstention requires a reason")
        if self.outcome != "abstain" and self.abstention_reason is not None:
            raise ValueError("only abstained replay results have an abstention reason")
        return self


@runtime_checkable
class StateReconstructor(Protocol):
    def reconstruct(self, interaction: Interaction) -> Any: ...


def _normalize_rung(value: Any) -> ProvenanceRung | None:
    if value is None:
        return None
    text = str(value).casefold()
    mapping: dict[str, ProvenanceRung] = {
        "1": "exported",
        "rung1": "exported",
        "rung_1": "exported",
        "exported": "exported",
        "2": "reconstructed",
        "rung2": "reconstructed",
        "rung_2": "reconstructed",
        "reconstructed": "reconstructed",
        "3": "inferred",
        "rung3": "inferred",
        "rung_3": "inferred",
        "inferred": "inferred",
        "none": "none",
    }
    return mapping.get(text)


class ReplayEngine:
    """Run point-in-time state through the pipeline and compare the resolution."""

    def __init__(
        self,
        *,
        pipeline: PipelineRunner,
        judge: ReplayJudge | Any,
        reconstructor: StateReconstructor | Any | None = None,
        redactor: Redactor | None = None,
    ) -> None:
        self.pipeline = pipeline
        self.judge = judge
        # Replay is a model-facing boundary, not a trust boundary.  A canonical
        # caller can incorrectly set Message.redacted=True while leaving PII in
        # messages, resolution text, metadata, or state fields.  Always apply
        # the shared redactor here; there is deliberately no bypass flag.
        # Corpus-aware callers may supply the same configured redactor used at
        # ingest (for example, one that protects structured product names).
        # This remains a mandatory redaction pass; there is no bypass flag.
        if redactor is not None and type(redactor) is not Redactor:
            raise TypeError("redactor must be a concrete Redactor instance")
        if redactor is not None and not redactor.boundary_safe:
            raise ValueError("redactor must keep mandatory Presidio policy enabled")
        self._redactor = redactor or Redactor()
        if not self._redactor.boundary_safe:
            raise ValueError(
                "replay requires the available mandatory pinned Presidio policy"
            )
        if reconstructor is None:
            # Import lazily so the pipeline package remains usable on its own.
            # Historical replay, however, defaults to the real point-in-time
            # reconstruction ladder rather than assuming a snapshot exists.
            from wordless.state import StateReconstructor as DefaultStateReconstructor

            self.reconstructor = DefaultStateReconstructor()
        else:
            self.reconstructor = reconstructor

    def _redact_for_replay(self, interaction: Interaction) -> Interaction:
        """Return a fully revalidated, redacted copy for model-facing work."""

        if not isinstance(interaction, Interaction):
            raise TypeError("replay requires an Interaction")
        validated = Interaction.model_validate(
            interaction.model_dump(mode="python", round_trip=True)
        )
        redacted, _report = self._redactor.redact_interaction(validated)
        return Interaction.model_validate(
            redacted.model_dump(mode="python", round_trip=True)
        )

    def _reconstruct(self, interaction: Interaction) -> tuple[Interaction, ProvenanceRung]:
        if hasattr(self.reconstructor, "reconstruct"):
            result = self.reconstructor.reconstruct(interaction)
        elif callable(self.reconstructor):
            result = self.reconstructor(interaction)
        else:
            raise TypeError("reconstructor must provide reconstruct(interaction) or be callable")
        if isinstance(result, Interaction):
            reconstructed = result
            rung_hint = None
        else:
            reconstructed = getattr(result, "interaction", None)
            rung_hint = _normalize_rung(getattr(result, "rung", None))
        if not isinstance(reconstructed, Interaction):
            raise TypeError("state reconstructor must return Interaction or a result containing .interaction")
        if reconstructed.id != interaction.id or reconstructed.opened_at != interaction.opened_at:
            raise ValueError("state reconstruction cannot change interaction identity or opening time")
        return reconstructed, rung_hint or provenance_rung(reconstructed.state_snapshot)

    def replay(self, interaction: Interaction) -> ReplayResult:
        # Sanitize before reconstruction so any future model-backed
        # reconstructor receives only redacted content.  Sanitize again after
        # reconstruction so a custom or upgraded reconstructor cannot introduce
        # PII into candidate evidence, candidate detail, or judge inputs.
        redacted_input = self._redact_for_replay(interaction)
        reconstructed, rung = self._reconstruct(redacted_input)
        reconstructed = self._redact_for_replay(reconstructed)
        pipeline_result = self.pipeline.run(reconstructed)
        fragment = pipeline_result.fragment
        common = {
            "interaction_id": reconstructed.id,
            "fragment_word_count": count_fragment_words(fragment),
            "fragment_bucket": fragment_length_bucket(fragment),
            "provenance_rung": rung,
            "degraded": rung in {"inferred", "none"},
            "resolution_present": reconstructed.resolution is not None,
            "pipeline": pipeline_result,
        }
        if pipeline_result.abstained:
            return ReplayResult(
                **common,
                outcome="abstain",
                abstention_reason="pipeline_abstain",
            )
        if reconstructed.resolution is None:
            return ReplayResult(
                **common,
                outcome="abstain",
                abstention_reason="missing_resolution",
            )

        judgments = tuple(
            self.judge.judge(candidate, reconstructed.resolution)
            for candidate in pipeline_result.candidates
        )
        matches = [judgment.candidate_rank for judgment in judgments if judgment.decision == "yes"]
        if matches:
            rank = min(matches)
            return ReplayResult(
                **common,
                outcome="agreement@1" if rank == 1 else "agreement@3",
                match_rank=rank,
                judgments=judgments,
            )
        if judgments and all(judgment.decision == "no" for judgment in judgments):
            return ReplayResult(
                **common,
                outcome="disagreement",
                judgments=judgments,
            )
        return ReplayResult(
            **common,
            outcome="abstain",
            judgments=judgments,
            abstention_reason="judge_unclear",
        )

    def replay_many(self, interactions: Iterable[Interaction]) -> tuple[ReplayResult, ...]:
        values = tuple(interactions)
        ids = [interaction.id for interaction in values]
        if len(ids) != len(set(ids)):
            raise ValueError("interaction ids must be unique within a replay")
        ordered = sorted(values, key=lambda item: (item.opened_at.isoformat(), item.id))
        return tuple(self.replay(interaction) for interaction in ordered)


def replay_interaction(
    interaction: Interaction,
    *,
    pipeline: PipelineRunner,
    judge: ReplayJudge | Any,
    reconstructor: StateReconstructor | Any | None = None,
    redactor: Redactor | None = None,
) -> ReplayResult:
    return ReplayEngine(
        pipeline=pipeline,
        judge=judge,
        reconstructor=reconstructor,
        redactor=redactor,
    ).replay(interaction)


__all__ = [
    "FragmentBucket",
    "ProvenanceRung",
    "ReplayAbstentionReason",
    "ReplayEngine",
    "ReplayOutcome",
    "ReplayResult",
    "StateReconstructor",
    "count_fragment_words",
    "fragment_length_bucket",
    "provenance_rung",
    "replay_interaction",
]

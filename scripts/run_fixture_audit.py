#!/usr/bin/env python3
"""Run the deterministic synthetic corpus through the complete local audit.

The script never selects a model by name.  It validates the passed Module 0
result, resolves the winning completed semantic method, and reads that method's
verified registry identifier from benchmark metadata.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import timedelta
import json
from pathlib import Path
import sys
from time import perf_counter
from typing import Any, Iterator, Sequence, TextIO

from wordless.core.embed import SentenceTransformerEmbedder
from wordless.core.models import Interaction, StateFact
from wordless.core.redact import RedactionReport, Redactor
from wordless.fixtures.demo import DEMO_CORPUS_NAME, DEMO_ORGANIZATION, demo_interactions
from wordless.pipeline.abstain import (
    SelectiveEvaluation,
    ThresholdCalibration,
    calibrate_threshold,
    evaluate_threshold,
    risk_coverage_curve,
)
from wordless.pipeline.run import PipelineResult, PipelineRunner
from wordless.replay.engine import ReplayEngine, ReplayResult
from wordless.replay.judge import ReplayJudge
from wordless.replay.metrics import ReplayMetrics, aggregate_metrics
from wordless.report import AuditReport, build_report
from wordless.report.build import (
    BenchmarkResult,
    EvidenceLine,
    JudgeValidation,
    LengthSegment,
    OutcomeCounts,
    ProvenanceDistribution,
    RedactionDisclosure,
    RiskCoveragePoint as ReportRiskCoveragePoint,
    TicketFinding,
    TranscriptLine,
)
from wordless.state import StateReconstructor


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BENCHMARK_PATH = REPOSITORY_ROOT / "bench" / "results" / "benchmark.json"
DEFAULT_OUTPUT_DIR = REPOSITORY_ROOT / "outputs" / "demo-audit"
DEFAULT_CACHE_DIR = REPOSITORY_ROOT / ".wordless" / "cache" / "embeddings"
PROGRESS_PROTOCOL = "wordless.fixture-progress.v1"
PROGRESS_PREFIX = "WORDLESS_FIXTURE_PROGRESS "
PROGRESS_STAGE_ORDER = (
    "benchmark",
    "model",
    "redaction",
    "calibration",
    "replay",
    "report",
)


@dataclass(frozen=True)
class WinningBenchmark:
    model_id: str
    revision: str | None
    seed: int
    sample_size: int
    semantic_hits_at_3: int
    bm25_hits_at_3: int
    dataset_fingerprint: str


@dataclass(frozen=True)
class FixtureAuditRun:
    report: AuditReport
    replay_results: tuple[ReplayResult, ...]
    replay_metrics: ReplayMetrics
    calibration: ThresholdCalibration
    held_out: SelectiveEvaluation
    redaction_report: RedactionReport
    model_id: str
    json_path: Path
    html_path: Path


class _FixtureProgress:
    """Emit a fixed, machine-readable phase stream without touching artifacts."""

    def __init__(self, stream: TextIO | None) -> None:
        self._stream = stream
        self._run_started = perf_counter()
        self._sequence = 0
        self._next_stage = 0

    def _milliseconds_since(self, started_at: float) -> int:
        return max(0, round((perf_counter() - started_at) * 1_000))

    def _write(self, *, event: str, stage_id: str, duration_ms: int | None = None) -> None:
        if self._stream is None:
            return
        payload: dict[str, str | int] = {
            "protocol": PROGRESS_PROTOCOL,
            "sequence": self._sequence,
            "event": event,
            "stage_id": stage_id,
            "elapsed_ms": self._milliseconds_since(self._run_started),
        }
        if duration_ms is not None:
            payload["duration_ms"] = duration_ms
        self._stream.write(
            f"{PROGRESS_PREFIX}{json.dumps(payload, sort_keys=True, separators=(',', ':'))}\n"
        )
        self._stream.flush()
        self._sequence += 1

    @contextmanager
    def stage(self, stage_id: str) -> Iterator[None]:
        if self._next_stage >= len(PROGRESS_STAGE_ORDER):
            raise RuntimeError("fixture progress contains more stages than the protocol allows")
        expected = PROGRESS_STAGE_ORDER[self._next_stage]
        if stage_id != expected:
            raise RuntimeError(
                f"fixture progress stage {stage_id!r} appeared where {expected!r} was required"
            )
        started_at = perf_counter()
        self._write(event="stage_started", stage_id=stage_id)
        try:
            yield
        except BaseException:
            raise
        else:
            self._write(
                event="stage_completed",
                stage_id=stage_id,
                duration_ms=self._milliseconds_since(started_at),
            )
            self._next_stage += 1


def _offline_sentence_transformer_factory(model_id: str, **kwargs: Any) -> Any:
    """Use the machine's standard model cache while remaining offline.

    The core embedder still owns deterministic seeding and its content-addressed
    vector cache.  Dropping only its private model-cache override lets this demo
    reuse the exact local artifact that produced Module 0's verified result.
    """

    kwargs.pop("cache_folder", None)
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(model_id, **kwargs)


def _required_mapping(value: Any, *, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"benchmark field {name} must be an object")
    return value


def load_winning_benchmark(path: Path = DEFAULT_BENCHMARK_PATH) -> WinningBenchmark:
    """Validate Module 0 passed and return its winning verified model metadata."""

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read benchmark result at {path}") from exc
    root = _required_mapping(payload, name="root")
    gate = _required_mapping(root.get("gate"), name="gate")
    if gate.get("decision") != "PASS":
        raise ValueError("fixture audit requires a PASS Module 0 benchmark")
    winner_id = gate.get("best_semantic_method")
    if not isinstance(winner_id, str) or not winner_id:
        raise ValueError("benchmark gate does not identify a winning semantic method")
    methods = root.get("methods")
    if not isinstance(methods, list):
        raise ValueError("benchmark methods must be a list")
    matches = [method for method in methods if isinstance(method, dict) and method.get("method_id") == winner_id]
    if len(matches) != 1:
        raise ValueError("winning benchmark method must appear exactly once")
    winner = matches[0]
    if winner.get("kind") != "semantic" or winner.get("status") != "completed":
        raise ValueError("winning benchmark method is not a completed semantic result")
    metadata = _required_mapping(winner.get("metadata"), name="winner.metadata")
    model = _required_mapping(metadata.get("model"), name="winner.metadata.model")
    model_id = model.get("model_id")
    if (
        not isinstance(model_id, str)
        or not model_id
        or model_id != model_id.strip()
        or any(character.isspace() for character in model_id)
    ):
        raise ValueError("winning benchmark model_id is invalid")
    revision = model.get("revision")
    if revision is not None and (not isinstance(revision, str) or not revision.strip()):
        raise ValueError("winning benchmark model revision is invalid")
    overall = _required_mapping(winner.get("overall"), name="winner.overall")
    bm25_matches = [
        method
        for method in methods
        if isinstance(method, dict)
        and method.get("method_id") == "bm25"
        and method.get("status") == "completed"
    ]
    if len(bm25_matches) != 1:
        raise ValueError("benchmark must contain one completed BM25 baseline")
    bm25 = _required_mapping(bm25_matches[0].get("overall"), name="bm25.overall")
    dataset = _required_mapping(root.get("dataset"), name="dataset")
    fingerprint = dataset.get("fingerprint_sha256")
    if not isinstance(fingerprint, str) or len(fingerprint) != 64:
        raise ValueError("benchmark dataset fingerprint is invalid")
    sample_size = int(overall.get("denominator", 0))
    if sample_size <= 0 or int(bm25.get("denominator", 0)) != sample_size:
        raise ValueError("semantic and BM25 benchmark denominators must agree and be positive")
    return WinningBenchmark(
        model_id=model_id,
        revision=revision,
        seed=int(metadata.get("seed", 0)),
        sample_size=sample_size,
        semantic_hits_at_3=int(overall.get("hits_at_3", -1)),
        bm25_hits_at_3=int(bm25.get("hits_at_3", -1)),
        dataset_fingerprint=fingerprint,
    )


def _detector_prediction_label(
    interaction: Interaction,
    result: PipelineResult,
) -> tuple[float, bool]:
    """Label the pre-threshold top detector against the synthetic fixture oracle.

    A missing candidate, or a fixture record without an expected detector, is
    conservatively incorrect.  Resolution agreement is deliberately not used:
    contradictory resolutions are positive fixture cases for finding a detector.
    """

    expected = interaction.metadata.get("expected_detector")
    if not result.ranked_candidates:
        # No candidate is an abstention, not a correct accepted prediction.
        return -1.0, False
    top = result.ranked_candidates[0]
    return top.score, isinstance(expected, str) and top.detector_id == expected


def _alternating_fixture_split(
    interactions: Sequence[Interaction],
) -> tuple[tuple[Interaction, ...], tuple[Interaction, ...]]:
    """Return the deterministic calibration and complementary held-out halves."""

    values = tuple(interactions)
    return values[::2], values[1::2]


def _calibrate_fixture(
    interactions: Sequence[Interaction],
    *,
    embedder: Any,
    redactor: Redactor,
) -> tuple[ThresholdCalibration, SelectiveEvaluation]:
    """Fit on alternating synthetic records, then freeze on the other half."""

    exploratory = PipelineRunner(
        embedder=embedder,
        threshold=0.0,
        redactor=redactor,
    )
    calibration_records, held_out_records = _alternating_fixture_split(interactions)
    calibration_predictions = tuple(
        _detector_prediction_label(interaction, exploratory.run(interaction))
        for interaction in calibration_records
    )
    held_out_predictions = tuple(
        _detector_prediction_label(interaction, exploratory.run(interaction))
        for interaction in held_out_records
    )
    calibration_scores = [score for score, _ in calibration_predictions]
    calibration_labels = [correct for _, correct in calibration_predictions]
    held_out_scores = [score for score, _ in held_out_predictions]
    held_out_labels = [correct for _, correct in held_out_predictions]
    calibration = calibrate_threshold(
        calibration_scores,
        calibration_labels,
        target_precision=1.0,
        minimum_coverage=0.5,
        calibration_split="alternating synthetic fixture records",
    )
    held_out = evaluate_threshold(
        held_out_scores,
        held_out_labels,
        threshold=calibration.threshold,
        evaluation_split="complementary alternating synthetic fixture records",
    )
    return calibration, held_out


def _field_text(fact: StateFact) -> str:
    values = ", ".join(
        f"{key.replace('_', ' ')}={value}"
        for key, value in sorted(fact.fields.items())
        if key not in {"extractor"}
    )
    return f"{fact.kind} recorded {fact.occurred_at.isoformat()}: {values}."


def _findings(
    interactions: Sequence[Interaction],
    results: Sequence[ReplayResult],
) -> tuple[TicketFinding, ...]:
    by_id = {interaction.id: interaction for interaction in interactions}
    findings: list[TicketFinding] = []
    for result in results:
        if result.outcome != "disagreement" or not result.pipeline.candidates:
            continue
        interaction = by_id[result.interaction_id]
        candidate = result.pipeline.candidates[0]
        resolution = interaction.resolution
        if resolution is None:  # replay classifies missing resolutions as abstentions
            continue
        evidence = tuple(
            EvidenceLine(
                source=fact.source,
                text=_field_text(fact),
                provenance=fact.provenance,
            )
            for fact in candidate.evidence
        )
        closed_as = resolution.original_label or resolution.closing_text
        findings.append(
            TicketFinding(
                interaction_id=interaction.id,
                opened_on=interaction.opened_at.date(),
                fragment=result.pipeline.fragment,
                closed_as=closed_as.replace("_", " "),
                evidence_indicated=f"{candidate.title} · {candidate.detail}",
                evidence=evidence,
                transcript=tuple(
                    TranscriptLine(
                        author=message.author,
                        sent_at=message.sent_at,
                        text=message.text,
                    )
                    for message in interaction.messages
                ),
                confidence=max(0.0, min(2.0, candidate.score)),
            )
        )
    return tuple(sorted(findings, key=lambda item: item.interaction_id))


def _report_risk_curve(
    interactions: Sequence[Interaction],
    results: Sequence[ReplayResult],
) -> tuple[ReportRiskCoveragePoint, ...]:
    """Build selective precision only from the complementary held-out records."""

    _, held_out_records = _alternating_fixture_split(interactions)
    results_by_id = {result.interaction_id: result for result in results}
    if len(results_by_id) != len(results):
        raise ValueError("replay results must have unique interaction ids")

    scores: list[float] = []
    correct: list[bool] = []
    ids: list[str] = []
    for interaction in held_out_records:
        try:
            result = results_by_id[interaction.id]
        except KeyError as exc:
            raise ValueError(
                f"missing replay result for held-out interaction {interaction.id}"
            ) from exc
        score, is_correct = _detector_prediction_label(interaction, result.pipeline)
        scores.append(score)
        correct.append(is_correct)
        ids.append(interaction.id)
    empirical = risk_coverage_curve(scores, correct, ids=ids)
    points = [
        ReportRiskCoveragePoint(
            coverage=point.coverage,
            precision=point.precision,
            selected=point.selected_count,
            correct=point.correct_count,
            errors=point.error_count,
            total=point.denominator,
        )
        for point in empirical
        if point.selected_count > 0 and point.precision is not None and point.threshold > -1.0
    ]
    if len(points) < 2:
        raise RuntimeError("fixture did not produce at least two non-empty risk-coverage points")
    return tuple(points)


def _audit_report(
    *,
    interactions: Sequence[Interaction],
    results: Sequence[ReplayResult],
    metrics: ReplayMetrics,
    benchmark: WinningBenchmark,
    calibration: ThresholdCalibration,
    held_out: SelectiveEvaluation,
    redaction_report: RedactionReport,
) -> AuditReport:
    by_id = {interaction.id: interaction for interaction in interactions}
    expected_judgments = [
        result
        for result in results
        if by_id[result.interaction_id].metadata.get("expected_detector") is not None
    ]
    expected_matches = sum(
        result.outcome == by_id[result.interaction_id].metadata.get("expected_replay_outcome")
        for result in expected_judgments
    )
    segment_keys = (("short", "<=5", "≤5 words"), ("medium", "6-15", "6–15 words"), ("long", "16+", "16+ words"))
    length_segments = tuple(
        LengthSegment(
            key=report_key,
            label=label,
            sample_size=metrics.by_fragment_length[bucket].denominator,
            agreements_at_3=metrics.by_fragment_length[bucket].agreement_at_3.numerator,
        )
        for report_key, bucket, label in segment_keys
    )
    provenance = metrics.provenance_distribution
    run_date = max(interaction.opened_at.date() for interaction in interactions) + timedelta(days=1)
    return AuditReport(
        organization=DEMO_ORGANIZATION,
        corpus_name=DEMO_CORPUS_NAME,
        period_start=min(interaction.opened_at.date() for interaction in interactions),
        period_end=max(interaction.opened_at.date() for interaction in interactions),
        run_date=run_date,
        benchmark=BenchmarkResult(
            sample_size=benchmark.sample_size,
            semantic_hits_at_3=benchmark.semantic_hits_at_3,
            bm25_hits_at_3=benchmark.bm25_hits_at_3,
            semantic_model=benchmark.model_id,
            dataset_fingerprint=benchmark.dataset_fingerprint,
        ),
        outcomes=OutcomeCounts(
            analyzed=metrics.sample_size,
            agreement_at_1=metrics.overall.agreement_at_1.numerator,
            agreement_at_3=metrics.overall.agreement_at_3.numerator,
            abstained=metrics.overall.abstain.numerator,
            disagreements=metrics.overall.disagreement.numerator,
            human_reviewed=0,
        ),
        length_segments=length_segments,
        findings=_findings(interactions, results),
        provenance=ProvenanceDistribution(
            exported=provenance["exported"].numerator,
            reconstructed=provenance["reconstructed"].numerator,
            inferred=provenance["inferred"].numerator + provenance["none"].numerator,
        ),
        judge=JudgeValidation(
            sample_size=len(expected_judgments),
            agreements=expected_matches,
            method="Synthetic expected-outcome check only; no human inter-rater validation.",
            label_source="synthetic_oracle",
        ),
        redaction=RedactionDisclosure(
            entity_counts=redaction_report.entity_counts,
            messages_processed=redaction_report.messages_processed,
            messages_changed=redaction_report.messages_changed,
            text_values_processed=redaction_report.text_values_processed,
            text_values_changed=redaction_report.text_values_changed,
            detectors=redaction_report.detectors,
            method=(
                "deterministic defense-in-depth rescan of the pre-redacted synthetic "
                "fixture before replay; counts are not customer-data prevalence"
            ),
        ),
        risk_coverage=_report_risk_curve(interactions, results),
        risk_coverage_method=(
            "empirical selective precision on the complementary held-out synthetic split; "
            "correct iff the pre-threshold top detector ID matches fixture expected_detector; "
            "missing candidates and records without an expected detector count as incorrect"
        ),
        limits=(
            "All interactions, state records, fragments, and resolutions are synthetic fixtures; no rate is a production estimate.",
            "Contradictory resolutions were authored to exercise replay disagreement handling, not discovered in customer support data.",
            "The confidence floor was calibrated and evaluated on alternating halves of this same synthetic corpus; external calibration is still required.",
            f"Calibration n={calibration.denominator}; held-out n={held_out.denominator}. The displayed risk–coverage curve uses only the held-out labels from fixture metadata, never replay agreement with the authored resolution.",
            "The judge comparison uses fixture expectations and has not been hand-checked by 50–100 human reviewers.",
            "Every state snapshot uses exported synthetic facts, so this run does not measure reconstruction error or degraded text-only performance.",
        ),
    )


def run_fixture_audit(
    *,
    output_dir: Path = DEFAULT_OUTPUT_DIR,
    benchmark_path: Path = DEFAULT_BENCHMARK_PATH,
    cache_dir: Path = DEFAULT_CACHE_DIR,
    embedder: Any | None = None,
    progress_stream: TextIO | None = None,
) -> FixtureAuditRun:
    """Execute the fixture audit offline and write canonical JSON and HTML."""

    progress = _FixtureProgress(progress_stream)
    with progress.stage("benchmark"):
        benchmark = load_winning_benchmark(benchmark_path)
    with progress.stage("model"):
        if embedder is None:
            embedder = SentenceTransformerEmbedder(
                model_id=benchmark.model_id,
                revision=benchmark.revision,
                cache_dir=cache_dir,
                offline=True,
                seed=benchmark.seed,
                device="cpu",
                model_factory=_offline_sentence_transformer_factory,
            )
            embedder.validate_model_available()
    with progress.stage("redaction"):
        raw_interactions = demo_interactions()
        redaction_report = RedactionReport()
        fixture_redactor = Redactor()
        redacted_interactions: list[Interaction] = []
        for interaction in raw_interactions:
            redacted, item_report = fixture_redactor.redact_interaction(interaction)
            redacted_interactions.append(redacted)
            redaction_report = redaction_report.merge(item_report)
        interactions = tuple(redacted_interactions)
    with progress.stage("calibration"):
        calibration, held_out = _calibrate_fixture(
            interactions,
            embedder=embedder,
            redactor=fixture_redactor,
        )
    with progress.stage("replay"):
        pipeline = PipelineRunner(
            embedder=embedder,
            threshold=calibration,
            redactor=fixture_redactor,
        )
        # No provider is configured: ambiguous prefilter cases take ReplayJudge's
        # conservative deterministic yes/no/unclear fallback.
        judge = ReplayJudge(embedder=embedder, llm=None, redactor=fixture_redactor)
        replay = ReplayEngine(
            pipeline=pipeline,
            judge=judge,
            reconstructor=StateReconstructor(redactor=fixture_redactor),
            redactor=fixture_redactor,
        )
        results = replay.replay_many(interactions)
    with progress.stage("report"):
        metrics = aggregate_metrics(results)
        report = _audit_report(
            interactions=interactions,
            results=results,
            metrics=metrics,
            benchmark=benchmark,
            calibration=calibration,
            held_out=held_out,
            redaction_report=redaction_report,
        )
        json_path, html_path = build_report(report, output_dir)
    return FixtureAuditRun(
        report=report,
        replay_results=results,
        replay_metrics=metrics,
        calibration=calibration,
        held_out=held_out,
        redaction_report=redaction_report,
        model_id=benchmark.model_id,
        json_path=json_path,
        html_path=html_path,
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--benchmark", type=Path, default=DEFAULT_BENCHMARK_PATH)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument(
        "--progress-jsonl",
        action="store_true",
        help="write the fixed fixture-progress protocol to stderr",
    )
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    result = run_fixture_audit(
        output_dir=arguments.output_dir,
        benchmark_path=arguments.benchmark,
        cache_dir=arguments.cache_dir,
        progress_stream=sys.stderr if arguments.progress_jsonl else None,
    )
    counts = result.replay_metrics.overall
    print(f"Wrote {result.json_path}")
    print(f"Wrote {result.html_path}")
    print(
        "Synthetic outcomes: "
        f"agreement@1={counts.agreement_at_1.numerator}, "
        f"agreement@3={counts.agreement_at_3.numerator}, "
        f"abstain={counts.abstain.numerator}, "
        f"disagreement={counts.disagreement.numerator}; "
        f"n={counts.denominator}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

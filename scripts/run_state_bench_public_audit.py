#!/usr/bin/env python3
"""Run the pinned STATE-Bench support trajectories through Wordless offline.

This is a synthetic public-corpus feasibility audit, not a sellable ingest
adapter and not production evidence.  Benchmark task oracles are loaded into a
separate evaluation map; they are never attached to canonical interactions or
passed to the pipeline or replay judge.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date
from hashlib import sha256
import json
from pathlib import Path
from typing import Any, Literal, Mapping, Sequence

from wordless.core.embed import SentenceTransformerEmbedder
from wordless.core.models import Interaction, StateFact
from wordless.core.redact import RedactionReport
from wordless.ingest.state_bench import (
    STATE_BENCH_ARCHIVE_SHA256,
    STATE_BENCH_COMMIT,
    STATE_BENCH_LICENSE_URL,
    STATE_BENCH_REPOSITORY_URL,
    STATE_BENCH_VERSION,
    TASK_ENVS_RELATIVE,
    TASKS_RELATIVE,
    StateBenchCustomerSupportAdapter,
)
from wordless.pipeline.abstain import (
    RiskCoveragePoint,
    SelectiveEvaluation,
    ThresholdCalibration,
    calibrate_threshold,
    evaluate_threshold,
    risk_coverage_curve,
)
from wordless.pipeline.run import PipelineResult, PipelineRunner
from wordless.replay.engine import ReplayEngine, ReplayResult, fragment_length_bucket
from wordless.replay.judge import JudgeDecision, ReplayJudge
from wordless.replay.metrics import (
    InterRaterAgreement,
    ReplayMetrics,
    aggregate_metrics,
    inter_rater_agreement,
)
from wordless.report import AuditReport, build_report
from wordless.report.build import (
    BenchmarkResult,
    CalibrationDisclosure,
    EvidenceLine,
    JudgeValidation,
    LengthSegment,
    OutcomeCounts,
    ProvenanceDistribution,
    RedactionDisclosure,
    RiskCoveragePoint as ReportRiskCoveragePoint,
    SourceAttribution,
    TicketFinding,
    TranscriptLine,
)
from wordless.state import StateReconstructor

from scripts.download_state_bench import (
    ARCHIVE,
    file_digest,
    verified,
    verify_extracted_corpus,
)
from scripts.run_fixture_audit import WinningBenchmark, load_winning_benchmark


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CORPUS_DIR = REPOSITORY_ROOT / ".wordless" / "public" / "state-bench-v0.8.1"
DEFAULT_ARCHIVE_PATH = DEFAULT_CORPUS_DIR / ARCHIVE.filename
DEFAULT_BENCHMARK_PATH = REPOSITORY_ROOT / "bench" / "results" / "benchmark.json"
DEFAULT_OUTPUT_DIR = REPOSITORY_ROOT / "outputs" / "statebench-public-audit"
DEFAULT_CACHE_DIR = REPOSITORY_ROOT / ".wordless" / "cache" / "embeddings"
STATE_BENCH_RUN_DATE = date(2026, 7, 25)
STATE_BENCH_EXPECTED_INTERACTIONS = 100
_PUBLIC_FIXTURE_SALT = b"wordless:state-bench-v0.8.1:public-synthetic-fixture"
_SPLIT_SEED = "wordless-state-bench-v0.8.1|"
_ORACLE_SOURCE_SHA256 = (
    "7527ab4863761ae68c30dd5cf05a0e6a79706e3989c4b7c6b074d7b148015651"
)
_FORBIDDEN_RUNTIME_METADATA = {
    "oracle",
    "requirement",
    "score",
    "simulator",
    "state_diff",
    "summary",
    "task_type",
}


@dataclass(frozen=True)
class OracleRow:
    """Audited task-oracle label kept outside runtime interactions."""

    task_id: str
    evidence_order_id: str
    risk_correct: bool
    judge_expected: JudgeDecision
    state_requirements_pass: bool = True
    source_pointers: tuple[str, ...] = (
        "/task_summary",
        "/task_requirements",
        "/state_requirements",
    )


_ORACLE_ROWS: tuple[OracleRow, ...] = (
    OracleRow("20-shipping_high_value_lost", "ORD-6002", True, "yes"),
    OracleRow("25-shipping_stuck_in_transit", "ORD-6027", True, "yes", False),
    OracleRow("45-compound_partial_cancel_return", "ORD-6047", False, "unclear"),
    OracleRow(
        "60-challenge_low_value_lost_immediate", "ORD-7052", True, "yes", False
    ),
    OracleRow(
        "85-high_value_lost_hold_dependent_sleeve",
        "ORD-7851",
        True,
        "unclear",
        False,
    ),
    OracleRow("124-hard_shipping_stuck_tracking_treat_lost", "ORD-7227", True, "yes"),
    OracleRow("141-spare_compound_cancel_plus_shipping_claim", "ORD-7276", False, "unclear"),
    OracleRow("148-spare_cancel_after_shipment_keep_delivered", "ORD-7280", False, "no"),
    OracleRow(
        "149-hard_cancel_delivered_pivot_return", "ORD-7262", False, "no", False
    ),
    OracleRow("150-spare_cancel_in_transit_fee_decline", "ORD-7281", False, "no"),
)
_ORACLE_BY_TASK = {row.task_id: row for row in _ORACLE_ROWS}


@dataclass(frozen=True)
class StateBenchSplit:
    development: tuple[Interaction, ...]
    calibration: tuple[Interaction, ...]
    held_out: tuple[Interaction, ...]


@dataclass(frozen=True)
class StateBenchAuditRun:
    report: AuditReport
    interactions: tuple[Interaction, ...]
    replay_results: tuple[ReplayResult, ...]
    replay_metrics: ReplayMetrics
    calibration: ThresholdCalibration
    held_out: SelectiveEvaluation
    judge_validation: InterRaterAgreement
    risk_coverage: tuple[RiskCoveragePoint, ...]
    redaction_report: RedactionReport
    split: StateBenchSplit
    model_id: str
    json_path: Path
    html_path: Path


def _offline_sentence_transformer_factory(model_id: str, **kwargs: Any) -> Any:
    kwargs.pop("cache_folder", None)
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(model_id, **kwargs)


def _task_id(interaction: Interaction) -> str:
    value = interaction.metadata.get("task_id")
    if not isinstance(value, str) or not value:
        raise ValueError(f"interaction {interaction.id!r} has no STATE-Bench task_id")
    return value


def _assert_oracle_separation(interactions: Sequence[Interaction]) -> None:
    for interaction in interactions:
        if interaction.resolution is None or interaction.resolution.original_label is not None:
            raise RuntimeError("STATE-Bench runtime resolutions must have a null oracle label")
        for key, value in interaction.metadata.items():
            normalized = str(key).casefold()
            if any(token in normalized for token in _FORBIDDEN_RUNTIME_METADATA):
                raise RuntimeError(f"oracle-bearing runtime metadata key: {key}")
            if normalized.startswith("expected_") and value not in (None, "", (), [], {}):
                raise RuntimeError(f"non-empty expected runtime metadata key: {key}")


def _read_object(path: Path) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"could not read pinned oracle source {path}") from exc
    if not isinstance(value, Mapping):
        raise ValueError(f"pinned oracle source must be an object: {path}")
    return value


def _verify_oracle_manifest(corpus_dir: Path) -> None:
    """Fail closed if the pinned task files no longer support the frozen rows."""

    fingerprint = sha256()
    for row in sorted(_ORACLE_ROWS, key=lambda item: item.task_id):
        task_relative = TASKS_RELATIVE / f"{row.task_id}.json"
        environment_relative = TASK_ENVS_RELATIVE / f"{row.task_id}.json"
        for relative in (task_relative, environment_relative):
            path = corpus_dir / relative
            try:
                payload = path.read_bytes()
            except OSError as exc:
                raise ValueError(f"could not read pinned oracle source {path}") from exc
            fingerprint.update(relative.as_posix().encode("utf-8"))
            fingerprint.update(b"\0")
            fingerprint.update(payload)
            fingerprint.update(b"\0")
        task = _read_object(corpus_dir / task_relative)
        environment = _read_object(corpus_dir / environment_relative)
        if task.get("task_id") != row.task_id:
            raise RuntimeError(f"oracle task ID mismatch for {row.task_id}")
        if not isinstance(task.get("task_summary"), str) or not task["task_summary"].strip():
            raise RuntimeError(f"oracle task summary missing for {row.task_id}")
        if not isinstance(task.get("task_requirements"), list):
            raise RuntimeError(f"oracle task requirements missing for {row.task_id}")
        if not isinstance(task.get("state_requirements"), list):
            raise RuntimeError(f"oracle state requirements missing for {row.task_id}")
        orders = environment.get("orders")
        if not isinstance(orders, list) or row.evidence_order_id not in {
            order.get("order_id") for order in orders if isinstance(order, Mapping)
        }:
            raise RuntimeError(
                f"oracle evidence order {row.evidence_order_id} missing for {row.task_id}"
            )
    if fingerprint.hexdigest() != _ORACLE_SOURCE_SHA256:
        raise RuntimeError(
            "STATE-Bench frozen oracle sources differ from the reviewed v0.8.1 "
            f"manifest; expected sha256:{_ORACLE_SOURCE_SHA256}"
        )


def _stable_key(interaction: Interaction) -> tuple[str, str]:
    task_id = _task_id(interaction)
    digest = sha256(f"{_SPLIT_SEED}{task_id}".encode("utf-8")).hexdigest()
    return digest, task_id


def _take_stratum(
    values: Sequence[Interaction],
    quotas: tuple[int, int, int],
) -> tuple[tuple[Interaction, ...], tuple[Interaction, ...], tuple[Interaction, ...]]:
    ordered = tuple(sorted(values, key=_stable_key))
    if len(ordered) != sum(quotas):
        raise RuntimeError(
            f"STATE-Bench frozen stratum expected {sum(quotas)} rows, found {len(ordered)}"
        )
    dev_end = quotas[0]
    calibration_end = dev_end + quotas[1]
    return (
        ordered[:dev_end],
        ordered[dev_end:calibration_end],
        ordered[calibration_end:],
    )


def _frozen_split(
    interactions: Sequence[Interaction],
    exploratory: Mapping[str, PipelineResult],
) -> StateBenchSplit:
    by_task = {_task_id(interaction): interaction for interaction in interactions}
    eligible = {
        task_id
        for task_id, result in exploratory.items()
        if result.ranked_candidates
    }
    if eligible != set(_ORACLE_BY_TASK):
        missing = sorted(set(_ORACLE_BY_TASK) - eligible)
        unexpected = sorted(eligible - set(_ORACLE_BY_TASK))
        raise RuntimeError(
            "STATE-Bench detector eligibility changed; "
            f"missing={missing}, unexpected={unexpected}"
        )

    positive = [by_task[task_id] for task_id in eligible if _ORACLE_BY_TASK[task_id].risk_correct]
    negative = [by_task[task_id] for task_id in eligible if not _ORACLE_BY_TASK[task_id].risk_correct]
    no_medium: list[Interaction] = []
    no_long: list[Interaction] = []
    no_short: list[Interaction] = []
    for task_id, interaction in by_task.items():
        if task_id in eligible:
            continue
        bucket = fragment_length_bucket(exploratory[task_id].fragment)
        if bucket == "<=5":
            no_short.append(interaction)
        elif bucket == "6-15":
            no_medium.append(interaction)
        else:
            no_long.append(interaction)
    if no_short or len(no_medium) != 17 or len(no_long) != 73:
        raise RuntimeError(
            "STATE-Bench fragment strata changed; expected 0/17/73 short/medium/long "
            f"no-hypothesis rows, found {len(no_short)}/{len(no_medium)}/{len(no_long)}"
        )

    strata = (
        _take_stratum(positive, (1, 2, 2)),
        _take_stratum(negative, (1, 2, 2)),
        _take_stratum(no_medium, (3, 7, 7)),
        _take_stratum(no_long, (15, 29, 29)),
    )
    development = tuple(value for stratum in strata for value in stratum[0])
    calibration = tuple(value for stratum in strata for value in stratum[1])
    held_out = tuple(value for stratum in strata for value in stratum[2])
    if (len(development), len(calibration), len(held_out)) != (20, 40, 40):
        raise RuntimeError("STATE-Bench frozen split must be 20/40/40")
    combined = {_task_id(item) for item in (*development, *calibration, *held_out)}
    if combined != set(by_task):
        raise RuntimeError("STATE-Bench frozen split does not partition the corpus")
    return StateBenchSplit(
        development=tuple(sorted(development, key=_stable_key)),
        calibration=tuple(sorted(calibration, key=_stable_key)),
        held_out=tuple(sorted(held_out, key=_stable_key)),
    )


def _labeled_prediction(
    interaction: Interaction,
    result: PipelineResult,
) -> tuple[float, bool]:
    if not result.ranked_candidates:
        return -1.0, False
    if len(result.ranked_candidates) != 1:
        raise RuntimeError("STATE-Bench frozen oracle expects one detector candidate")
    task_id = _task_id(interaction)
    row = _ORACLE_BY_TASK.get(task_id)
    if row is None:
        raise RuntimeError(f"candidate-bearing task lacks frozen oracle row: {task_id}")
    candidate = result.ranked_candidates[0]
    if candidate.detector_id != "late_delivery":
        raise RuntimeError(
            f"STATE-Bench frozen oracle does not label detector {candidate.detector_id}"
        )
    return candidate.score, row.risk_correct


def _calibrate(
    split: StateBenchSplit,
    exploratory: Mapping[str, PipelineResult],
) -> tuple[ThresholdCalibration, SelectiveEvaluation]:
    calibration_predictions = tuple(
        _labeled_prediction(interaction, exploratory[_task_id(interaction)])
        for interaction in split.calibration
    )
    held_out_predictions = tuple(
        _labeled_prediction(interaction, exploratory[_task_id(interaction)])
        for interaction in split.held_out
    )
    calibration = calibrate_threshold(
        [score for score, _ in calibration_predictions],
        [correct for _, correct in calibration_predictions],
        target_precision=0.50,
        minimum_coverage=0.05,
        calibration_split=(
            "40-record calibration partition from the frozen stratified 20/40/40 split"
        ),
        ids=[_task_id(interaction) for interaction in split.calibration],
    )
    held_out = evaluate_threshold(
        [score for score, _ in held_out_predictions],
        [correct for _, correct in held_out_predictions],
        threshold=calibration.threshold,
        evaluation_split=(
            "40-record held-out partition from the frozen stratified 20/40/40 split"
        ),
        ids=[_task_id(interaction) for interaction in split.held_out],
    )
    return calibration, held_out


def _held_out_risk_curve(
    split: StateBenchSplit,
    exploratory: Mapping[str, PipelineResult],
) -> tuple[RiskCoveragePoint, ...]:
    values = tuple(
        _labeled_prediction(interaction, exploratory[_task_id(interaction)])
        for interaction in split.held_out
    )
    curve = risk_coverage_curve(
        [score for score, _ in values],
        [correct for _, correct in values],
        ids=[_task_id(interaction) for interaction in split.held_out],
    )
    # A score of -1 represents no prediction.  Its full-coverage point is not
    # an accepted-candidate operating point and must never enter the report.
    return tuple(
        point
        for point in curve
        if point.selected_count > 0
        and point.precision is not None
        and point.threshold > -1.0
    )


def _synthetic_oracle_judge_validation(
    interactions: Sequence[Interaction],
    exploratory: Mapping[str, PipelineResult],
    judge: ReplayJudge,
) -> InterRaterAgreement:
    by_task = {_task_id(interaction): interaction for interaction in interactions}
    predicted: list[JudgeDecision] = []
    expected: list[JudgeDecision] = []
    for row in sorted(_ORACLE_ROWS, key=lambda item: int(item.task_id.split("-", 1)[0])):
        interaction = by_task[row.task_id]
        resolution = interaction.resolution
        if resolution is None:
            raise RuntimeError(f"STATE-Bench oracle task has no resolution: {row.task_id}")
        candidates = exploratory[row.task_id].ranked_candidates
        if len(candidates) != 1:
            raise RuntimeError(f"STATE-Bench oracle task must have one candidate: {row.task_id}")
        predicted.append(judge.judge(candidates[0], resolution).decision)
        expected.append(row.judge_expected)
    return inter_rater_agreement(predicted, expected)


def _field_text(fact: StateFact) -> str:
    values = ", ".join(
        f"{key.replace('_', ' ')}={value}"
        for key, value in sorted(fact.fields.items())
    )
    return f"{fact.kind} observed at logical contact time {fact.occurred_at.isoformat()}: {values}."


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
        resolution = interaction.resolution
        if resolution is None:
            continue
        candidate = result.pipeline.candidates[0]
        closed_as = (
            ", ".join(resolution.actions)
            if resolution.actions
            else resolution.closing_text
        )
        findings.append(
            TicketFinding(
                interaction_id=interaction.id,
                opened_on=interaction.opened_at.date(),
                fragment=result.pipeline.fragment,
                closed_as=closed_as,
                evidence_indicated=f"{candidate.title} · {candidate.detail}",
                evidence=tuple(
                    EvidenceLine(
                        source=fact.source,
                        text=_field_text(fact),
                        provenance=fact.provenance,
                    )
                    for fact in candidate.evidence
                ),
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
    return tuple(
        sorted(
            findings,
            key=lambda item: int(item.interaction_id.rsplit(":", 1)[-1].split("-", 1)[0]),
        )
    )


def _source_attribution() -> SourceAttribution:
    return SourceAttribution(
        title="STATE-Bench",
        creator="Microsoft",
        version=STATE_BENCH_VERSION,
        doi=None,
        url=f"{STATE_BENCH_REPOSITORY_URL}/tree/{STATE_BENCH_COMMIT}",
        license_name="MIT",
        license_url=STATE_BENCH_LICENSE_URL,
        citation=(
            "Microsoft, STATE-Bench v0.8.1, customer-support train trajectories "
            f"(commit {STATE_BENCH_COMMIT})."
        ),
        commit=STATE_BENCH_COMMIT,
        archive_sha256=STATE_BENCH_ARCHIVE_SHA256,
    )


def _report_risk_points(
    curve: Sequence[RiskCoveragePoint],
) -> tuple[ReportRiskCoveragePoint, ...]:
    return tuple(
        ReportRiskCoveragePoint(
            coverage=point.coverage,
            precision=point.precision,
            selected=point.selected_count,
            correct=point.correct_count,
            errors=point.error_count,
            total=point.denominator,
            method="accepted predictions / held-out synthetic-oracle records",
        )
        for point in curve
        if point.precision is not None
    )


def _audit_report(
    *,
    interactions: Sequence[Interaction],
    results: Sequence[ReplayResult],
    metrics: ReplayMetrics,
    benchmark: WinningBenchmark,
    calibration: ThresholdCalibration,
    held_out: SelectiveEvaluation,
    judge_validation: InterRaterAgreement,
    risk_curve: Sequence[RiskCoveragePoint],
    redaction_report: RedactionReport,
) -> AuditReport:
    evidence_eligible = sum(bool(result.pipeline.hypotheses) for result in results)
    calibration_correct = int(round((calibration.precision or 0.0) * calibration.selected_count))
    segment_keys = (
        ("short", "<=5", "≤5 words"),
        ("medium", "6-15", "6–15 words"),
        ("long", "16+", "16+ words"),
    )
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
    segment_counts = {
        bucket: metrics.by_fragment_length[bucket].denominator
        for bucket in ("<=5", "6-15", "16+")
    }
    no_hypothesis = sum(
        result.outcome == "abstain"
        and result.pipeline.abstention_reason == "no_evidence_hypotheses"
        for result in results
    )
    below_floor = sum(
        result.outcome == "abstain"
        and result.pipeline.abstention_reason == "below_confidence_floor"
        for result in results
    )
    judge_unclear = sum(
        result.outcome == "abstain" and result.abstention_reason == "judge_unclear"
        for result in results
    )
    task_by_interaction_id = {
        interaction.id: _task_id(interaction) for interaction in interactions
    }
    finding_task_ids = {
        task_by_interaction_id[result.interaction_id]
        for result in results
        if result.outcome == "disagreement"
    }
    flagged_state_failures = sorted(
        int(task_id.split("-", 1)[0])
        for task_id in finding_task_ids
        if not _ORACLE_BY_TASK[task_id].state_requirements_pass
    )
    all_state_failures = sorted(
        int(row.task_id.split("-", 1)[0])
        for row in _ORACLE_ROWS
        if not row.state_requirements_pass
    )
    return AuditReport(
        organization="Microsoft STATE-Bench · synthetic public corpus",
        corpus_name="STATE-Bench v0.8.1 · customer_support train trajectories",
        period_start=min(interaction.opened_at.date() for interaction in interactions),
        period_end=max(interaction.opened_at.date() for interaction in interactions),
        run_date=STATE_BENCH_RUN_DATE,
        benchmark=BenchmarkResult(
            sample_size=benchmark.sample_size,
            semantic_hits_at_3=benchmark.semantic_hits_at_3,
            bm25_hits_at_3=benchmark.bm25_hits_at_3,
            semantic_model=benchmark.model_id,
            dataset_fingerprint=benchmark.dataset_fingerprint,
        ),
        outcomes=OutcomeCounts(
            analyzed=metrics.sample_size,
            evidence_eligible=evidence_eligible,
            evidence_eligibility_method=(
                "interactions with a current state detector hypothesis before the weak "
                "synthetic feasibility floor"
            ),
            agreement_at_1=metrics.overall.agreement_at_1.numerator,
            agreement_at_3=metrics.overall.agreement_at_3.numerator,
            abstained=metrics.overall.abstain.numerator,
            disagreements=metrics.overall.disagreement.numerator,
            human_reviewed=0,
            method=(
                "deterministic replay at a deliberately weak 50% synthetic-oracle "
                "feasibility operating point; flags are unverified"
            ),
        ),
        length_segments=length_segments,
        findings=_findings(interactions, results),
        provenance=ProvenanceDistribution(
            exported=provenance["exported"].numerator,
            reconstructed=provenance["reconstructed"].numerator,
            inferred=(
                provenance["inferred"].numerator + provenance["none"].numerator
            ),
        ),
        judge=JudgeValidation(
            sample_size=judge_validation.sample_size,
            agreements=judge_validation.exact_matches,
            cohen_kappa=judge_validation.cohen_kappa,
            label_source="synthetic_oracle",
            method=(
                "Frozen ten-row STATE-Bench task oracle over all detector-bearing "
                "trajectories; compound resolutions use unclear where the detector title "
                "cannot map unambiguously to one recorded action."
            ),
        ),
        redaction=RedactionDisclosure(
            entity_counts=redaction_report.entity_counts,
            messages_processed=redaction_report.messages_processed,
            messages_changed=redaction_report.messages_changed,
            text_values_processed=redaction_report.text_values_processed,
            text_values_changed=redaction_report.text_values_changed,
            detectors=redaction_report.detectors,
            method=(
                "mandatory deterministic ingest redaction over all synthetic source "
                "text before replay; exported structured product names with a fully "
                "scanned sibling catalog identifier are replaced by non-name product "
                "references so comparison signal remains without a PERSON bypass"
            ),
        ),
        replay_metrics=metrics,
        calibration=CalibrationDisclosure(
            threshold=calibration.threshold,
            target_precision=calibration.target_precision,
            development_total=20,
            calibration_total=calibration.denominator,
            calibration_selected=calibration.selected_count,
            calibration_correct=calibration_correct,
            held_out_total=held_out.denominator,
            held_out_selected=held_out.selected_count,
            held_out_correct=held_out.correct_count,
            method=(
                "frozen stratified 20 development / 40 calibration / 40 held-out split; "
                "only calibration labels fit the floor and only held-out labels build "
                "risk–coverage"
            ),
            purpose=(
                "This deliberately weak operating point exists to exercise the complete "
                "synthetic report; it is not a publishable or production threshold."
            ),
        ),
        risk_coverage=_report_risk_points(risk_curve),
        risk_coverage_method=(
            "empirical selective precision on only the frozen 40-record held-out split; "
            "binary correctness comes from the separate pinned task-oracle manifest; "
            "score=-1 no-prediction records never appear as accepted coverage"
        ),
        source_attribution=_source_attribution(),
        evidence_headline="Unverified synthetic replay flags",
        findings_intro=(
            "These are raw engine disagreements at the weak synthetic feasibility floor. "
            "They require review and are not verified resolution-correctness findings."
        ),
        abstention_note=(
            f"{metrics.overall.abstain.numerator} of {metrics.sample_size} interactions "
            f"abstained: {no_hypothesis} had no detector hypothesis, {below_floor} "
            f"fell below the calibrated floor, and {judge_unclear} reached an unclear "
            "fallback-judge decision."
        ),
        limits=(
            "STATE-Bench discloses that these tasks, users, records, and trajectories were synthetically generated with language models; no rate is a production estimate.",
            "The 50% target precision is intentionally weak and was chosen only to exercise the complete feasibility report. It must not be used as a deployment threshold.",
            "Every listed item is an unverified synthetic replay flag. The separate task-oracle labels are used for disclosed validation and risk–coverage only; they do not convert a replay disagreement into a verified correctness finding.",
            f"Synthetic-oracle judge validation was {judge_validation.exact_matches}/{judge_validation.sample_size} with Cohen's kappa {judge_validation.cohen_kappa:.3f}; no human judgment was collected.",
            f"The corpus has {segment_counts['<=5']} first messages at ≤5 words, {segment_counts['6-15']} at 6–15 words, and {segment_counts['16+']} at 16+ words. It cannot establish a short-fragment performance gap or any accessibility or equity effect.",
            "STATE-Bench supplies task.now but no per-turn wall-clock timestamps. Every message, exported snapshot, and resolution uses that logical time and is labeled temporal_granularity=task_now.",
            "Only a minimal task-user account-presence fact and linked order shipment state are exported to runtime. Task summaries, simulator instructions, task/state requirements, scores, and state diffs remain outside runtime inputs.",
            f"The separate ten-task oracle source manifest is byte-pinned as sha256:{_ORACLE_SOURCE_SHA256}; it is used only after runtime replay for evaluation.",
            "Separate pinned structured-state checks fail for eligible tasks "
            f"{', '.join(map(str, all_state_failures))}; among the current listed flags, "
            f"the failing task IDs are {', '.join(map(str, flagged_state_failures)) or 'none'}. "
            "These checks are evaluation-only. Conversation requirements still require "
            "an LLM judge and are not claimed as passing.",
            "The frozen oracle manifest and 20/40/40 split were defined after a detector-eligibility scan of the pinned corpus; only the held-out labels are used for the displayed risk–coverage curve.",
            "Recorded resolutions are generated agent trajectories and successful confirmed tool calls, not outcomes independently verified by customers or a support organization.",
            "The Module 0 result is a separate hand-authored closed-set retrieval benchmark; it does not validate STATE-Bench resolution correctness.",
        ),
    )


def run_state_bench_public_audit(
    *,
    corpus_dir: Path = DEFAULT_CORPUS_DIR,
    archive_path: Path | None = None,
    output_dir: Path = DEFAULT_OUTPUT_DIR,
    benchmark_path: Path = DEFAULT_BENCHMARK_PATH,
    cache_dir: Path = DEFAULT_CACHE_DIR,
    embedder: Any | None = None,
    verify_source: bool = True,
) -> StateBenchAuditRun:
    """Execute the pinned synthetic replay offline and write canonical artifacts."""

    corpus_dir = Path(corpus_dir)
    if verify_source:
        source_archive = Path(archive_path) if archive_path is not None else corpus_dir / ARCHIVE.filename
        if not verified(source_archive, ARCHIVE):
            raise RuntimeError(
                "STATE-Bench audit requires the exact verified archive: "
                f"sha256:{STATE_BENCH_ARCHIVE_SHA256}"
            )
        verify_extracted_corpus(source_archive, corpus_dir, ARCHIVE)

    benchmark = load_winning_benchmark(benchmark_path)
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

    adapter = StateBenchCustomerSupportAdapter(corpus_salt=_PUBLIC_FIXTURE_SALT)
    interactions = tuple(adapter.load(corpus_dir))
    if len(interactions) != STATE_BENCH_EXPECTED_INTERACTIONS:
        raise RuntimeError(
            f"pinned STATE-Bench corpus expected {STATE_BENCH_EXPECTED_INTERACTIONS} "
            f"interactions, found {len(interactions)}"
        )
    _assert_oracle_separation(interactions)
    _verify_oracle_manifest(corpus_dir)

    exploratory_runner = PipelineRunner(
        embedder=embedder,
        threshold=0.0,
        redactor=adapter.redactor,
    )
    exploratory_results = {
        _task_id(interaction): exploratory_runner.run(interaction)
        for interaction in interactions
    }
    split = _frozen_split(interactions, exploratory_results)
    calibration, held_out = _calibrate(split, exploratory_results)
    curve = _held_out_risk_curve(split, exploratory_results)

    judge = ReplayJudge(embedder=embedder, llm=None, redactor=adapter.redactor)
    judge_validation = _synthetic_oracle_judge_validation(
        interactions,
        exploratory_results,
        judge,
    )
    replay = ReplayEngine(
        pipeline=PipelineRunner(
            embedder=embedder,
            threshold=calibration,
            redactor=adapter.redactor,
        ),
        judge=judge,
        reconstructor=StateReconstructor(redactor=adapter.redactor),
        redactor=adapter.redactor,
    )
    results = replay.replay_many(interactions)
    metrics = aggregate_metrics(results)

    report = _audit_report(
        interactions=interactions,
        results=results,
        metrics=metrics,
        benchmark=benchmark,
        calibration=calibration,
        held_out=held_out,
        judge_validation=judge_validation,
        risk_curve=curve,
        redaction_report=adapter.redaction_report,
    )
    json_path, html_path = build_report(report, output_dir)
    return StateBenchAuditRun(
        report=report,
        interactions=interactions,
        replay_results=results,
        replay_metrics=metrics,
        calibration=calibration,
        held_out=held_out,
        judge_validation=judge_validation,
        risk_coverage=curve,
        redaction_report=adapter.redaction_report,
        split=split,
        model_id=benchmark.model_id,
        json_path=json_path,
        html_path=html_path,
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus-dir", type=Path, default=DEFAULT_CORPUS_DIR)
    parser.add_argument("--archive", type=Path, default=None)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--benchmark", type=Path, default=DEFAULT_BENCHMARK_PATH)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    result = run_state_bench_public_audit(
        corpus_dir=arguments.corpus_dir,
        archive_path=arguments.archive,
        output_dir=arguments.output_dir,
        benchmark_path=arguments.benchmark,
        cache_dir=arguments.cache_dir,
    )
    counts = result.replay_metrics.overall
    print(f"Wrote {result.json_path} sha256:{file_digest(result.json_path)}")
    print(f"Wrote {result.html_path} sha256:{file_digest(result.html_path)}")
    print(
        "STATE-Bench synthetic outcome: "
        f"agreement@1={counts.agreement_at_1.numerator}, "
        f"agreement@3={counts.agreement_at_3.numerator}, "
        f"abstain={counts.abstain.numerator}, "
        f"unverified_flags={counts.disagreement.numerator}; n={counts.denominator}; "
        f"human_reviewed={result.report.outcomes.human_reviewed}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

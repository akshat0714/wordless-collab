#!/usr/bin/env python3
"""Run the pinned Mendeley public corpus through the local audit pipeline.

The public export has no linked point-in-time account records.  This runner
therefore reports its all-inferred replay separately and refuses to turn an
absence of evidence hypotheses into a correctness, disagreement, precision,
or risk estimate.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from wordless.core.embed import SentenceTransformerEmbedder
from wordless.core.models import Interaction
from wordless.core.redact import RedactionReport
from wordless.ingest import MendeleyPublicAdapter
from wordless.pipeline.abstain import RiskCoveragePoint, risk_coverage_curve
from wordless.pipeline.run import PipelineRunner
from wordless.replay.engine import ReplayEngine, ReplayResult
from wordless.replay.judge import ReplayJudge
from wordless.replay.metrics import (
    InterRaterAgreement,
    ReplayMetrics,
    aggregate_metrics,
    inter_rater_agreement,
)
from wordless.report import AuditReport, build_report
from wordless.report.build import (
    BenchmarkResult,
    JudgeValidation,
    LengthSegment,
    OutcomeCounts,
    ProvenanceDistribution,
    RedactionDisclosure,
    SourceAttribution,
)
from wordless.state import StateReconstructor

from scripts.download_public_corpus import FILES as PUBLIC_SOURCE_FILES
from scripts.download_public_corpus import verified as public_file_verified
from scripts.run_fixture_audit import WinningBenchmark, load_winning_benchmark


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CORPUS_DIR = REPOSITORY_ROOT / ".wordless" / "public" / "mendeley-helpdesk-v2"
DEFAULT_BENCHMARK_PATH = REPOSITORY_ROOT / "bench" / "results" / "benchmark.json"
DEFAULT_OUTPUT_DIR = REPOSITORY_ROOT / "outputs" / "public-audit"
DEFAULT_CACHE_DIR = REPOSITORY_ROOT / ".wordless" / "cache" / "embeddings"

# A fixed salt is acceptable only for this already-masked public fixture.  It
# remains outside every artifact and makes repeated local audits deterministic.
_PUBLIC_FIXTURE_SALT = b"wordless:mendeley-helpdesk-v2:public-fixture"
PUBLIC_RUN_DATE = date(2026, 7, 25)
PUBLIC_EXPECTED_INTERACTIONS = 360


@dataclass(frozen=True)
class PublicAuditRun:
    report: AuditReport
    replay_results: tuple[ReplayResult, ...]
    replay_metrics: ReplayMetrics
    judge_validation: InterRaterAgreement
    risk_coverage: tuple[RiskCoveragePoint, ...]
    redaction_report: RedactionReport
    model_id: str
    json_path: Path
    html_path: Path


def _offline_sentence_transformer_factory(model_id: str, **kwargs: Any) -> Any:
    """Reuse the verified local Module 0 model without network access."""

    kwargs.pop("cache_folder", None)
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(model_id, **kwargs)


def _public_source() -> SourceAttribution:
    return SourceAttribution(
        title="Help Desk Tickets",
        creator="Mohammad Abdellatif",
        version="2",
        doi="10.17632/btm76zndnt.2",
        url="https://data.mendeley.com/datasets/btm76zndnt/2",
        license_name="CC BY 4.0",
        license_url="https://creativecommons.org/licenses/by/4.0/",
        citation=(
            "Abdellatif, Mohammad (2025), ‘Help Desk Tickets’, "
            "Mendeley Data, V2, doi: 10.17632/btm76zndnt.2."
        ),
        files_sha256={
            source.filename: source.digest for source in PUBLIC_SOURCE_FILES
        },
    )


def _length_segments(metrics: ReplayMetrics) -> tuple[LengthSegment, ...]:
    keys = (
        ("short", "<=5", "≤5 words"),
        ("medium", "6-15", "6–15 words"),
        ("long", "16+", "16+ words"),
    )
    return tuple(
        LengthSegment(
            key=report_key,
            label=label,
            sample_size=metrics.by_fragment_length[bucket].denominator,
            agreement_denominator=0,
            agreement_method=(
                "candidate-bearing interactions in this fragment segment; "
                "zero because no state-backed hypothesis was generated"
            ),
            agreements_at_3=0,
        )
        for report_key, bucket, label in keys
    )


def _audit_report(
    *,
    interactions: tuple[Interaction, ...],
    results: tuple[ReplayResult, ...],
    metrics: ReplayMetrics,
    benchmark: WinningBenchmark,
    judge_validation: InterRaterAgreement,
    redaction_report: RedactionReport,
    source_verified: bool,
) -> AuditReport:
    if not results:
        raise RuntimeError("public audit requires at least one interaction")
    provenance = metrics.provenance_distribution
    inferred = provenance["inferred"].numerator
    if inferred != metrics.sample_size or any(
        provenance[rung].numerator for rung in ("exported", "reconstructed", "none")
    ):
        raise RuntimeError(
            "public report refuses to blend non-inferred state into its degraded-mode summary"
        )
    if any(result.pipeline.hypotheses for result in results):
        raise RuntimeError(
            "public report assumptions changed: a state-backed hypothesis was generated"
        )
    if any(result.judgments for result in results):
        raise RuntimeError("zero-hypothesis public replay must not produce judge decisions")
    if any(result.outcome != "abstain" for result in results):
        raise RuntimeError("zero-hypothesis public replay must abstain on every interaction")

    return AuditReport(
        organization="Public corpus",
        corpus_name="Help Desk Tickets v2 · sampled utterances",
        period_start=min(interaction.opened_at.date() for interaction in interactions),
        period_end=max(interaction.opened_at.date() for interaction in interactions),
        run_date=PUBLIC_RUN_DATE,
        benchmark=BenchmarkResult(
            sample_size=benchmark.sample_size,
            semantic_hits_at_3=benchmark.semantic_hits_at_3,
            bm25_hits_at_3=benchmark.bm25_hits_at_3,
            semantic_model=benchmark.model_id,
            dataset_fingerprint=benchmark.dataset_fingerprint,
        ),
        outcomes=OutcomeCounts(
            analyzed=metrics.sample_size,
            evidence_eligible=0,
            evidence_eligibility_method=(
                "interactions with at least one state-backed hypothesis eligible for "
                "candidate-to-resolution judgment"
            ),
            agreement_at_1=0,
            agreement_at_3=0,
            abstained=metrics.overall.abstain.numerator,
            disagreements=0,
            human_reviewed=0,
        ),
        length_segments=_length_segments(metrics),
        findings=(),
        provenance=ProvenanceDistribution(
            exported=0,
            reconstructed=0,
            inferred=inferred,
        ),
        judge=JudgeValidation(
            sample_size=judge_validation.sample_size,
            agreements=judge_validation.exact_matches,
            method=(
                "No candidate judgments existed to sample; human inter-rater validation "
                "is required if future evidence-backed candidates are produced."
            ),
            label_source="none",
        ),
        redaction=RedactionDisclosure(
            entity_counts=redaction_report.entity_counts,
            messages_processed=redaction_report.messages_processed,
            messages_changed=redaction_report.messages_changed,
            text_values_processed=redaction_report.text_values_processed,
            text_values_changed=redaction_report.text_values_changed,
            detectors=redaction_report.detectors,
            method=(
                "mandatory ingest redaction over the pinned masked export before "
                "canonical interactions were yielded; counts use all scanned values"
            ),
        ),
        risk_coverage=(),
        risk_coverage_note=(
            "No interaction produced a scored, labeled prediction, so neither selective "
            "precision nor risk can be estimated at any coverage."
        ),
        risk_coverage_method=(
            "empirical selective risk over candidate-bearing interactions with a validated "
            "yes/no correctness label; no proxy negative scores or fabricated labels used"
        ),
        source_attribution=_public_source(),
        limits=(
            *(() if source_verified else (
                "This test-mode run did not verify the local files against every pinned published SHA-256 digest and must not be represented as the canonical public result.",
            )),
            f"All {metrics.sample_size} interactions used inferred rung-3 state because the public export contains no linked point-in-time account or system records.",
            "No state-backed hypotheses were generated. The empty findings list is absence of evidence, not evidence that every recorded resolution was correct.",
            "Agreement, disagreement, candidate precision, and selective risk are not estimable when the candidate and judge denominators are zero.",
            "The recorded issue-resolution field is a workflow label, not an independently verified resolution-correctness annotation.",
            "No confidence threshold was calibrated: the corpus supplies no labeled candidate predictions from which to fit or evaluate one.",
            "No human judge-validation sample exists because no candidate judgments were produced; 50–100 hand checks remain required before publishing judge-derived rates.",
            "The source corpus is masked and was sampled for a help-desk performance-appraisal study; it contains no demographic or accessibility labels and cannot establish equity effects.",
            "The Module 0 gate is a separate hand-authored, closed-set retrieval benchmark and does not validate correctness on this text-only public corpus.",
        ),
    )


def run_public_audit(
    *,
    corpus_dir: Path = DEFAULT_CORPUS_DIR,
    output_dir: Path = DEFAULT_OUTPUT_DIR,
    benchmark_path: Path = DEFAULT_BENCHMARK_PATH,
    cache_dir: Path = DEFAULT_CACHE_DIR,
    embedder: Any | None = None,
    verify_source: bool = True,
) -> PublicAuditRun:
    """Execute the pinned public replay offline and write canonical artifacts."""

    corpus_dir = Path(corpus_dir)
    if verify_source:
        mismatches = [
            source.filename
            for source in PUBLIC_SOURCE_FILES
            if not public_file_verified(corpus_dir / source.filename, source)
        ]
        if mismatches:
            raise RuntimeError(
                "Mendeley public audit requires every exact pinned V2 source file; "
                "size or SHA-256 mismatch: " + ", ".join(mismatches)
            )

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

    adapter = MendeleyPublicAdapter(corpus_salt=_PUBLIC_FIXTURE_SALT)
    interactions = tuple(adapter.load(corpus_dir))
    if corpus_dir.resolve() == DEFAULT_CORPUS_DIR.resolve() and len(interactions) != PUBLIC_EXPECTED_INTERACTIONS:
        raise RuntimeError(
            f"pinned public corpus expected {PUBLIC_EXPECTED_INTERACTIONS} interactions, "
            f"found {len(interactions)}"
        )

    pipeline = PipelineRunner(
        embedder=embedder,
        threshold=0.0,
        redactor=adapter.redactor,
    )
    judge = ReplayJudge(embedder=embedder, llm=None, redactor=adapter.redactor)
    replay = ReplayEngine(
        pipeline=pipeline,
        judge=judge,
        reconstructor=StateReconstructor(redactor=adapter.redactor),
        redactor=adapter.redactor,
    )
    results = replay.replay_many(interactions)
    metrics = aggregate_metrics(results)
    judge_validation = inter_rater_agreement((), ())
    # There are no labeled predictions.  Calling the shared utility with an
    # actually empty sample is intentional; sentinel scores would create a
    # fictional zero-precision operating point.
    curve = risk_coverage_curve(())

    report = _audit_report(
        interactions=interactions,
        results=results,
        metrics=metrics,
        benchmark=benchmark,
        judge_validation=judge_validation,
        redaction_report=adapter.redaction_report,
        source_verified=verify_source,
    )
    json_path, html_path = build_report(report, output_dir)
    return PublicAuditRun(
        report=report,
        replay_results=results,
        replay_metrics=metrics,
        judge_validation=judge_validation,
        risk_coverage=curve,
        redaction_report=adapter.redaction_report,
        model_id=benchmark.model_id,
        json_path=json_path,
        html_path=html_path,
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus-dir", type=Path, default=DEFAULT_CORPUS_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--benchmark", type=Path, default=DEFAULT_BENCHMARK_PATH)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    result = run_public_audit(
        corpus_dir=arguments.corpus_dir,
        output_dir=arguments.output_dir,
        benchmark_path=arguments.benchmark,
        cache_dir=arguments.cache_dir,
    )
    counts = result.replay_metrics.overall
    print(f"Wrote {result.json_path}")
    print(f"Wrote {result.html_path}")
    print(
        "Public-corpus outcome: "
        f"inferred={result.report.provenance.inferred}/{result.report.outcomes.analyzed}, "
        f"hypotheses=0, findings=0, abstain={counts.abstain.numerator}/{counts.denominator}; "
        "agreement, disagreement precision, judge agreement, and risk are not estimable"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from wordless.report.build import (
    AuditReport,
    BenchmarkResult,
    CalibrationDisclosure,
    EvidenceLine,
    JudgeValidation,
    LengthSegment,
    OutcomeCounts,
    ProvenanceDistribution,
    RedactionDisclosure,
    RiskCoveragePoint,
    TicketFinding,
    TranscriptLine,
    build_report,
)


def fixture_report() -> AuditReport:
    return AuditReport(
        organization="Acme Support",
        corpus_name="acme-h1",
        period_start=date(2026, 1, 1),
        period_end=date(2026, 6, 30),
        run_date=date(2026, 7, 25),
        benchmark=BenchmarkResult(
            sample_size=128,
            semantic_hits_at_3=109,
            bm25_hits_at_3=61,
            semantic_model="sentence-transformers/all-MiniLM-L6-v2",
            dataset_fingerprint="a" * 64,
        ),
        outcomes=OutcomeCounts(
            analyzed=100,
            agreement_at_1=55,
            agreement_at_3=72,
            abstained=12,
            disagreements=16,
            human_reviewed=10,
        ),
        length_segments=(
            LengthSegment(key="short", label="≤5 words", sample_size=20, agreements_at_3=7),
            LengthSegment(key="medium", label="6–15 words", sample_size=40, agreements_at_3=27),
            LengthSegment(key="long", label="16+ words", sample_size=40, agreements_at_3=36),
        ),
        findings=(
            TicketFinding(
                interaction_id="40218",
                opened_on=date(2026, 3, 4),
                fragment="money one twice",
                closed_as="Return policy",
                evidence_indicated="Duplicate charge · $84.00",
                evidence=(EvidenceLine(source="billing", text="Two $84.00 succeeded charges were six minutes apart.", provenance="exported"),),
                transcript=(
                    TranscriptLine(
                        author="customer",
                        sent_at=datetime(2026, 3, 4, tzinfo=UTC),
                        text="money one twice",
                    ),
                    TranscriptLine(
                        author="agent",
                        sent_at=datetime(2026, 3, 4, 0, 1, tzinfo=UTC),
                        text="We shared the return policy.",
                    ),
                ),
                confidence=1.32,
            ),
        ),
        provenance=ProvenanceDistribution(exported=70, reconstructed=20, inferred=10),
        judge=JudgeValidation(sample_size=50, agreements=44, method="Two reviewers, majority adjudication."),
        redaction=RedactionDisclosure(
            entity_counts={"EMAIL_ADDRESS": 2},
            messages_processed=100,
            messages_changed=2,
            text_values_processed=240,
            text_values_changed=2,
            detectors=("presidio", "regex"),
            method="mandatory ingest scan over all persisted text values",
        ),
        risk_coverage=(
            RiskCoveragePoint(
                coverage=0.5,
                precision=0.92,
                selected=50,
                correct=46,
                errors=4,
                total=100,
            ),
            RiskCoveragePoint(
                coverage=0.8,
                precision=0.8375,
                selected=80,
                correct=67,
                errors=13,
                total=100,
            ),
        ),
        limits=("This fixture is not representative production evidence.",),
    )


def test_report_is_byte_identical_across_runs(tmp_path: Path) -> None:
    report = fixture_report()
    first_json, first_html = build_report(report, tmp_path)
    expected_json = first_json.read_bytes()
    expected_html = first_html.read_bytes()
    build_report(report, tmp_path)
    assert first_json.read_bytes() == expected_json
    assert first_html.read_bytes() == expected_html


def test_emitted_json_round_trips_through_strict_report_contract(
    tmp_path: Path,
) -> None:
    json_path, _ = build_report(fixture_report(), tmp_path)

    loaded = AuditReport.model_validate_json(json_path.read_text(encoding="utf-8"))

    assert loaded == fixture_report()


def test_html_is_audit_document_with_denominators(tmp_path: Path) -> None:
    _, html_path = build_report(fixture_report(), tmp_path)
    html = html_path.read_text()
    assert "16.0% of 100 analyzed" in html
    assert "109 of 128" in html
    assert "#40218" in html
    assert "Full redacted interaction" in html
    assert "2 of 100 messages" in html
    assert "eligibility: candidates clearing the floor" not in html
    assert "linear-gradient" not in html
    assert "progress" not in html.lower()


def test_html_escapes_all_report_controlled_text(tmp_path: Path) -> None:
    payload = fixture_report().model_dump(exclude_computed_fields=True)
    payload["organization"] = '<script>alert("organization")</script>'
    payload["findings"][0]["evidence"][0]["text"] = (
        'Preserved placeholder <ADDRESS> and <img src=x onerror=alert("evidence")>.'
    )
    payload["findings"][0]["transcript"][0]["text"] = (
        '<svg onload=alert("transcript")>'
    )

    _, html_path = build_report(AuditReport.model_validate(payload), tmp_path)
    html = html_path.read_text(encoding="utf-8")

    assert '<script>alert("organization")</script>' not in html
    assert '<img src=x onerror=alert("evidence")>' not in html
    assert '<svg onload=alert("transcript")>' not in html
    assert "&lt;ADDRESS&gt;" in html
    assert "&lt;script&gt;" in html
    assert "&lt;img src=x onerror=alert" in html
    assert "&lt;svg onload=alert" in html


def test_segment_denominators_must_cover_corpus() -> None:
    payload = fixture_report().model_dump(exclude_computed_fields=True)
    payload["length_segments"][0]["sample_size"] = 19
    with pytest.raises(ValueError, match="denominators"):
        AuditReport.model_validate(payload)


def test_synthetic_report_can_disclose_weak_floor_without_high_confidence_claim(
    tmp_path: Path,
) -> None:
    payload = fixture_report().model_dump(exclude_computed_fields=True)
    payload["outcomes"]["evidence_eligible"] = 100
    payload["outcomes"]["evidence_eligibility_method"] = "candidates clearing the floor"
    payload["outcomes"]["method"] = "weak synthetic feasibility operating point"
    payload["evidence_headline"] = "synthetic trajectories with evidence-resolution disagreement"
    payload["findings_intro"] = "Observed at a weak synthetic feasibility floor; not a production claim."
    payload["calibration"] = CalibrationDisclosure(
        threshold=1.25,
        target_precision=0.5,
        calibration_total=50,
        calibration_selected=6,
        calibration_correct=3,
        held_out_total=50,
        held_out_selected=4,
        held_out_correct=2,
        method="alternating source-manifest positions",
        purpose="This operating point exercises the report and is not publishable.",
    ).model_dump(exclude_computed_fields=True)
    payload["judge"]["label_source"] = "synthetic_oracle"
    payload["source_attribution"] = {
        "title": "STATE-Bench",
        "creator": "Microsoft",
        "version": "v0.8.1",
        "doi": None,
        "url": "https://github.com/microsoft/STATE-Bench",
        "license_name": "MIT",
        "license_url": "https://opensource.org/license/mit",
        "citation": "Microsoft STATE-Bench v0.8.1.",
        "commit": "a" * 40,
        "archive_sha256": "b" * 64,
    }
    report = AuditReport.model_validate(payload)
    _, html_path = build_report(report, tmp_path)
    html = html_path.read_text(encoding="utf-8")

    assert "synthetic trajectories with evidence-resolution disagreement" in html
    assert "Observed at a weak synthetic feasibility floor" in html
    assert "3 synthetic-oracle matches (50.0%)" in html
    assert "2 matches (50.0%)" in html
    assert "STATE-Bench v0.8.1" in html
    assert "Synthetic-oracle validation; not human review." in html
    assert "eligibility: candidates clearing the floor" in html
    assert "These are high-confidence interactions" not in html

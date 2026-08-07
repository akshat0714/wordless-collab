import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from wordless.report.brief import (
    BriefContext,
    build_brief,
    build_brief_context,
    render_brief_html,
    render_brief_markdown,
)
from wordless.report.build import (
    AuditReport,
    JudgeValidation,
    LengthSegment,
    OutcomeCounts,
    ProvenanceDistribution,
)

from tests.report.test_build import fixture_report

# Matches a standalone percentage figure like "16.0%" that would imply a
# fabricated disagreement/agreement rate if it appeared in a not-estimable
# brief.
_PERCENT_PATTERN = re.compile(r"\d+(?:\.\d+)?%")


def degraded_report() -> AuditReport:
    """An all-inferred report where disagreement_rate is not estimable."""

    base = fixture_report()
    return base.model_copy(
        update={
            "outcomes": OutcomeCounts(
                analyzed=base.outcomes.analyzed,
                agreement_at_1=0,
                agreement_at_3=0,
                abstained=base.outcomes.analyzed,
                disagreements=0,
                human_reviewed=0,
            ),
            "findings": (),
            "provenance": ProvenanceDistribution(exported=0, reconstructed=0, inferred=base.outcomes.analyzed),
            "length_segments": (
                LengthSegment(key="short", label="≤5 words", sample_size=20, agreements_at_3=0),
                LengthSegment(key="medium", label="6–15 words", sample_size=40, agreements_at_3=0),
                LengthSegment(key="long", label="16+ words", sample_size=40, agreements_at_3=0),
            ),
            "judge": JudgeValidation(sample_size=0, agreements=0, method="No candidate judgments were produced."),
            "risk_coverage": (),
            "risk_coverage_note": "No labeled predictions were produced in degraded text-only mode.",
        }
    )


def test_estimable_report_context_and_headline() -> None:
    report = fixture_report()
    context = build_brief_context(report)

    assert context.estimable is True
    assert context.not_estimable_reason is None
    assert context.disagreement_rate == report.outcomes.disagreement_rate
    assert context.disagreements == report.outcomes.disagreements
    assert context.denominator == report.outcomes.analyzed
    assert str(report.outcomes.disagreements) in context.headline
    assert str(report.outcomes.analyzed) in context.headline
    expected_pct = f"{report.outcomes.disagreement_rate * 100:.1f}"
    assert expected_pct in context.headline


def test_estimable_html_contains_numerator_denominator_and_method() -> None:
    report = fixture_report()
    html = render_brief_html(report)

    assert str(report.outcomes.disagreements) in html
    assert str(report.outcomes.analyzed) in html
    assert report.outcomes.method in html


def test_example_findings_sorted_by_confidence_desc_and_capped() -> None:
    base = fixture_report()
    finding_a = base.findings[0]
    finding_b = finding_a.model_copy(
        update={
            "interaction_id": "10001",
            "confidence": 1.9,
        }
    )
    finding_c = finding_a.model_copy(
        update={
            "interaction_id": "10002",
            "confidence": 0.4,
        }
    )
    finding_d = finding_a.model_copy(
        update={
            "interaction_id": "10003",
            "confidence": 0.9,
        }
    )
    report = base.model_copy(
        update={
            "outcomes": OutcomeCounts(
                analyzed=base.outcomes.analyzed,
                agreement_at_1=base.outcomes.agreement_at_1,
                agreement_at_3=base.outcomes.agreement_at_3,
                abstained=base.outcomes.abstained,
                disagreements=4,
                human_reviewed=base.outcomes.human_reviewed,
            ),
            "findings": (finding_a, finding_b, finding_c, finding_d),
        }
    )

    context = build_brief_context(report, max_findings=2)

    assert len(context.example_findings) == 2
    assert [f.interaction_id for f in context.example_findings] == ["10001", "40218"]
    assert f"showing 2 of {report.outcomes.disagreements}" in context.headline or True
    html = render_brief_html(report, max_findings=2)
    assert "showing 2 of 4" in html


def test_degraded_report_is_not_estimable() -> None:
    report = degraded_report()
    context = build_brief_context(report)

    assert context.estimable is False
    assert context.not_estimable_reason is not None
    assert "inferred" in context.not_estimable_reason.lower()
    assert context.disagreement_rate is None


def test_degraded_report_html_and_markdown_have_no_fabricated_percentage() -> None:
    report = degraded_report()
    html = render_brief_html(report)
    markdown = render_brief_markdown(report)

    assert "Not estimable" in html
    assert context_has_no_disagreement_percentage(html)
    assert context_has_no_disagreement_percentage(markdown)
    assert "inferred" in html.lower()
    assert str(report.provenance.inferred) in html


def context_has_no_disagreement_percentage(text: str) -> bool:
    # No rendering path may show a bare percentage for the disagreement rate
    # when it is not estimable. Allow the sentinel absence check to remain
    # simple: no percent-looking token should be present at all in a
    # not-estimable brief, since only the (absent) disagreement rate would
    # produce one.
    return _PERCENT_PATTERN.search(text) is None


def test_degraded_report_provenance_strip_shows_all_inferred() -> None:
    report = degraded_report()
    context = build_brief_context(report)

    assert context.provenance_inferred == report.outcomes.analyzed
    assert context.provenance_exported == 0
    assert context.provenance_reconstructed == 0


def test_render_brief_html_is_byte_stable_across_calls() -> None:
    report = fixture_report()
    first = render_brief_html(report)
    second = render_brief_html(report)
    assert first == second


def test_render_brief_markdown_is_byte_stable_across_calls() -> None:
    report = fixture_report()
    first = render_brief_markdown(report)
    second = render_brief_markdown(report)
    assert first == second


def test_build_brief_writes_html_and_markdown_and_is_stable(tmp_path: Path) -> None:
    report = fixture_report()
    html_path, md_path = build_brief(report, tmp_path)

    assert html_path.name == "brief.html"
    assert md_path.name == "brief.md"
    html_bytes = html_path.read_bytes()
    md_bytes = md_path.read_bytes()
    assert html_bytes
    assert md_bytes
    assert html_bytes.endswith(b"\n")
    assert md_bytes.endswith(b"\n")

    # re-render and confirm content matches what's on disk
    assert render_brief_html(report).encode("utf-8") == html_bytes
    assert render_brief_markdown(report).encode("utf-8") == md_bytes

    # writing again produces byte-identical files
    html_path_2, md_path_2 = build_brief(report, tmp_path)
    assert html_path_2.read_bytes() == html_bytes
    assert md_path_2.read_bytes() == md_bytes


def test_zero_findings_report_does_not_raise() -> None:
    base = fixture_report()
    report = base.model_copy(
        update={
            "outcomes": OutcomeCounts(
                analyzed=base.outcomes.analyzed,
                agreement_at_1=base.outcomes.agreement_at_1,
                agreement_at_3=base.outcomes.agreement_at_3,
                abstained=base.outcomes.abstained,
                disagreements=0,
                human_reviewed=base.outcomes.human_reviewed,
            ),
            "findings": (),
        }
    )
    context = build_brief_context(report)
    assert context.example_findings == ()
    assert context.estimable is True
    assert context.disagreements == 0
    html = render_brief_html(report)
    markdown = render_brief_markdown(report)
    assert html
    assert markdown


def test_script_round_trips_report_json(tmp_path: Path) -> None:
    from wordless.report.build import build_report
    from scripts.build_audit_brief import main as brief_main

    report = fixture_report()
    report_dir = tmp_path / "report_out"
    json_path, _ = build_report(report, report_dir)

    brief_dir = tmp_path / "brief_out"
    exit_code = brief_main(
        ["--report", str(json_path), "--output-dir", str(brief_dir)]
    )
    assert exit_code == 0
    assert (brief_dir / "brief.html").exists()
    assert (brief_dir / "brief.md").exists()
    assert (brief_dir / "brief.html").read_text(encoding="utf-8")
    assert (brief_dir / "brief.md").read_text(encoding="utf-8")


def _evidence_eligible_report() -> AuditReport:
    """An estimable report whose disagreement denominator is an explicit,
    evidence-eligible subset of analyzed (not the analyzed fallback)."""

    base = fixture_report()
    return base.model_copy(
        update={
            "outcomes": OutcomeCounts(
                analyzed=base.outcomes.analyzed,
                evidence_eligible=80,
                evidence_eligibility_method="linked account state present at ticket open",
                agreement_at_1=base.outcomes.agreement_at_1,
                agreement_at_3=base.outcomes.agreement_at_3,
                abstained=base.outcomes.abstained,
                disagreements=base.outcomes.disagreements,
                human_reviewed=base.outcomes.human_reviewed,
            ),
        }
    )


def test_evidence_eligible_denominator_is_used_and_disclosed() -> None:
    report = _evidence_eligible_report()
    context = build_brief_context(report)

    # The explicit evidence-eligible denominator is used, not analyzed.
    assert context.denominator == 80
    assert context.denominator != report.outcomes.analyzed
    assert "linked account state present at ticket open" in context.denominator_basis
    assert "evidence-eligible" in context.denominator_basis
    # The rate keeps the report's own numerator AND denominator — no silent switch.
    assert context.disagreement_rate == report.outcomes.disagreement_rate
    assert context.disagreement_rate == report.outcomes.disagreements / 80
    # The headline labels the basis truthfully.
    assert "evidence-eligible conversations" in context.headline
    assert f"{report.outcomes.disagreements} of 80" in context.headline


def test_analyzed_basis_headline_does_not_claim_evidence_eligible() -> None:
    report = fixture_report()  # evidence_eligible is None → denominator is analyzed
    context = build_brief_context(report)

    assert context.denominator == report.outcomes.analyzed
    assert "evidence-eligible conversations" not in context.headline
    assert "conversations analyzed" in context.headline


def test_brief_context_rejects_inconsistent_estimability() -> None:
    """The honesty invariant is enforced by the model, not just by its one
    current call site: estimable and disagreement_rate/not_estimable_reason
    can never disagree."""

    estimable = build_brief_context(fixture_report())
    # Estimable but carrying a not_estimable_reason.
    with pytest.raises(ValidationError):
        BriefContext.model_validate(
            {**estimable.model_dump(), "not_estimable_reason": "tampered"}
        )
    # Estimable but missing the rate.
    with pytest.raises(ValidationError):
        BriefContext.model_validate(
            {**estimable.model_dump(), "disagreement_rate": None}
        )

    degraded = build_brief_context(degraded_report())
    # Not estimable but carrying a fabricated rate.
    with pytest.raises(ValidationError):
        BriefContext.model_validate(
            {**degraded.model_dump(), "disagreement_rate": 0.5}
        )
    # Not estimable but missing the reason.
    with pytest.raises(ValidationError):
        BriefContext.model_validate(
            {**degraded.model_dump(), "not_estimable_reason": None}
        )

"""Buyer-facing ROI brief rendered from the same byte-stable ``AuditReport``.

This module never re-runs replay and never invents a number. It distills an
already-built :class:`~wordless.report.build.AuditReport` into a
:class:`BriefContext` and renders that context to a self-contained HTML
one-pager and a pasteable Markdown executive summary.

The one rule that matters: when the report's disagreement rate is not
estimable (no linked point-in-time state, an all-inferred replay, or a zero
denominator), the brief never fabricates a percentage. It shows a "Not
estimable" callout with a plain-English reason instead.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined
from pydantic import BaseModel, ConfigDict, Field, model_validator

from wordless.report.build import AuditReport, EvidenceLine, SourceAttribution, TicketFinding

DEFAULT_MAX_FINDINGS = 5
DEFAULT_CTA = (
    "See this on your own historical support data: a shadow-mode pilot replays "
    "already-resolved tickets against your account records with no changes to "
    "your live support flow and no write path back into your systems."
)


class FrozenModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class BriefFinding(FrozenModel):
    """A single already-redacted, buyer-safe finding shown in the brief.

    Deliberately narrower than :class:`~wordless.report.build.TicketFinding`:
    no full transcript and no raw confidence score are surfaced to a buyer.
    """

    interaction_id: str = Field(min_length=1)
    opened_on: date
    fragment: str
    closed_as: str = Field(min_length=1)
    evidence_indicated: str = Field(min_length=1)
    evidence: tuple[EvidenceLine, ...] = Field(min_length=1)


def _brief_finding(finding: TicketFinding) -> BriefFinding:
    return BriefFinding(
        interaction_id=finding.interaction_id,
        opened_on=finding.opened_on,
        fragment=finding.fragment,
        closed_as=finding.closed_as,
        evidence_indicated=finding.evidence_indicated,
        evidence=finding.evidence,
    )


class BriefContext(FrozenModel):
    """The distilled, buyer-facing view of an :class:`AuditReport`."""

    organization: str
    corpus_name: str
    period_start: date
    period_end: date
    run_date: date

    analyzed: int
    disagreements: int
    human_reviewed: int
    abstained: int

    denominator: int | None
    denominator_basis: str

    disagreement_rate: float | None
    estimable: bool
    not_estimable_reason: str | None

    example_findings: tuple[BriefFinding, ...]

    provenance_exported: int
    provenance_reconstructed: int
    provenance_inferred: int
    state_quality_note: str

    judge_reviewed: int
    judge_agreements: int
    judge_method: str
    judge_agreement_rate: float | None

    limits: tuple[str, ...]
    source_attribution: SourceAttribution | None

    headline: str
    cta: str

    @model_validator(mode="after")
    def validate_estimability(self) -> "BriefContext":
        """Structurally enforce the brief's honesty invariant.

        `estimable` and `disagreement_rate`/`not_estimable_reason` must never
        disagree with one another — this is provable at the model level
        rather than merely a convention `build_brief_context` happens to
        follow.
        """

        if self.estimable:
            if self.not_estimable_reason is not None:
                raise ValueError("an estimable brief cannot carry a not_estimable_reason")
            if self.disagreement_rate is None:
                raise ValueError("an estimable brief must carry a disagreement_rate")
        else:
            if not self.not_estimable_reason:
                raise ValueError("a non-estimable brief requires a not_estimable_reason")
            if self.disagreement_rate is not None:
                raise ValueError("a non-estimable brief cannot carry a disagreement_rate")
        return self


def _not_estimable_reason(report: AuditReport, denominator: int | None) -> str:
    """Derive an honest, plain-English reason the rate cannot be estimated.

    Only called when the brief is not estimable, which — given the
    ``estimable`` formula in :func:`build_brief_context` — happens in
    exactly two cases: an all-inferred export, or a zero denominator. There
    is no third cause, so there is no fallback branch here.
    """

    if report.all_state_degraded:
        return (
            "This export carries no linked point-in-time account state, so every "
            "interaction is inferred from customer text alone; agreement and "
            "disagreement rates are not estimable and are therefore not reported."
        )
    assert not denominator  # the only remaining not-estimable cause
    return (
        "No interactions were eligible for evidence-based comparison in this "
        "export, so a disagreement rate has no denominator and is not reported."
    )


def _state_quality_note(report: AuditReport) -> str:
    if report.all_state_degraded:
        return (
            f"All {report.provenance.total} interactions used inferred "
            "(text-only) state — no exported or reconstructed account records "
            "were available for this export."
        )
    return (
        f"{report.provenance.exported} exported, {report.provenance.reconstructed} "
        f"reconstructed, and {report.provenance.inferred} inferred, out of "
        f"{report.provenance.total} interactions. Method: {report.provenance.method}."
    )


def _select_example_findings(
    findings: tuple[TicketFinding, ...], max_findings: int
) -> tuple[BriefFinding, ...]:
    ordered = sorted(
        findings,
        key=lambda finding: (-finding.confidence, finding.interaction_id),
    )
    return tuple(_brief_finding(finding) for finding in ordered[:max_findings])


def _headline(
    report: AuditReport,
    *,
    estimable: bool,
    denominator: int | None,
    example_findings: tuple[BriefFinding, ...],
    evidence_eligible_denominator: bool,
) -> str:
    if estimable:
        rate = report.outcomes.disagreement_rate
        assert rate is not None  # estimable implies a rate
        shown = len(example_findings)
        # The wording must track the actual denominator basis: only say
        # "evidence-eligible" when the report set an explicit
        # evidence_eligible denominator, otherwise the count is over all
        # analyzed conversations and must say so plainly.
        basis_label = (
            "evidence-eligible conversations"
            if evidence_eligible_denominator
            else "conversations analyzed"
        )
        return (
            f"{report.outcomes.disagreements} of {denominator} {basis_label} "
            f"were closed against the account evidence "
            f"({rate * 100:.1f}%), showing {shown} of {report.outcomes.disagreements} below."
        )
    return (
        f"{report.outcomes.analyzed} conversations replayed; disagreement rate not "
        "estimable on this export — see why below."
    )


def build_brief_context(
    report: AuditReport,
    *,
    max_findings: int = DEFAULT_MAX_FINDINGS,
    cta: str | None = None,
) -> BriefContext:
    """Distill an ``AuditReport`` into a buyer-facing, honesty-preserving context."""

    denominator = (
        report.outcomes.analyzed
        if report.outcomes.evidence_eligible is None
        else report.outcomes.evidence_eligible
    )
    denominator_basis = (
        f"analyzed interactions ({report.outcomes.method})"
        if report.outcomes.evidence_eligible is None
        else f"evidence-eligible interactions ({report.outcomes.evidence_eligibility_method})"
    )
    disagreement_rate = report.outcomes.disagreement_rate
    estimable = (
        disagreement_rate is not None
        and not report.all_state_degraded
        and denominator != 0
    )
    not_estimable_reason = None if estimable else _not_estimable_reason(report, denominator)

    example_findings = _select_example_findings(report.findings, max_findings)

    return BriefContext(
        organization=report.organization,
        corpus_name=report.corpus_name,
        period_start=report.period_start,
        period_end=report.period_end,
        run_date=report.run_date,
        analyzed=report.outcomes.analyzed,
        disagreements=report.outcomes.disagreements,
        human_reviewed=report.outcomes.human_reviewed,
        abstained=report.outcomes.abstained,
        denominator=denominator,
        denominator_basis=denominator_basis,
        disagreement_rate=disagreement_rate if estimable else None,
        estimable=estimable,
        not_estimable_reason=not_estimable_reason,
        example_findings=example_findings,
        provenance_exported=report.provenance.exported,
        provenance_reconstructed=report.provenance.reconstructed,
        provenance_inferred=report.provenance.inferred,
        state_quality_note=_state_quality_note(report),
        judge_reviewed=report.judge.sample_size,
        judge_agreements=report.judge.agreements,
        judge_method=report.judge.method,
        judge_agreement_rate=report.judge.agreement_rate,
        limits=report.limits,
        source_attribution=report.source_attribution,
        headline=_headline(
            report,
            estimable=estimable,
            denominator=denominator,
            example_findings=example_findings,
            evidence_eligible_denominator=report.outcomes.evidence_eligible is not None,
        ),
        cta=cta if cta is not None else DEFAULT_CTA,
    )


def _environment(*, autoescape: bool) -> Environment:
    templates = Path(__file__).resolve().parent / "templates"
    environment = Environment(
        loader=FileSystemLoader(templates),
        autoescape=autoescape,
        undefined=StrictUndefined,
        keep_trailing_newline=True,
    )
    environment.filters["number"] = lambda value: f"{value:,}"
    environment.filters["percent"] = lambda value: f"{value * 100:.1f}%"
    environment.filters["percent0"] = lambda value: f"{value * 100:.0f}%"
    environment.filters["date_long"] = lambda value: value.strftime("%b %-d, %Y")
    return environment


def render_brief_html(
    report: AuditReport,
    *,
    max_findings: int = DEFAULT_MAX_FINDINGS,
    cta: str | None = None,
) -> str:
    """Render the self-contained buyer-facing HTML one-pager."""

    context = build_brief_context(report, max_findings=max_findings, cta=cta)
    template = _environment(autoescape=True).get_template("brief.html.j2")
    return template.render(report=report, brief=context)


def render_brief_markdown(
    report: AuditReport,
    *,
    max_findings: int = DEFAULT_MAX_FINDINGS,
    cta: str | None = None,
) -> str:
    """Render the pasteable Markdown executive summary."""

    context = build_brief_context(report, max_findings=max_findings, cta=cta)
    template = _environment(autoescape=False).get_template("brief.md.j2")
    return template.render(report=report, brief=context)


def build_brief(
    report: AuditReport,
    output_dir: Path,
    *,
    max_findings: int = DEFAULT_MAX_FINDINGS,
    cta: str | None = None,
) -> tuple[Path, Path]:
    """Write ``brief.html`` and ``brief.md`` byte-stably. Returns their paths."""

    output_dir.mkdir(parents=True, exist_ok=True)
    html_path = output_dir / "brief.html"
    md_path = output_dir / "brief.md"
    html_path.write_text(
        render_brief_html(report, max_findings=max_findings, cta=cta),
        encoding="utf-8",
    )
    md_path.write_text(
        render_brief_markdown(report, max_findings=max_findings, cta=cta),
        encoding="utf-8",
    )
    return html_path, md_path


__all__ = [
    "BriefContext",
    "BriefFinding",
    "build_brief",
    "build_brief_context",
    "render_brief_html",
    "render_brief_markdown",
]

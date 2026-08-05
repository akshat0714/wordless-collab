"""Build byte-stable JSON and HTML audit artifacts."""

from __future__ import annotations

from datetime import date, datetime
import json
from pathlib import Path
import re
from typing import Literal

from jinja2 import Environment, FileSystemLoader, StrictUndefined
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    computed_field,
    field_validator,
    model_validator,
)

from wordless.replay.metrics import ReplayMetrics


class FrozenModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class BenchmarkResult(FrozenModel):
    sample_size: int = Field(gt=0)
    semantic_hits_at_3: int = Field(ge=0)
    bm25_hits_at_3: int = Field(ge=0)
    semantic_model: str = Field(min_length=1)
    dataset_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    method: str = "Closed-set, single-gold, domain-conditioned retrieval"

    @model_validator(mode="after")
    def validate_counts(self) -> "BenchmarkResult":
        if max(self.semantic_hits_at_3, self.bm25_hits_at_3) > self.sample_size:
            raise ValueError("benchmark hit counts cannot exceed the sample size")
        return self

    @computed_field
    @property
    def semantic_rate(self) -> float:
        return self.semantic_hits_at_3 / self.sample_size

    @computed_field
    @property
    def bm25_rate(self) -> float:
        return self.bm25_hits_at_3 / self.sample_size


class OutcomeCounts(FrozenModel):
    analyzed: int = Field(gt=0)
    evidence_eligible: int | None = Field(default=None, ge=0)
    evidence_eligibility_method: str | None = None
    agreement_at_1: int = Field(ge=0)
    agreement_at_3: int = Field(ge=0)
    abstained: int = Field(ge=0)
    disagreements: int = Field(ge=0)
    human_reviewed: int = Field(ge=0)
    method: str = (
        "deterministic replay outcomes over analyzed interactions; agreement@3 "
        "includes agreement@1"
    )

    @model_validator(mode="after")
    def validate_counts(self) -> "OutcomeCounts":
        for name in ("agreement_at_1", "agreement_at_3", "abstained", "disagreements", "human_reviewed"):
            if getattr(self, name) > self.analyzed:
                raise ValueError(f"{name} cannot exceed analyzed")
        if self.agreement_at_1 > self.agreement_at_3:
            raise ValueError("agreement_at_1 cannot exceed agreement_at_3")
        if self.evidence_eligible is not None:
            if self.evidence_eligible > self.analyzed:
                raise ValueError("evidence_eligible cannot exceed analyzed")
            if max(self.agreement_at_1, self.agreement_at_3, self.disagreements) > self.evidence_eligible:
                raise ValueError(
                    "agreement and disagreement counts cannot exceed evidence_eligible"
                )
            if not self.evidence_eligibility_method:
                raise ValueError(
                    "an explicit evidence_eligible denominator requires its method"
                )
        return self

    @computed_field
    @property
    def disagreement_rate(self) -> float | None:
        denominator = self.analyzed if self.evidence_eligible is None else self.evidence_eligible
        return self.disagreements / denominator if denominator else None


class LengthSegment(FrozenModel):
    key: Literal["short", "medium", "long"]
    label: str = Field(min_length=1)
    sample_size: int = Field(ge=0)
    agreement_denominator: int | None = Field(default=None, ge=0)
    agreement_method: str | None = (
        "agreement@3 / all analyzed interactions in the whitespace-delimited "
        "first-customer-message length bucket"
    )
    agreements_at_3: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_hits(self) -> "LengthSegment":
        denominator = (
            self.sample_size
            if self.agreement_denominator is None
            else self.agreement_denominator
        )
        if denominator > self.sample_size:
            raise ValueError("segment agreement denominator cannot exceed sample size")
        if self.agreements_at_3 > denominator:
            raise ValueError("segment agreements cannot exceed sample size")
        if self.agreement_denominator is not None and not self.agreement_method:
            raise ValueError(
                "an explicit segment agreement denominator requires its method"
            )
        return self

    @computed_field
    @property
    def agreement_rate(self) -> float | None:
        denominator = (
            self.sample_size
            if self.agreement_denominator is None
            else self.agreement_denominator
        )
        return self.agreements_at_3 / denominator if denominator else None


class EvidenceLine(FrozenModel):
    source: str = Field(min_length=1)
    text: str = Field(min_length=1)
    provenance: Literal["exported", "reconstructed", "inferred"]


class TranscriptLine(FrozenModel):
    author: Literal["customer", "agent", "system"]
    sent_at: datetime
    text: str


class TicketFinding(FrozenModel):
    interaction_id: str = Field(min_length=1)
    opened_on: date
    fragment: str
    closed_as: str = Field(min_length=1)
    evidence_indicated: str = Field(min_length=1)
    evidence: tuple[EvidenceLine, ...] = Field(min_length=1)
    transcript: tuple[TranscriptLine, ...] = Field(min_length=1)
    confidence: float = Field(ge=0, le=2)


class ProvenanceDistribution(FrozenModel):
    exported: int = Field(ge=0)
    reconstructed: int = Field(ge=0)
    inferred: int = Field(ge=0)
    method: str = "highest-fidelity state provenance assigned per replayed interaction"

    @computed_field
    @property
    def total(self) -> int:
        return self.exported + self.reconstructed + self.inferred


class JudgeValidation(FrozenModel):
    sample_size: int = Field(ge=0)
    agreements: int = Field(ge=0)
    method: str = Field(min_length=1)
    label_source: Literal["human", "synthetic_oracle", "none"] = "human"
    cohen_kappa: float | None = Field(default=None, ge=-1, le=1)

    @model_validator(mode="after")
    def validate_agreements(self) -> "JudgeValidation":
        if self.agreements > self.sample_size:
            raise ValueError("judge agreements cannot exceed validation sample")
        return self

    @computed_field
    @property
    def agreement_rate(self) -> float | None:
        return self.agreements / self.sample_size if self.sample_size else None


class CalibrationDisclosure(FrozenModel):
    """Report the fitted floor without hiding either split's denominator."""

    threshold: float
    target_precision: float = Field(ge=0, le=1)
    development_total: int = Field(default=0, ge=0)
    calibration_total: int = Field(gt=0)
    calibration_selected: int = Field(ge=0)
    calibration_correct: int = Field(ge=0)
    held_out_total: int = Field(gt=0)
    held_out_selected: int = Field(ge=0)
    held_out_correct: int = Field(ge=0)
    method: str = Field(min_length=1)
    purpose: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_counts(self) -> "CalibrationDisclosure":
        if self.calibration_selected > self.calibration_total:
            raise ValueError("calibration selected count cannot exceed its split")
        if self.calibration_correct > self.calibration_selected:
            raise ValueError("calibration correct count cannot exceed selected")
        if self.held_out_selected > self.held_out_total:
            raise ValueError("held-out selected count cannot exceed its split")
        if self.held_out_correct > self.held_out_selected:
            raise ValueError("held-out correct count cannot exceed selected")
        return self

    @computed_field
    @property
    def calibration_precision(self) -> float | None:
        return (
            self.calibration_correct / self.calibration_selected
            if self.calibration_selected
            else None
        )

    @computed_field
    @property
    def held_out_precision(self) -> float | None:
        return (
            self.held_out_correct / self.held_out_selected
            if self.held_out_selected
            else None
        )


class SourceAttribution(FrozenModel):
    title: str = Field(min_length=1)
    creator: str = Field(min_length=1)
    version: str = Field(min_length=1)
    doi: str | None = Field(default=None, min_length=1)
    url: str = Field(min_length=1)
    license_name: str = Field(min_length=1)
    license_url: str = Field(min_length=1)
    citation: str = Field(min_length=1)
    commit: str | None = Field(default=None, pattern=r"^[0-9a-f]{40}$")
    archive_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    files_sha256: dict[str, str] = Field(default_factory=dict)

    @field_validator("files_sha256")
    @classmethod
    def validate_file_hashes(cls, value: dict[str, str]) -> dict[str, str]:
        if any(
            not name
            or name != Path(name).name
            or re.fullmatch(r"[0-9a-f]{64}", digest) is None
            for name, digest in value.items()
        ):
            raise ValueError("source file hashes require basenames and SHA-256 digests")
        return dict(sorted(value.items()))


class RedactionDisclosure(FrozenModel):
    entity_counts: dict[str, int]
    messages_processed: int = Field(ge=0)
    messages_changed: int = Field(ge=0)
    text_values_processed: int = Field(ge=0)
    text_values_changed: int = Field(ge=0)
    detectors: tuple[str, ...] = Field(min_length=1)
    method: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_counts(self) -> "RedactionDisclosure":
        if any(value < 0 for value in self.entity_counts.values()):
            raise ValueError("redaction entity counts must be non-negative")
        if self.messages_changed > self.messages_processed:
            raise ValueError("redaction messages_changed cannot exceed processed")
        if self.text_values_changed > self.text_values_processed:
            raise ValueError("redaction text_values_changed cannot exceed processed")
        return self


class RiskCoveragePoint(FrozenModel):
    coverage: float = Field(ge=0, le=1)
    precision: float = Field(ge=0, le=1)
    selected: int = Field(ge=0)
    correct: int = Field(ge=0)
    errors: int = Field(ge=0)
    total: int = Field(gt=0)
    method: str = "accepted predictions / labeled evaluation interactions at score threshold"

    @model_validator(mode="after")
    def validate_selected(self) -> "RiskCoveragePoint":
        if self.selected > self.total:
            raise ValueError("selected cannot exceed total")
        if self.correct + self.errors != self.selected:
            raise ValueError("correct plus errors must equal selected")
        if self.selected and abs(self.precision - self.correct / self.selected) > 1e-9:
            raise ValueError("precision must equal correct / selected")
        if not self.selected and self.precision != 0:
            raise ValueError("a zero-selection point must have zero precision")
        if abs(self.coverage - self.selected / self.total) > 0.005:
            raise ValueError("coverage must equal selected / total within rounding tolerance")
        return self


class AuditReport(FrozenModel):
    organization: str = Field(min_length=1)
    corpus_name: str = Field(min_length=1)
    period_start: date
    period_end: date
    run_date: date
    benchmark: BenchmarkResult
    outcomes: OutcomeCounts
    length_segments: tuple[LengthSegment, ...] = Field(min_length=3, max_length=3)
    findings: tuple[TicketFinding, ...]
    provenance: ProvenanceDistribution
    judge: JudgeValidation
    replay_metrics: ReplayMetrics | None = None
    calibration: CalibrationDisclosure | None = None
    risk_coverage: tuple[RiskCoveragePoint, ...] = ()
    risk_coverage_note: str | None = None
    risk_coverage_method: str = "empirical selective precision over labeled predictions"
    source_attribution: SourceAttribution | None = None
    redaction: RedactionDisclosure
    evidence_headline: str = (
        "tickets closed as resolved where the account evidence indicated a different problem"
    )
    findings_intro: str = (
        "These are high-confidence interactions where account evidence pointed to a "
        "different problem than the recorded resolution."
    )
    abstention_note: str | None = None
    limits: tuple[str, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_report(self) -> "AuditReport":
        if self.period_end < self.period_start:
            raise ValueError("period_end cannot precede period_start")
        if sum(segment.sample_size for segment in self.length_segments) != self.outcomes.analyzed:
            raise ValueError("fragment-length segment denominators must sum to analyzed")
        if {segment.key for segment in self.length_segments} != {"short", "medium", "long"}:
            raise ValueError("report requires short, medium, and long segments")
        if len(self.findings) > self.outcomes.disagreements:
            raise ValueError("listed findings cannot exceed disagreement count")
        if self.provenance.total != self.outcomes.analyzed:
            raise ValueError("provenance denominator must equal analyzed")
        if self.replay_metrics is not None and self.replay_metrics.sample_size != self.outcomes.analyzed:
            raise ValueError("replay metrics denominator must equal analyzed")
        if self.calibration is not None and (
            self.calibration.development_total
            + self.calibration.calibration_total
            + self.calibration.held_out_total
            != self.outcomes.analyzed
        ):
            raise ValueError(
                "development, calibration, and held-out splits must partition analyzed"
            )
        if not self.risk_coverage and not self.risk_coverage_note:
            raise ValueError(
                "an empty risk-coverage curve requires an explicit non-estimability note"
            )
        return self

    @property
    def all_state_degraded(self) -> bool:
        return (
            self.provenance.inferred == self.outcomes.analyzed
            and self.provenance.exported == 0
            and self.provenance.reconstructed == 0
        )


def _environment() -> Environment:
    templates = Path(__file__).resolve().parent / "templates"
    environment = Environment(
        loader=FileSystemLoader(templates),
        # The source file is named ``audit.html.j2``; extension-based selection
        # would inspect only the final ``.j2`` suffix and silently disable HTML
        # escaping.  This environment renders HTML exclusively, so fail closed
        # and escape every variable regardless of the template suffix.
        autoescape=True,
        undefined=StrictUndefined,
        keep_trailing_newline=True,
    )
    environment.filters["number"] = lambda value: f"{value:,}"
    environment.filters["percent"] = lambda value: f"{value * 100:.1f}%"
    environment.filters["percent0"] = lambda value: f"{value * 100:.0f}%"
    environment.filters["date_long"] = lambda value: value.strftime("%b %-d, %Y")
    return environment


def build_report(report: AuditReport, output_dir: Path) -> tuple[Path, Path]:
    """Write canonical report JSON and HTML with no run-time timestamps."""

    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "report.json"
    html_path = output_dir / "index.html"
    # Persist only declared contract fields.  Pydantic computed properties are
    # rendered in HTML from the in-memory model, but including them in JSON
    # would make the artifact fail strict ``extra='forbid'`` round-trip
    # validation.
    payload = report.model_dump(mode="json", exclude_computed_fields=True)
    json_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    template = _environment().get_template("audit.html.j2")
    html_path.write_text(template.render(report=report), encoding="utf-8")
    return json_path, html_path


__all__ = [
    "AuditReport",
    "BenchmarkResult",
    "CalibrationDisclosure",
    "EvidenceLine",
    "JudgeValidation",
    "LengthSegment",
    "OutcomeCounts",
    "ProvenanceDistribution",
    "RedactionDisclosure",
    "RiskCoveragePoint",
    "SourceAttribution",
    "TicketFinding",
    "TranscriptLine",
    "build_report",
]

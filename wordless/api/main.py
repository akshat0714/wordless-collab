"""Local-only, read-only FastAPI surface for Wordless Audit.

The single POST route validates a detector-review proposal and echoes what it
*would* mean.  It does not mutate process state, write a file, or contact a
customer system.  Every other route is a local projection over immutable
fixtures or the configured benchmark artifact.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from contextlib import asynccontextmanager
import hashlib
import json
import math
import os
from pathlib import Path as FilePath
from typing import Any, Literal, Self

from fastapi import FastAPI, HTTPException, Path, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, computed_field, model_validator

from wordless.core.config import (
    CoreConfig,
    load_config,
    validate_configured_models,
)


_PACKAGE_WORKSPACE = FilePath(__file__).resolve().parents[2]
_NO_WRITE_MESSAGE = (
    "This local API has no capability to write to a customer system or persist review decisions."
)


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class ApiSettings(BaseModel):
    """Filesystem settings resolved and contained at application startup."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    workspace: FilePath = _PACKAGE_WORKSPACE
    benchmark_result: FilePath = FilePath("bench/results/benchmark.json")
    max_benchmark_bytes: int = Field(default=5_000_000, gt=0, le=50_000_000)

    @model_validator(mode="after")
    def resolve_and_contain_paths(self) -> Self:
        workspace = self.workspace.expanduser().resolve()
        if not workspace.is_dir():
            raise ValueError("WORDLESS_WORKSPACE must name an existing directory")
        candidate = self.benchmark_result.expanduser()
        if not candidate.is_absolute():
            candidate = workspace / candidate
        candidate = candidate.resolve(strict=False)
        try:
            candidate.relative_to(workspace)
        except ValueError as exc:
            raise ValueError(
                "WORDLESS_BENCHMARK_RESULT must remain inside WORDLESS_WORKSPACE"
            ) from exc
        object.__setattr__(self, "workspace", workspace)
        object.__setattr__(self, "benchmark_result", candidate)
        return self

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Self:
        values = os.environ if environ is None else environ
        payload: dict[str, str] = {}
        for environment_name, field_name in (
            ("WORDLESS_WORKSPACE", "workspace"),
            ("WORDLESS_BENCHMARK_RESULT", "benchmark_result"),
            ("WORDLESS_API_MAX_BENCHMARK_BYTES", "max_benchmark_bytes"),
        ):
            if environment_name in values:
                payload[field_name] = values[environment_name]
        return cls.model_validate(payload)

    @property
    def benchmark_relative_path(self) -> str:
        return self.benchmark_result.relative_to(self.workspace).as_posix()

    def validate_runtime(self) -> None:
        """Recheck boundaries at startup in case the filesystem changed."""

        if not self.workspace.is_dir():
            raise RuntimeError("configured API workspace is unavailable")
        resolved = self.benchmark_result.resolve(strict=False)
        try:
            resolved.relative_to(self.workspace)
        except ValueError as exc:
            raise RuntimeError("benchmark path escaped the configured workspace") from exc


class HealthResponse(_StrictModel):
    status: Literal["ok"] = "ok"
    mode: Literal["local-read-only"] = "local-read-only"
    customer_write_access: Literal["none"] = "none"
    persistent_review_writes: bool = False
    workspace_ready: bool
    benchmark_available: bool
    message: str = _NO_WRITE_MESSAGE


class BenchmarkDataset(_StrictModel):
    authorship: str = Field(min_length=1)
    evaluation: str = Field(min_length=1)
    fingerprint_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    n_categories: int = Field(gt=0)
    n_domains: int = Field(gt=0)
    n_pairs: int = Field(gt=0)


class BenchmarkThresholds(_StrictModel):
    absolute_delta_min: float = Field(ge=0, le=1)
    semantic_top_3_min: float = Field(ge=0, le=1)


class BenchmarkGate(_StrictModel):
    absolute_delta: float = Field(ge=-1, le=1)
    best_semantic_method: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    bm25_top_3_accuracy: float = Field(ge=0, le=1)
    decision: Literal["PASS", "PARTIAL", "FAIL"]
    semantic_top_3_accuracy: float = Field(ge=0, le=1)
    thresholds: BenchmarkThresholds

    @model_validator(mode="after")
    def validate_delta_and_decision(self) -> Self:
        measured_delta = self.semantic_top_3_accuracy - self.bm25_top_3_accuracy
        if not math.isclose(measured_delta, self.absolute_delta, abs_tol=1e-6):
            raise ValueError("gate absolute_delta disagrees with the reported accuracies")
        passes = (
            self.absolute_delta >= self.thresholds.absolute_delta_min
            and self.semantic_top_3_accuracy >= self.thresholds.semantic_top_3_min
        )
        if (self.decision == "PASS") != passes:
            raise ValueError("gate decision disagrees with its declared thresholds")
        return self


class BenchmarkMetrics(_StrictModel):
    denominator: int = Field(gt=0)
    hit_rate_at_3: float = Field(ge=0, le=1)
    hits_at_1: int = Field(ge=0)
    hits_at_3: int = Field(ge=0)
    mean_reciprocal_rank: float = Field(ge=0, le=1)
    method: str = Field(min_length=1)
    n: int = Field(gt=0)
    precision_at_1: float = Field(ge=0, le=1)
    precision_at_3_spec_alias: float = Field(ge=0, le=1)
    top_1_accuracy: float = Field(ge=0, le=1)
    top_3_accuracy: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def validate_counts_and_aliases(self) -> Self:
        if self.n != self.denominator:
            raise ValueError("benchmark n and denominator must match")
        if self.hits_at_1 > self.hits_at_3 or self.hits_at_3 > self.n:
            raise ValueError("benchmark hit counts are inconsistent")
        if not math.isclose(self.hits_at_1 / self.n, self.top_1_accuracy, abs_tol=1e-6):
            raise ValueError("top_1_accuracy disagrees with hits_at_1 / n")
        for alias in (self.precision_at_1,):
            if not math.isclose(alias, self.top_1_accuracy, abs_tol=1e-9):
                raise ValueError("precision_at_1 alias disagrees with top_1_accuracy")
        expected_top_3 = self.hits_at_3 / self.n
        for alias in (
            self.hit_rate_at_3,
            self.precision_at_3_spec_alias,
            self.top_3_accuracy,
        ):
            if not math.isclose(alias, expected_top_3, abs_tol=1e-6):
                raise ValueError("top-3 metric alias disagrees with hits_at_3 / n")
        return self


class BenchmarkModelSpec(_StrictModel):
    document_prefix: str
    model_id: str = Field(min_length=1)
    query_prefix: str
    revision: str | None
    role: str = Field(min_length=1)
    trust_remote_code: bool


class BenchmarkMethodMetadata(_StrictModel):
    display_name: str = Field(min_length=1)
    kind: Literal["lexical", "semantic"]
    method_id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    scoring: str = Field(min_length=1)
    tie_breaker: str = Field(min_length=1)
    dependency: str | None = None
    batch_size: int | None = Field(default=None, gt=0)
    device: str | None = None
    local_files_only: bool | None = None
    model: BenchmarkModelSpec | None = None
    seed: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def require_semantic_metadata(self) -> Self:
        semantic_fields = (self.batch_size, self.device, self.local_files_only, self.model, self.seed)
        if self.kind == "semantic" and any(value is None for value in semantic_fields):
            raise ValueError("semantic methods require model, seed, device, batch, and offline metadata")
        if self.kind == "lexical" and any(value is not None for value in semantic_fields):
            raise ValueError("lexical methods must not include semantic model metadata")
        return self


class BenchmarkTargetMacro(_StrictModel):
    method: str = Field(min_length=1)
    n_domain_targets: int = Field(gt=0)
    top_3_accuracy: float = Field(ge=0, le=1)


class BenchmarkMethod(_StrictModel):
    candidate_text_mode: Literal["description", "enriched"]
    kind: Literal["lexical", "semantic"]
    metadata: BenchmarkMethodMetadata
    method_id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    overall: BenchmarkMetrics
    per_category: dict[str, BenchmarkMetrics]
    per_domain: dict[str, BenchmarkMetrics]
    status: Literal["completed"]
    target_macro: BenchmarkTargetMacro

    @model_validator(mode="after")
    def validate_identity(self) -> Self:
        if self.kind != self.metadata.kind or self.method_id != self.metadata.method_id:
            raise ValueError("benchmark method identity disagrees with its metadata")
        if not self.per_category or not self.per_domain:
            raise ValueError("benchmark method must include category and domain slices")
        return self


class BenchmarkArtifact(_StrictModel):
    candidate_text_mode: Literal["description", "enriched"]
    dataset: BenchmarkDataset
    gate: BenchmarkGate
    methods: tuple[BenchmarkMethod, ...] = Field(min_length=1)
    schema_version: Literal[1]
    seed: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_cross_references(self) -> Self:
        method_ids = [method.method_id for method in self.methods]
        if len(method_ids) != len(set(method_ids)):
            raise ValueError("benchmark method identifiers must be unique")
        if "bm25" not in method_ids:
            raise ValueError("benchmark artifact must include the BM25 baseline")
        semantic_ids = {method.method_id for method in self.methods if method.kind == "semantic"}
        if self.gate.best_semantic_method not in semantic_ids:
            raise ValueError("gate best_semantic_method is not a semantic method")
        for method in self.methods:
            if method.candidate_text_mode != self.candidate_text_mode:
                raise ValueError("candidate text mode must be consistent across methods")
            if method.overall.n != self.dataset.n_pairs:
                raise ValueError("method denominator must equal dataset n_pairs")
        return self


class AdapterDefinition(_StrictModel):
    id: Literal["zendesk", "intercom", "chatwoot", "zammad", "generic"]
    name: str = Field(min_length=1)
    accepted_exports: tuple[str, ...] = Field(min_length=1)
    mapping_required: bool
    direction: Literal["export-read-only"] = "export-read-only"
    description: str = Field(min_length=1)


class AdaptersResponse(_StrictModel):
    adapters: tuple[AdapterDefinition, ...]
    count: Literal[5] = 5
    customer_write_access: Literal["none"] = "none"
    message: str = _NO_WRITE_MESSAGE

    @model_validator(mode="after")
    def validate_adapter_set(self) -> Self:
        expected = {"zendesk", "intercom", "chatwoot", "zammad", "generic"}
        if len(self.adapters) != self.count or {item.id for item in self.adapters} != expected:
            raise ValueError("adapter response must contain each of the five export adapters once")
        return self


class DetectorDefinition(_StrictModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{1,48}$")
    kind: Literal["duplicate_charge", "late_delivery", "wrong_item", "account_lock"]
    title: str = Field(min_length=3, max_length=80)
    condition: str = Field(min_length=10, max_length=500)
    base_score: float = Field(ge=0, le=1)
    variants: tuple[str, ...] = Field(min_length=1, max_length=10)
    status: Literal["confirmed", "proposed"]
    support: int = Field(gt=0)
    support_denominator: int = Field(gt=0)
    precision_correct: int = Field(ge=0)
    precision_sample_size: int = Field(gt=0)
    measurement_basis: Literal[
        "synthetic fixture assertions; not a production or human-reviewed estimate"
    ] = "synthetic fixture assertions; not a production or human-reviewed estimate"

    @computed_field
    @property
    def precision_estimate(self) -> float:
        return self.precision_correct / self.precision_sample_size

    @computed_field
    @property
    def runnable(self) -> bool:
        return self.status == "confirmed"

    @model_validator(mode="after")
    def validate_denominators(self) -> Self:
        if self.support > self.support_denominator:
            raise ValueError("detector support cannot exceed its corpus denominator")
        if self.precision_correct > self.precision_sample_size:
            raise ValueError("precision numerator cannot exceed its reviewed denominator")
        if len(self.variants) != len(set(self.variants)):
            raise ValueError("detector variants must be unique")
        return self


class DetectorsResponse(_StrictModel):
    detectors: tuple[DetectorDefinition, ...]
    corpus_denominator: int = Field(gt=0)
    customer_write_access: Literal["none"] = "none"
    review_mode: Literal["stateless-validation-only"] = "stateless-validation-only"
    message: str = _NO_WRITE_MESSAGE

    @model_validator(mode="after")
    def validate_detector_set(self) -> Self:
        if len({item.id for item in self.detectors}) != len(self.detectors):
            raise ValueError("detector identifiers must be unique")
        if any(item.support_denominator != self.corpus_denominator for item in self.detectors):
            raise ValueError("detectors must use the declared corpus denominator")
        if not any(item.status == "confirmed" for item in self.detectors):
            raise ValueError("fixture set must expose at least one confirmed detector")
        return self


class DetectorReviewRequest(_StrictModel):
    decision: Literal["approved", "rejected"]
    precision_correct: int = Field(ge=0)
    precision_sample_size: int = Field(gt=0)
    proposed_condition: str | None = Field(default=None, min_length=10, max_length=500)

    @model_validator(mode="after")
    def validate_precision(self) -> Self:
        if self.precision_correct > self.precision_sample_size:
            raise ValueError("precision_correct cannot exceed precision_sample_size")
        return self


class DetectorReviewEcho(_StrictModel):
    detector_id: str
    validated: Literal[True] = True
    decision: Literal["approved", "rejected"]
    would_set_status: Literal["confirmed", "rejected"]
    precision_correct: int
    precision_sample_size: int
    precision_estimate: float = Field(ge=0, le=1)
    proposed_condition: str | None
    persisted: Literal[False] = False
    external_write_attempted: Literal[False] = False
    message: str = _NO_WRITE_MESSAGE


class RunStageEvent(_StrictModel):
    run_id: Literal["fixture"] = "fixture"
    sequence: int = Field(ge=1, le=6)
    stage: Literal[
        "validate_export",
        "redact_personal_data",
        "reconstruct_state",
        "evaluate_detectors",
        "rerank_and_abstain",
        "build_audit_report",
    ]
    label: str = Field(min_length=1)
    status: Literal["completed"] = "completed"
    elapsed_seconds: None = None
    detail: str = Field(min_length=1)
    measured: Literal[False] = False
    measurement_basis: Literal[
        "deterministic synthetic fixture counts; runtime timing not recorded"
    ] = "deterministic synthetic fixture counts; runtime timing not recorded"


class RunCompleteEvent(_StrictModel):
    run_id: Literal["fixture"] = "fixture"
    status: Literal["completed"] = "completed"
    stage_count: Literal[6] = 6
    elapsed_seconds: None = None
    measured: Literal[False] = False
    customer_write_access: Literal["none"] = "none"
    message: str = _NO_WRITE_MESSAGE


_ADAPTERS: tuple[AdapterDefinition, ...] = (
    AdapterDefinition(
        id="zendesk",
        name="Zendesk",
        accepted_exports=("ZIP", "JSON"),
        mapping_required=False,
        description="Reads ticket, comment, user, and custom-field exports.",
    ),
    AdapterDefinition(
        id="intercom",
        name="Intercom",
        accepted_exports=("ZIP", "JSON"),
        mapping_required=False,
        description="Reads conversation, part, tag, and attribute exports.",
    ),
    AdapterDefinition(
        id="chatwoot",
        name="Chatwoot",
        accepted_exports=("JSON",),
        mapping_required=False,
        description="Reads conversation, message, and contact exports.",
    ),
    AdapterDefinition(
        id="zammad",
        name="Zammad",
        accepted_exports=("JSON",),
        mapping_required=False,
        description="Reads ticket, article, and customer-record exports.",
    ),
    AdapterDefinition(
        id="generic",
        name="Mapped CSV",
        accepted_exports=("CSV", "YAML mapping"),
        mapping_required=True,
        description="Reads a CSV through an explicit canonical column mapping.",
    ),
)


_DETECTORS: tuple[DetectorDefinition, ...] = (
    DetectorDefinition(
        id="duplicate_charge",
        kind="duplicate_charge",
        title="You were charged twice",
        condition="At least two succeeded charges have the same amount and occur no more than one hour apart.",
        base_score=0.90,
        variants=("money taken twice", "paid two times", "duplicate card charge"),
        status="confirmed",
        support=6,
        support_denominator=30,
        precision_correct=6,
        precision_sample_size=6,
    ),
    DetectorDefinition(
        id="late_delivery",
        kind="late_delivery",
        title="Your delivery is late",
        condition="The promised delivery time has passed and no completed delivery scan exists.",
        base_score=0.85,
        variants=("still not come", "order has not arrived", "package overdue"),
        status="confirmed",
        support=6,
        support_denominator=30,
        precision_correct=6,
        precision_sample_size=6,
    ),
    DetectorDefinition(
        id="wrong_item",
        kind="wrong_item",
        title="You received the wrong item",
        condition="The fulfilled SKU or variant differs from every line item on the customer order.",
        base_score=0.90,
        variants=("order wrong thing", "different product arrived", "not what I ordered"),
        status="confirmed",
        support=6,
        support_denominator=30,
        precision_correct=6,
        precision_sample_size=6,
    ),
    DetectorDefinition(
        id="account_lock",
        kind="account_lock",
        title="Your account is locked",
        condition="The account lock is active after at least three failed sign-in attempts within thirty minutes.",
        base_score=0.90,
        variants=("cannot get in", "login blocked", "too many attempts"),
        status="confirmed",
        support=6,
        support_denominator=30,
        precision_correct=6,
        precision_sample_size=6,
    ),
)


_RUN_EVENTS: tuple[RunStageEvent, ...] = (
    RunStageEvent(sequence=1, stage="validate_export", label="Validate fixture", detail="30 / 30 synthetic interactions passed schema and chronology checks."),
    RunStageEvent(sequence=2, stage="redact_personal_data", label="Verify redaction boundary", detail="30 / 30 synthetic messages were marked redacted before pipeline entry."),
    RunStageEvent(sequence=3, stage="reconstruct_state", label="Reconstruct state", detail="48 exported synthetic facts were available across 30 / 30 interactions."),
    RunStageEvent(sequence=4, stage="evaluate_detectors", label="Evaluate detectors", detail="Four confirmed conditions produced evidence hypotheses for 24 / 30 interactions."),
    RunStageEvent(sequence=5, stage="rerank_and_abstain", label="Rerank and abstain", detail="At most three candidates were retained; 9 / 30 interactions abstained."),
    RunStageEvent(sequence=6, stage="build_audit_report", label="Build audit report", detail="The synthetic report listed 9 / 30 evidence-resolution disagreements."),
)


class BenchmarkReadError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _reject_duplicate_keys(items: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            raise BenchmarkReadError("duplicate_json_key")
        result[key] = value
    return result


def _reject_non_finite(value: str) -> None:
    raise BenchmarkReadError(f"non_finite_number:{value}")


def read_benchmark_artifact(settings: ApiSettings) -> tuple[BenchmarkArtifact, str]:
    """Read, hash, and strictly validate the one configured in-workspace artifact."""

    path = settings.benchmark_result.resolve(strict=False)
    try:
        path.relative_to(settings.workspace)
    except ValueError as exc:
        raise BenchmarkReadError("outside_workspace") from exc
    try:
        if not path.is_file():
            raise BenchmarkReadError("not_found")
        size = path.stat().st_size
        if size > settings.max_benchmark_bytes:
            raise BenchmarkReadError("too_large")
        payload_bytes = path.read_bytes()
    except BenchmarkReadError:
        raise
    except OSError as exc:
        raise BenchmarkReadError("read_failed") from exc
    if len(payload_bytes) > settings.max_benchmark_bytes:
        raise BenchmarkReadError("too_large")
    try:
        raw = json.loads(
            payload_bytes,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_non_finite,
        )
    except BenchmarkReadError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BenchmarkReadError("invalid_json") from exc
    if not isinstance(raw, dict):
        raise BenchmarkReadError("invalid_schema")
    try:
        # JSON-aware strict validation accepts JSON arrays for immutable tuple
        # fields while still rejecting string-to-number coercion.
        artifact = BenchmarkArtifact.model_validate_json(payload_bytes, strict=True)
    except (TypeError, ValueError) as exc:
        raise BenchmarkReadError("invalid_schema") from exc
    return artifact, hashlib.sha256(payload_bytes).hexdigest()


def _sse_record(*, event_id: str, event: str, data: BaseModel) -> bytes:
    return (
        f"id: {event_id}\nevent: {event}\ndata: {data.model_dump_json()}\n\n"
    ).encode("utf-8")


def fixture_event_stream() -> Iterator[bytes]:
    """Yield completed measurements immediately and deterministically."""

    for stage in _RUN_EVENTS:
        yield _sse_record(
            event_id=str(stage.sequence),
            event="stage.completed",
            data=stage,
        )
    complete = RunCompleteEvent()
    yield _sse_record(event_id="complete", event="run.completed", data=complete)


def create_app(
    *,
    settings: ApiSettings | None = None,
    environ: Mapping[str, str] | None = None,
    embedding_model_factory: Callable[..., Any] | None = None,
    llm_model_validators: Mapping[str, Callable[[str], bool]] | None = None,
) -> FastAPI:
    """Construct an app only after core and API startup settings validate."""

    core_config: CoreConfig = load_config(environ)
    validate_configured_models(
        core_config,
        embedding_model_factory=embedding_model_factory,
        llm_model_validators=llm_model_validators,
    )
    api_settings = ApiSettings.from_env(environ) if settings is None else settings
    api_settings.validate_runtime()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        api_settings.validate_runtime()
        yield

    application = FastAPI(
        title="Wordless local audit API",
        description=(
            "Read-only projections over local audit artifacts. "
            "No endpoint can mutate a customer system; detector review is validation-only."
        ),
        version="0.1.0",
        lifespan=lifespan,
    )
    application.state.api_settings = api_settings
    application.state.core_config = core_config

    @application.middleware("http")
    async def declare_read_only_boundary(request: Request, call_next: Any) -> Response:
        response: Response = await call_next(request)
        response.headers["X-Wordless-Mode"] = "local-read-only"
        response.headers["X-Wordless-Customer-Write"] = "none"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @application.get("/health", response_model=HealthResponse, tags=["system"])
    def health() -> HealthResponse:
        return HealthResponse(
            workspace_ready=api_settings.workspace.is_dir(),
            benchmark_available=api_settings.benchmark_result.is_file(),
        )

    @application.get(
        "/api/benchmark",
        response_model=BenchmarkArtifact,
        response_model_exclude_unset=True,
        tags=["benchmark"],
    )
    def benchmark(response: Response) -> BenchmarkArtifact:
        try:
            artifact, digest = read_benchmark_artifact(api_settings)
        except BenchmarkReadError as exc:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "benchmark_unavailable",
                    "reason": exc.code.split(":", 1)[0],
                    "message": "The configured canonical benchmark result is unavailable or invalid.",
                },
            ) from exc
        response.headers["X-Wordless-Artifact"] = api_settings.benchmark_relative_path
        response.headers["ETag"] = f'"sha256-{digest}"'
        return artifact

    @application.get("/api/adapters", response_model=AdaptersResponse, tags=["ingest"])
    def adapters() -> AdaptersResponse:
        return AdaptersResponse(adapters=_ADAPTERS)

    @application.get("/api/detectors", response_model=DetectorsResponse, tags=["detectors"])
    def detectors() -> DetectorsResponse:
        return DetectorsResponse(detectors=_DETECTORS, corpus_denominator=30)

    @application.post(
        "/api/detectors/{detector_id}/review",
        response_model=DetectorReviewEcho,
        tags=["detectors"],
        summary="Validate and echo a detector review without persisting it",
    )
    def review_detector(
        review: DetectorReviewRequest,
        detector_id: str = Path(pattern=r"^[a-z][a-z0-9_]{1,48}$"),
    ) -> DetectorReviewEcho:
        detector = next((item for item in _DETECTORS if item.id == detector_id), None)
        if detector is None:
            raise HTTPException(status_code=404, detail="Unknown detector fixture")
        if review.precision_sample_size > detector.support:
            raise HTTPException(
                status_code=422,
                detail=(
                    "precision_sample_size cannot exceed this detector's support denominator"
                ),
            )
        return DetectorReviewEcho(
            detector_id=detector.id,
            decision=review.decision,
            would_set_status="confirmed" if review.decision == "approved" else "rejected",
            precision_correct=review.precision_correct,
            precision_sample_size=review.precision_sample_size,
            precision_estimate=review.precision_correct / review.precision_sample_size,
            proposed_condition=review.proposed_condition,
        )

    @application.get("/api/runs/fixture/events", tags=["runs"])
    def fixture_events() -> StreamingResponse:
        return StreamingResponse(
            fixture_event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return application


app = create_app()


__all__ = [
    "ApiSettings",
    "BenchmarkArtifact",
    "DetectorReviewRequest",
    "app",
    "create_app",
    "fixture_event_stream",
    "read_benchmark_artifact",
]

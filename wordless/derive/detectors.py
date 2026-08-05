"""Stage 4: detector proposals that cannot run until a human approves them."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
import json
from types import MappingProxyType
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)
import yaml
from yaml.constructor import ConstructorError
from yaml.nodes import MappingNode

from wordless.core.models import Interaction
from wordless.core.redact import Redactor
from wordless.pipeline.candidates import (
    DEFAULT_DETECTORS,
    Detector,
    DetectorKind,
    evaluate_detector,
)

from .taxonomy import Taxonomy


DetectorOperation = Literal[
    "duplicate_charge",
    "late_delivery",
    "account_locked",
    "wrong_item",
]
RuntimeDetectorId = Literal[
    "account_lock",
    "duplicate_charge",
    "late_delivery",
    "wrong_item",
]

_OPERATION_BY_RUNTIME_ID: dict[RuntimeDetectorId, DetectorOperation] = {
    "account_lock": "account_locked",
    "duplicate_charge": "duplicate_charge",
    "late_delivery": "late_delivery",
    "wrong_item": "wrong_item",
}


class _UniqueKeySafeLoader(yaml.SafeLoader):
    """Safe YAML loader that rejects ambiguous duplicate and merged keys."""

    def construct_mapping(
        self,
        node: MappingNode,
        deep: bool = False,
    ) -> dict[object, object]:
        if not isinstance(node, MappingNode):
            raise ConstructorError(
                None,
                None,
                f"expected a mapping node, found {node.id}",
                node.start_mark,
            )
        self.flatten_mapping(node)
        mapping: dict[object, object] = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            try:
                duplicate = key in mapping
            except TypeError as exc:
                raise ConstructorError(
                    "while constructing a mapping",
                    node.start_mark,
                    "found an unhashable mapping key",
                    key_node.start_mark,
                ) from exc
            if duplicate:
                raise ConstructorError(
                    "while constructing a mapping",
                    node.start_mark,
                    f"found duplicate key {key!r}",
                    key_node.start_mark,
                )
            mapping[key] = self.construct_object(value_node, deep=deep)
        return mapping


class DetectorConditionParameters(BaseModel):
    """Immutable, typed evidence tying a proposal to one safe runtime template."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    runtime_detector_id: RuntimeDetectorId
    members_examined: int = Field(gt=0)
    matching_members: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_counts(self) -> "DetectorConditionParameters":
        if self.matching_members > self.members_examined:
            raise ValueError("matching members cannot exceed members examined")
        return self


class DetectorCondition(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: DetectorOperation
    parameters: DetectorConditionParameters

    @model_validator(mode="after")
    def validate_runtime_template(self) -> "DetectorCondition":
        expected = _OPERATION_BY_RUNTIME_ID[self.parameters.runtime_detector_id]
        if self.operation != expected:
            raise ValueError(
                "condition operation must match its audited runtime detector"
            )
        return self


class DetectorConditionEvaluation(BaseModel):
    """Immutable label and corpus counts for one safe condition template."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    runtime_detector_id: RuntimeDetectorId
    label_matches: int = Field(ge=0)
    corpus_members_examined: int = Field(gt=0)
    corpus_matches: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_counts(self) -> "DetectorConditionEvaluation":
        if self.label_matches > self.corpus_matches:
            raise ValueError("label matches cannot exceed full-corpus matches")
        if self.corpus_matches > self.corpus_members_examined:
            raise ValueError("corpus matches cannot exceed corpus members examined")
        return self

    @property
    def outside_label_matches(self) -> int:
        return self.corpus_matches - self.label_matches


class DetectorProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(pattern=r"^[a-z][a-z0-9_]{1,48}$")
    label: str = Field(min_length=3)
    condition: DetectorCondition
    base_score: float = Field(ge=0, le=1)
    support: int = Field(gt=0)
    state_members_examined: int = Field(gt=0)
    state_matches: int = Field(ge=0)
    state_method: str = Field(min_length=3)
    precision_correct: int | None = Field(default=None, ge=0)
    precision_sample_size: int | None = Field(default=None, gt=0)
    precision_method: str = Field(
        default="not estimated; requires human-reviewed state evaluation",
        min_length=3,
    )
    variants: tuple[str, ...] = Field(min_length=1, max_length=10)
    status: Literal["proposed", "approved", "rejected"] = "proposed"

    @field_validator("label", "state_method", "precision_method")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        if not value or value != value.strip():
            raise ValueError("proposal text fields must be trimmed and non-empty")
        return value

    @field_validator("variants")
    @classmethod
    def validate_variants(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if any(not value or value != value.strip() for value in values):
            raise ValueError("proposal variants must be trimmed and non-empty")
        if len(set(values)) != len(values):
            raise ValueError("proposal variants must be unique")
        return values

    @model_validator(mode="after")
    def validate_precision(self) -> "DetectorProposal":
        if self.state_matches > self.state_members_examined:
            raise ValueError("state matches cannot exceed members examined")
        if self.support != self.state_members_examined:
            raise ValueError(
                "proposal support must equal full-corpus taxonomy-cluster membership"
            )
        if self.state_matches == 0:
            raise ValueError("a proposal requires at least one audited state match")
        if not self.state_method.strip():
            raise ValueError("state evaluation method must not be blank")
        counts_are_missing = self.precision_correct is None and self.precision_sample_size is None
        if (self.precision_correct is None) != (self.precision_sample_size is None):
            raise ValueError("precision numerator and sample size must both be present or both be null")
        if self.status == "proposed" and not counts_are_missing:
            raise ValueError("proposed detectors cannot claim precision before review and evaluation")
        if self.status != "proposed" and counts_are_missing:
            raise ValueError("reviewed detectors require precision evaluation counts")
        if (
            self.precision_correct is not None
            and self.precision_sample_size is not None
            and self.precision_correct > self.precision_sample_size
        ):
            raise ValueError("precision numerator cannot exceed its sample size")
        return self

    @property
    def precision_estimate(self) -> float | None:
        if self.precision_correct is None or self.precision_sample_size is None:
            return None
        return self.precision_correct / self.precision_sample_size

    @property
    def runnable(self) -> bool:
        return self.status == "approved"


class DetectorDerivationOutcome(BaseModel):
    """Auditable Stage 4 result for every derived full-corpus label."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    taxonomy_label_id: str = Field(pattern=r"^[a-z][a-z0-9_]{1,48}$")
    taxonomy_label: str = Field(min_length=3)
    member_count: int = Field(ge=0)
    minimum_support: int = Field(gt=0)
    status: Literal[
        "below_frequency_floor",
        "no_supported_condition",
        "proposed",
    ]
    condition_evaluations: tuple[DetectorConditionEvaluation, ...] = ()
    method: str = Field(min_length=3)
    proposal: DetectorProposal | None = None

    @property
    def state_matches_by_condition(self) -> Mapping[str, int]:
        """Read-only compatibility view of per-label state matches."""

        return MappingProxyType(
            {
                item.runtime_detector_id: item.label_matches
                for item in self.condition_evaluations
            }
        )

    @model_validator(mode="after")
    def validate_outcome(self) -> "DetectorDerivationOutcome":
        expected_conditions: set[RuntimeDetectorId] = {
            "account_lock",
            "duplicate_charge",
            "late_delivery",
            "wrong_item",
        }
        runtime_ids = tuple(
            item.runtime_detector_id for item in self.condition_evaluations
        )
        if runtime_ids != tuple(sorted(runtime_ids)):
            raise ValueError("condition evaluations must use canonical runtime-id order")
        if len(runtime_ids) != len(set(runtime_ids)):
            raise ValueError("condition evaluations must have unique runtime IDs")
        if any(item.label_matches > self.member_count for item in self.condition_evaluations):
            raise ValueError("condition match counts must fit inside label membership")
        corpus_sizes = {
            item.corpus_members_examined for item in self.condition_evaluations
        }
        if len(corpus_sizes) > 1:
            raise ValueError("condition evaluations must share one corpus denominator")
        if corpus_sizes and next(iter(corpus_sizes)) < self.member_count:
            raise ValueError("corpus denominator cannot be smaller than label membership")
        match_counts = self.state_matches_by_condition
        if self.status == "below_frequency_floor":
            if self.member_count >= self.minimum_support or self.proposal is not None:
                raise ValueError("below-floor outcomes must be below the declared floor")
            if self.condition_evaluations:
                raise ValueError("below-floor outcomes must not claim state evaluation")
        elif self.status == "no_supported_condition":
            if self.member_count < self.minimum_support or self.proposal is not None:
                raise ValueError("no-condition outcomes require an above-floor label")
            if any(match_counts.values()):
                raise ValueError("no-condition outcome cannot hide a supported state match")
            if set(match_counts) != expected_conditions:
                raise ValueError("above-floor outcomes must audit every condition template")
        else:
            if self.member_count < self.minimum_support or self.proposal is None:
                raise ValueError("proposed outcomes require an above-floor proposal")
            if (
                self.proposal.id != self.taxonomy_label_id
                or self.proposal.support != self.member_count
            ):
                raise ValueError("proposal identity/support must match its taxonomy outcome")
            if self.proposal.status != "proposed":
                raise ValueError("derivation outcomes must contain unreviewed proposals")
            if set(match_counts) != expected_conditions:
                raise ValueError("above-floor outcomes must audit every condition template")
            parameters = self.proposal.condition.parameters
            runtime_id = parameters.runtime_detector_id
            if runtime_id not in match_counts:
                raise ValueError("proposal runtime detector was not evaluated")
            chosen_matches = match_counts[runtime_id]
            if (
                chosen_matches != self.proposal.state_matches
                or chosen_matches != parameters.matching_members
            ):
                raise ValueError(
                    "proposal match counts must equal its audited condition result"
                )
            if (
                parameters.members_examined != self.member_count
                or self.proposal.state_members_examined != self.member_count
            ):
                raise ValueError(
                    "proposal condition denominator must equal label membership"
                )
            if chosen_matches != max(match_counts.values()):
                raise ValueError("proposal must use a maximum-support safe condition")
            if self.proposal.state_method != self.method:
                raise ValueError("proposal and outcome must cite the same state method")
        return self


_PROPOSALS: dict[str, tuple[str, DetectorOperation]] = {
    "duplicate_charge": ("duplicate_charge", "duplicate_charge"),
    "delivery": ("late_delivery", "late_delivery"),
    "account_access": ("account_lock", "account_locked"),
    "wrong_or_damaged_item": ("wrong_item", "wrong_item"),
}

_RUNTIME_TEMPLATE: dict[RuntimeDetectorId, tuple[DetectorOperation, DetectorKind]] = {
    "duplicate_charge": ("duplicate_charge", "duplicate_charge"),
    "late_delivery": ("late_delivery", "late_delivery"),
    "account_lock": ("account_locked", "account_lock"),
    "wrong_item": ("wrong_item", "wrong_item"),
}

_DEFAULT_DETECTORS_BY_ID: dict[str, Detector] = {
    detector.id: detector for detector in DEFAULT_DETECTORS if detector.confirmed
}
_STATE_METHOD = (
    "matching confirmed DEFAULT_DETECTORS evaluator applied at interaction.opened_at "
    "to every canonical label member and full-corpus member; label and corpus match "
    "counts are reported separately"
)


def _validated_members(
    taxonomy: Taxonomy,
    members_by_label: Mapping[str, Iterable[Interaction]],
) -> dict[str, tuple[Interaction, ...]]:
    expected_labels = {label.id for label in taxonomy.labels}
    provided_labels = set(members_by_label)
    if provided_labels != expected_labels:
        missing = sorted(expected_labels - provided_labels)
        unexpected = sorted(provided_labels - expected_labels)
        raise ValueError(
            "members_by_label keys must exactly match taxonomy labels "
            f"(missing={missing}, unexpected={unexpected})"
        )

    members: dict[str, tuple[Interaction, ...]] = {}
    seen_interaction_ids: set[str] = set()
    for label in taxonomy.labels:
        raw_members = tuple(members_by_label[label.id])
        canonical_members: list[Interaction] = []
        for member in raw_members:
            if type(member) is not Interaction:
                raise TypeError(
                    "detector derivation members must be canonical Interaction instances"
                )
            canonical = Interaction.model_validate(
                member.model_dump(mode="python", round_trip=True),
                strict=True,
            )
            if canonical.id in seen_interaction_ids:
                raise ValueError(
                    "interaction IDs must be unique across members_by_label; "
                    f"duplicate {canonical.id!r}"
                )
            seen_interaction_ids.add(canonical.id)
            canonical_members.append(canonical)
        members[label.id] = tuple(canonical_members)
    return members


def derive_detector_outcomes(
    taxonomy: Taxonomy,
    *,
    members_by_label: Mapping[str, Iterable[Interaction]],
    minimum_support: int = 2,
) -> tuple[DetectorDerivationOutcome, ...]:
    """Return one explicit Stage 4 result for every full-corpus label.

    ``minimum_support`` is a taxonomy-cluster frequency floor.  For each label
    above it, all four safe built-in condition templates are evaluated over
    point-in-time state, independent of the label's name.  Unsupported labels
    remain explicit outcomes instead of disappearing or gaining invented code.
    """

    if minimum_support <= 0:
        raise ValueError("minimum_support must be positive")
    if not isinstance(members_by_label, Mapping):
        raise TypeError("members_by_label must be a mapping")
    validated_members = _validated_members(taxonomy, members_by_label)
    corpus_members = tuple(
        member
        for label in taxonomy.labels
        for member in validated_members[label.id]
    )
    corpus_match_counts = {
        detector.id: sum(
            evaluate_detector(
                detector,
                member.state_snapshot,
                as_of=member.opened_at,
            )
            is not None
            for member in corpus_members
        )
        for detector in sorted(
            _DEFAULT_DETECTORS_BY_ID.values(), key=lambda item: item.id
        )
    }

    outcomes: list[DetectorDerivationOutcome] = []
    for label in taxonomy.labels:
        members = validated_members[label.id]
        member_count = len(members)
        if member_count < minimum_support:
            outcomes.append(
                DetectorDerivationOutcome(
                    taxonomy_label_id=label.id,
                    taxonomy_label=label.name,
                    member_count=member_count,
                    minimum_support=minimum_support,
                    status="below_frequency_floor",
                    method="full-corpus distilled-label frequency floor; state not evaluated",
                )
            )
            continue
        condition_evaluations = tuple(
            DetectorConditionEvaluation(
                runtime_detector_id=detector.id,
                label_matches=sum(
                    evaluate_detector(
                        detector,
                        member.state_snapshot,
                        as_of=member.opened_at,
                    )
                    is not None
                    for member in members
                ),
                corpus_members_examined=len(corpus_members),
                corpus_matches=corpus_match_counts[detector.id],
            )
            for detector in sorted(
                _DEFAULT_DETECTORS_BY_ID.values(), key=lambda item: item.id
            )
        )
        match_counts = {
            item.runtime_detector_id: item.label_matches
            for item in condition_evaluations
        }
        preferred_id = (_PROPOSALS.get(label.id) or (None, None))[0]
        detector = min(
            _DEFAULT_DETECTORS_BY_ID.values(),
            key=lambda item: (
                -match_counts[item.id],
                corpus_match_counts[item.id] - match_counts[item.id],
                item.id != preferred_id,
                item.id,
            ),
        )
        state_matches = match_counts[detector.id]
        if state_matches == 0:
            outcomes.append(
                DetectorDerivationOutcome(
                    taxonomy_label_id=label.id,
                    taxonomy_label=label.name,
                    member_count=member_count,
                    minimum_support=minimum_support,
                    status="no_supported_condition",
                    condition_evaluations=condition_evaluations,
                    method=_STATE_METHOD,
                )
            )
            continue
        operation, _kind = _RUNTIME_TEMPLATE[detector.id]
        proposal = DetectorProposal(
            id=label.id,
            label=detector.title,
            condition=DetectorCondition(
                operation=operation,
                parameters=DetectorConditionParameters(
                    runtime_detector_id=detector.id,
                    members_examined=member_count,
                    matching_members=state_matches,
                ),
            ),
            base_score=detector.base_score,
            support=member_count,
            state_members_examined=member_count,
            state_matches=state_matches,
            state_method=_STATE_METHOD,
            variants=detector.variants,
            status="proposed",
        )
        outcomes.append(
            DetectorDerivationOutcome(
                taxonomy_label_id=label.id,
                taxonomy_label=label.name,
                member_count=member_count,
                minimum_support=minimum_support,
                status="proposed",
                condition_evaluations=condition_evaluations,
                method=_STATE_METHOD,
                proposal=proposal,
            )
        )
    return tuple(sorted(outcomes, key=lambda item: item.taxonomy_label_id))


def propose_detectors(
    taxonomy: Taxonomy,
    *,
    members_by_label: Mapping[str, Iterable[Interaction]],
    minimum_support: int = 2,
) -> tuple[DetectorProposal, ...]:
    """Return only proposals; use ``derive_detector_outcomes`` for all labels."""

    return tuple(
        outcome.proposal
        for outcome in derive_detector_outcomes(
            taxonomy,
            members_by_label=members_by_label,
            minimum_support=minimum_support,
        )
        if outcome.proposal is not None
    )


def review_detector(
    proposal: DetectorProposal,
    decision: Literal["approved", "rejected"],
    *,
    precision_correct: int,
    precision_sample_size: int,
    precision_method: str = "caller-supplied human review and state-evaluation counts",
    redactor: Redactor | None = None,
) -> DetectorProposal:
    """Record an explicit human review; there is no auto-approval path."""

    canonical = _canonical_proposal(proposal)
    payload = canonical.model_dump(exclude_computed_fields=True)
    payload.update(
        status=decision,
        precision_correct=precision_correct,
        precision_sample_size=precision_sample_size,
        precision_method=precision_method,
    )
    reviewed = DetectorProposal.model_validate(payload, strict=True)
    return _sanitize_proposal_text(reviewed, redactor=redactor)


def _canonical_proposal(proposal: DetectorProposal) -> DetectorProposal:
    """Rebuild from JSON primitives so unchecked ``model_copy`` cannot bypass review."""

    if type(proposal) is not DetectorProposal:
        raise TypeError("proposal must be a concrete DetectorProposal")
    try:
        return DetectorProposal.model_validate_json(
            proposal.model_dump_json(exclude_computed_fields=True),
            strict=True,
        )
    except (TypeError, ValueError) as exc:
        raise ValueError("proposal failed canonical schema revalidation") from exc


def _validated_redactor(redactor: Redactor | None) -> Redactor:
    if redactor is not None and type(redactor) is not Redactor:
        raise TypeError("redactor must be a concrete Redactor instance")
    active = redactor or Redactor()
    if not active.boundary_safe:
        raise ValueError("detector text requires the mandatory pinned redaction policy")
    return active


def _sanitize_proposal_text(
    proposal: DetectorProposal,
    *,
    redactor: Redactor | None,
) -> DetectorProposal:
    active = _validated_redactor(redactor)
    payload = proposal.model_dump(exclude_computed_fields=True)
    payload["label"] = active.redact(proposal.label).text
    payload["state_method"] = active.redact(proposal.state_method).text
    payload["precision_method"] = active.redact(proposal.precision_method).text
    payload["variants"] = tuple(
        dict.fromkeys(active.redact(value).text for value in proposal.variants)
    )
    return DetectorProposal.model_validate(payload, strict=True)


def compile_approved_proposal(
    proposal: DetectorProposal,
    *,
    redactor: Redactor | None = None,
) -> Detector:
    """Compile one human-approved declarative proposal without dynamic code."""

    proposal = _canonical_proposal(proposal)
    proposal = _sanitize_proposal_text(proposal, redactor=redactor)
    if proposal.status != "approved":
        raise ValueError("only an approved detector proposal can be compiled")
    runtime_id = proposal.condition.parameters.runtime_detector_id
    _operation, kind = _RUNTIME_TEMPLATE[runtime_id]
    expected_parameters = DetectorConditionParameters(
        runtime_detector_id=runtime_id,
        members_examined=proposal.state_members_examined,
        matching_members=proposal.state_matches,
    )
    if proposal.condition.parameters != expected_parameters:
        raise ValueError("proposal condition parameters do not match its audited template")
    return Detector(
        id=runtime_id,
        kind=kind,
        title=proposal.label,
        base_score=proposal.base_score,
        variants=proposal.variants,
        confirmed=True,
        derivation_proposal_id=proposal.id,
    )


def activate_approved_proposals(
    proposals: Iterable[DetectorProposal],
    *,
    base_detectors: Iterable[Detector] = DEFAULT_DETECTORS,
    redactor: Redactor | None = None,
) -> tuple[Detector, ...]:
    """Replace matching runtime templates with explicitly approved versions."""

    active: dict[str, Detector] = {}
    for detector in base_detectors:
        if type(detector) is not Detector:
            raise TypeError("base_detectors must contain concrete Detector instances")
        if detector.id in active:
            raise ValueError(f"duplicate base detector id: {detector.id}")
        active[detector.id] = detector
    replacements: dict[str, Detector] = {}
    active_redactor = _validated_redactor(redactor)
    for proposal in proposals:
        detector = compile_approved_proposal(proposal, redactor=active_redactor)
        if detector.id in replacements:
            raise ValueError(f"multiple approved proposals target {detector.id}")
        replacements[detector.id] = detector
    active.update(replacements)
    return tuple(active[identifier] for identifier in sorted(active))


def detectors_yaml(
    proposals: Iterable[DetectorProposal],
    *,
    redactor: Redactor | None = None,
) -> str:
    """Serialize canonical, redacted proposals without computed schema extras."""

    active_redactor = _validated_redactor(redactor)
    canonical = tuple(
        _sanitize_proposal_text(
            _canonical_proposal(proposal),
            redactor=active_redactor,
        )
        for proposal in proposals
    )
    identifiers = [proposal.id for proposal in canonical]
    if len(identifiers) != len(set(identifiers)):
        raise ValueError("detector proposal IDs must be unique")
    payload = [
        proposal.model_dump(
            mode="json",
            exclude_computed_fields=True,
        )
        for proposal in sorted(canonical, key=lambda item: item.id)
    ]
    return yaml.safe_dump(payload, sort_keys=False, allow_unicode=True)


def load_detector_proposals_yaml(
    text: str,
    *,
    redactor: Redactor | None = None,
) -> tuple[DetectorProposal, ...]:
    """Strictly load and rescan persisted detector proposals."""

    if not isinstance(text, str):
        raise TypeError("detector proposal YAML must be text")
    try:
        raw = yaml.load(text, Loader=_UniqueKeySafeLoader)
    except yaml.YAMLError as exc:
        raise ValueError(
            "invalid detector proposal YAML; duplicate keys are forbidden"
        ) from exc
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        raise ValueError("detector proposal YAML must contain a list")
    active_redactor = _validated_redactor(redactor)
    proposals: list[DetectorProposal] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"detector proposal at index {index} must be a mapping")
        try:
            serialized = json.dumps(
                item,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
                sort_keys=True,
            )
            proposal = DetectorProposal.model_validate_json(serialized, strict=True)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"detector proposal at index {index} failed strict validation"
            ) from exc
        proposals.append(
            _sanitize_proposal_text(proposal, redactor=active_redactor)
        )
    identifiers = [proposal.id for proposal in proposals]
    if len(identifiers) != len(set(identifiers)):
        raise ValueError("detector proposal IDs must be unique")
    return tuple(sorted(proposals, key=lambda item: item.id))


__all__ = [
    "DetectorCondition",
    "DetectorConditionEvaluation",
    "DetectorConditionParameters",
    "DetectorDerivationOutcome",
    "DetectorProposal",
    "RuntimeDetectorId",
    "activate_approved_proposals",
    "compile_approved_proposal",
    "derive_detector_outcomes",
    "detectors_yaml",
    "load_detector_proposals_yaml",
    "propose_detectors",
    "review_detector",
]

"""Strict public contracts for the server-to-server real-time API."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
import re
from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)


_REFERENCE_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
_TENANT_PATTERN = r"^[a-z][a-z0-9_-]{1,62}$"
_RUN_PATTERN = r"^sg_[0-9a-f]{32}$"
_FEEDBACK_PATTERN = r"^fb_[0-9a-f]{32}$"
_DETECTOR_PATTERN = r"^[a-z][a-z0-9_]{1,48}$"
_CURRENCY_PATTERN = r"^[A-Z]{3}$"
_MAX_TEXT_LENGTH = 4_000
_MAX_EVIDENCE = 100


class StrictContract(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        strict=True,
        allow_inf_nan=False,
    )


def _require_aware(value: datetime, *, field_name: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field_name} must include a timezone offset")
    return value


def _validate_reference(value: str, *, field_name: str) -> str:
    if not re.fullmatch(_REFERENCE_PATTERN, value):
        raise ValueError(
            f"{field_name} must be a trimmed opaque reference using letters, "
            "numbers, dots, colons, underscores, or hyphens"
        )
    return value


class Utterance(StrictContract):
    sent_at: datetime
    text: str = Field(min_length=1, max_length=_MAX_TEXT_LENGTH)

    @field_validator("sent_at")
    @classmethod
    def validate_sent_at(cls, value: datetime) -> datetime:
        return _require_aware(value, field_name="utterance.sent_at")

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str) -> str:
        if value != value.strip():
            raise ValueError("utterance.text must be trimmed")
        return value


class ChatMessage(StrictContract):
    """One host-chat message, including the valid low-composition empty case."""

    sent_at: datetime
    text: str = Field(max_length=_MAX_TEXT_LENGTH)

    @field_validator("sent_at")
    @classmethod
    def validate_sent_at(cls, value: datetime) -> datetime:
        return _require_aware(value, field_name="message.sent_at")

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str) -> str:
        if value != value.strip():
            raise ValueError("message.text must be trimmed")
        return value


class _EvidenceBase(StrictContract):
    ref: str = Field(pattern=_REFERENCE_PATTERN)
    occurred_at: datetime

    @field_validator("occurred_at")
    @classmethod
    def validate_occurred_at(cls, value: datetime) -> datetime:
        return _require_aware(value, field_name="evidence.occurred_at")


class ChargeEvidence(_EvidenceBase):
    type: Literal["charge"]
    order_ref: str | None = Field(default=None, pattern=_REFERENCE_PATTERN)
    amount: str = Field(min_length=1, max_length=32)
    currency: str = Field(pattern=_CURRENCY_PATTERN)
    status: Literal["captured", "completed", "paid", "posted", "succeeded"]

    @field_validator("amount")
    @classmethod
    def validate_amount(cls, value: str) -> str:
        if value != value.strip():
            raise ValueError("charge amount must be trimmed")
        try:
            parsed = Decimal(value)
        except InvalidOperation as exc:
            raise ValueError("charge amount must be a decimal string") from exc
        if not parsed.is_finite() or parsed <= 0 or parsed.as_tuple().exponent < -2:
            raise ValueError("charge amount must be positive with at most two decimal places")
        return value


class ShipmentEvidence(_EvidenceBase):
    type: Literal["shipment"]
    order_ref: str = Field(pattern=_REFERENCE_PATTERN)
    status: Literal[
        "cancelled",
        "delayed",
        "delivered",
        "in_transit",
        "late",
        "lost",
        "missing",
        "overdue",
        "returned",
        "shipped",
    ]
    expected_delivery_at: datetime | None = None

    @field_validator("expected_delivery_at")
    @classmethod
    def validate_expected_delivery_at(
        cls, value: datetime | None
    ) -> datetime | None:
        if value is None:
            return None
        return _require_aware(value, field_name="expected_delivery_at")


class FulfillmentEvidence(_EvidenceBase):
    type: Literal["fulfillment"]
    order_ref: str = Field(pattern=_REFERENCE_PATTERN)
    ordered_sku: str = Field(pattern=_REFERENCE_PATTERN)
    delivered_sku: str = Field(pattern=_REFERENCE_PATTERN)
    status: Literal["delivered", "incorrect_item", "mismatched", "wrong_item"]


class AccountAccessEvidence(_EvidenceBase):
    type: Literal["account_access"]
    account_ref: str = Field(pattern=_REFERENCE_PATTERN)
    status: Literal["active", "blocked", "locked", "locked_out", "unlocked"]
    failed_attempts: int = Field(ge=0, le=1_000)


Evidence = Annotated[
    ChargeEvidence
    | ShipmentEvidence
    | FulfillmentEvidence
    | AccountAccessEvidence,
    Field(discriminator="type"),
]


class SuggestionRequest(StrictContract):
    schema_version: Literal[1] = 1
    external_event_id: str = Field(pattern=_REFERENCE_PATTERN)
    observed_at: datetime
    channel: Literal["email", "chat", "phone", "form", "web"]
    customer_external_id: str = Field(min_length=1, max_length=512)
    utterance: Utterance
    evidence: tuple[Evidence, ...] = Field(max_length=_MAX_EVIDENCE)
    source_system: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("observed_at")
    @classmethod
    def validate_observed_at(cls, value: datetime) -> datetime:
        return _require_aware(value, field_name="observed_at")

    @field_validator("customer_external_id")
    @classmethod
    def validate_customer_external_id(cls, value: str) -> str:
        if value != value.strip():
            raise ValueError("customer_external_id must be trimmed")
        return value

    @field_validator("metadata")
    @classmethod
    def validate_metadata(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(value) > 50:
            raise ValueError("metadata may contain at most 50 keys")
        if any(
            not isinstance(key, str)
            or not key
            or key != key.strip()
            or len(key) > 64
            for key in value
        ):
            raise ValueError("metadata keys must be trimmed strings of 1–64 characters")
        return value

    @model_validator(mode="after")
    def validate_chronology_and_references(self) -> Self:
        if self.utterance.sent_at > self.observed_at:
            raise ValueError("utterance.sent_at cannot be after observed_at")
        if any(item.occurred_at > self.observed_at for item in self.evidence):
            raise ValueError("evidence cannot occur after observed_at")
        references = [item.ref for item in self.evidence]
        if len(references) != len(set(references)):
            raise ValueError("evidence refs must be unique within a request")
        return self


class ChatAssistRequest(StrictContract):
    """Adapter-neutral input for a host support chatbot.

    ``show_choices`` is an explicit interaction preference, not a diagnosis.
    It is the only mode that accepts an empty message so a customer can ask to
    compose their turn entirely through evidence-backed choices.
    """

    schema_version: Literal[1] = 1
    external_event_id: str = Field(pattern=_REFERENCE_PATTERN)
    observed_at: datetime
    channel: Literal["email", "chat", "phone", "form", "web"]
    customer_external_id: str = Field(min_length=1, max_length=512)
    message: ChatMessage
    assistance_mode: Literal["auto", "show_choices"] = "auto"
    evidence: tuple[Evidence, ...] = Field(max_length=_MAX_EVIDENCE)
    source_system: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
    )
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("observed_at")
    @classmethod
    def validate_observed_at(cls, value: datetime) -> datetime:
        return _require_aware(value, field_name="observed_at")

    @field_validator("customer_external_id")
    @classmethod
    def validate_customer_external_id(cls, value: str) -> str:
        if value != value.strip():
            raise ValueError("customer_external_id must be trimmed")
        return value

    @field_validator("metadata")
    @classmethod
    def validate_metadata(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(value) > 50:
            raise ValueError("metadata may contain at most 50 keys")
        if any(
            not isinstance(key, str)
            or not key
            or key != key.strip()
            or len(key) > 64
            for key in value
        ):
            raise ValueError("metadata keys must be trimmed strings of 1–64 characters")
        return value

    @model_validator(mode="after")
    def validate_message_state_and_references(self) -> Self:
        if not self.message.text and self.assistance_mode != "show_choices":
            raise ValueError("empty message.text requires assistance_mode=show_choices")
        if self.message.sent_at > self.observed_at:
            raise ValueError("message.sent_at cannot be after observed_at")
        if any(item.occurred_at > self.observed_at for item in self.evidence):
            raise ValueError("evidence cannot occur after observed_at")
        references = [item.ref for item in self.evidence]
        if len(references) != len(set(references)):
            raise ValueError("evidence refs must be unique within a request")
        return self


class EvidenceSummary(StrictContract):
    input_index: int = Field(ge=0, lt=_MAX_EVIDENCE)
    ref: str = Field(pattern=_REFERENCE_PATTERN)
    source: str = Field(min_length=1, max_length=64)
    kind: str = Field(min_length=1, max_length=64)
    occurred_at: datetime
    provenance: Literal["exported", "reconstructed", "inferred"]

    @field_validator("occurred_at")
    @classmethod
    def validate_occurred_at(cls, value: datetime) -> datetime:
        return _require_aware(value, field_name="evidence summary occurred_at")


class SuggestionCandidate(StrictContract):
    id: str = Field(pattern=r"^sg_[0-9a-f]{32}:[a-z][a-z0-9_]{1,48}$")
    detector_id: str = Field(pattern=_DETECTOR_PATTERN)
    title: str = Field(min_length=3, max_length=120)
    detail: str = Field(min_length=3, max_length=300)
    rank: int = Field(ge=1, le=3)
    ranking_score: float
    evidence: tuple[EvidenceSummary, ...] = Field(min_length=1, max_length=20)


class SuggestionPolicy(StrictContract):
    detector_set_version: str = Field(pattern=r"^det_[0-9a-f]{16}$")
    threshold_version: str = Field(min_length=1, max_length=64)
    threshold: float
    score_kind: Literal["ranking_not_probability"] = "ranking_not_probability"
    embedding_model_id: str = Field(min_length=1, max_length=256)
    embedding_model_revision: str = Field(min_length=1, max_length=128)


class SuggestionLinks(StrictContract):
    self: str = Field(pattern=r"^/v1/suggestions/sg_[0-9a-f]{32}$")
    events: str = Field(pattern=r"^/v1/suggestions/sg_[0-9a-f]{32}/events$")
    feedback: str = Field(pattern=r"^/v1/suggestions/sg_[0-9a-f]{32}/feedback$")


class SuggestionResponse(StrictContract):
    schema_version: Literal[1] = 1
    suggestion_id: str = Field(pattern=_RUN_PATTERN)
    status: Literal["completed"] = "completed"
    outcome: Literal["candidates", "abstained"]
    abstained: bool
    abstention_reason: Literal[
        "no_evidence_hypotheses",
        "below_confidence_floor",
    ] | None = None
    review_required: Literal[True] = True
    candidates: tuple[SuggestionCandidate, ...] = Field(max_length=3)
    processing_ms: int = Field(ge=0)
    redaction_entity_counts: dict[str, int]
    policy: SuggestionPolicy
    links: SuggestionLinks

    @model_validator(mode="after")
    def validate_outcome(self) -> Self:
        if self.abstained != (not self.candidates):
            raise ValueError("abstained must agree with candidate count")
        if self.outcome == "abstained" and not self.abstained:
            raise ValueError("abstained outcome requires no candidates")
        if self.outcome == "candidates" and self.abstained:
            raise ValueError("candidate outcome requires at least one candidate")
        if self.abstained != (self.abstention_reason is not None):
            raise ValueError("abstention reason must appear exactly when abstaining")
        if [item.rank for item in self.candidates] != list(
            range(1, len(self.candidates) + 1)
        ):
            raise ValueError("candidate ranks must be contiguous from one")
        return self


class ChatIntegrationDirective(StrictContract):
    """Unambiguous middleware instruction for the host chatbot."""

    host_action: Literal["show_wordless", "continue_host_bot"]
    render_mode: Literal["choices", "message", "none"]

    @model_validator(mode="after")
    def validate_directive(self) -> Self:
        if self.host_action == "continue_host_bot" and self.render_mode != "none":
            raise ValueError("continue_host_bot requires render_mode=none")
        if self.host_action == "show_wordless" and self.render_mode == "none":
            raise ValueError("show_wordless requires a visible render mode")
        return self


class ChatChoice(StrictContract):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{1,48}$")
    label: str = Field(min_length=1, max_length=72)
    reply: str = Field(min_length=1, max_length=240)
    detector_id: str | None = Field(default=None, pattern=_DETECTOR_PATTERN)
    evidence: tuple[EvidenceSummary, ...] = Field(max_length=20)

    @model_validator(mode="after")
    def validate_support(self) -> Self:
        if (self.detector_id is None) != (not self.evidence):
            raise ValueError(
                "a detector-backed choice requires evidence; an unbacked choice cannot cite it"
            )
        return self


class ChatAssistResponse(StrictContract):
    """Read-only chat-layer decision consumed by any host integration."""

    schema_version: Literal[1] = 1
    suggestion_id: str = Field(pattern=_RUN_PATTERN)
    status: Literal["completed"] = "completed"
    outcome: Literal[
        "clarification_choices",
        "grounded_reply",
        "clarifying_fallback",
    ]
    integration: ChatIntegrationDirective
    message: str | None = Field(default=None, min_length=1, max_length=500)
    choices: tuple[ChatChoice, ...] = Field(max_length=3)
    detector_id: str | None = Field(default=None, pattern=_DETECTOR_PATTERN)
    evidence: tuple[EvidenceSummary, ...] = Field(max_length=20)
    reason: Literal[
        "no_relevant_evidence",
        "below_confidence_floor",
        "insufficient_context",
    ] | None = None
    selection_basis: Literal[
        "evidence_and_message",
        "explicit_evidence_choices",
        "contextual_evidence_choices",
        "grounded_state",
        "none",
    ]
    review_required: Literal[True] = True
    read_only: Literal[True] = True
    processing_ms: int = Field(ge=0)
    redaction_entity_counts: dict[str, int]
    policy: SuggestionPolicy
    links: SuggestionLinks

    @model_validator(mode="after")
    def validate_outcome_shape(self) -> Self:
        if self.outcome == "clarification_choices":
            if self.integration != ChatIntegrationDirective(
                host_action="show_wordless",
                render_mode="choices",
            ):
                raise ValueError("clarification choices require the choices renderer")
            if self.message is None or len(self.choices) < 2:
                raise ValueError("clarification choices require a prompt and 2–3 choices")
            if self.detector_id is None or not self.evidence or self.reason is not None:
                raise ValueError("clarification choices require one evidence-backed detector")
            if self.selection_basis not in {
                "explicit_evidence_choices",
                "contextual_evidence_choices",
                "evidence_and_message",
            }:
                raise ValueError(
                    "clarification choices require message-ranked, contextual, "
                    "or explicit evidence support"
                )
            supported = [choice for choice in self.choices if choice.detector_id is not None]
            unsupported = [choice for choice in self.choices if choice.detector_id is None]
            if not 1 <= len(supported) <= 2:
                raise ValueError("clarification choices require one or two supported choices")
            if len(unsupported) != 1 or unsupported[0].id != "something_else":
                raise ValueError("clarification choices require one safe alternative")
            if supported[0].detector_id != self.detector_id:
                raise ValueError("the first supported choice must be the primary detector")
            if len({choice.detector_id for choice in supported}) != len(supported):
                raise ValueError("supported clarification choices must be distinct")
            if tuple(supported[0].evidence) != tuple(self.evidence):
                raise ValueError("the primary choice must cite the response evidence")
            return self

        if self.outcome == "grounded_reply":
            if self.integration != ChatIntegrationDirective(
                host_action="show_wordless",
                render_mode="message",
            ):
                raise ValueError("a grounded reply requires the message renderer")
            if self.message is None or self.choices or not self.evidence:
                raise ValueError("a grounded reply requires only a message and evidence")
            if self.reason is not None or self.selection_basis != "grounded_state":
                raise ValueError("a grounded reply cannot have an abstention reason")
            if self.detector_id is not None:
                raise ValueError("a healthy-state grounded reply does not identify a detector")
            return self

        if self.detector_id is not None or self.evidence:
            raise ValueError("a fallback cannot expose an unsupported candidate")
        if self.reason is None or self.selection_basis != "none":
            raise ValueError("a fallback requires an abstention reason")
        if self.integration.host_action == "continue_host_bot":
            if self.message is not None or self.choices:
                raise ValueError("host-bot continuation cannot include a competing reply")
        elif self.integration.render_mode == "choices":
            if self.message is None or not 2 <= len(self.choices) <= 3:
                raise ValueError("a choice fallback requires a prompt and 2–3 choices")
            if any(choice.detector_id is not None or choice.evidence for choice in self.choices):
                raise ValueError("navigation choices cannot claim detector support")
        elif self.integration.render_mode == "message":
            if self.message is None or self.choices:
                raise ValueError("a message fallback cannot also include choices")
        else:
            raise ValueError("a visible fallback requires a message or choices renderer")
        return self


class FeedbackRequest(StrictContract):
    schema_version: Literal[1] = 1
    outcome: Literal["confirmed", "none"]
    selected_detector_id: str | None = Field(
        default=None,
        pattern=_DETECTOR_PATTERN,
    )
    actor: Literal["customer", "agent"]

    @model_validator(mode="after")
    def validate_selection(self) -> Self:
        if self.outcome == "confirmed" and self.selected_detector_id is None:
            raise ValueError("confirmed feedback requires selected_detector_id")
        if self.outcome == "none" and self.selected_detector_id is not None:
            raise ValueError("none feedback cannot select a detector")
        return self


class FeedbackResponse(StrictContract):
    schema_version: Literal[1] = 1
    feedback_id: str = Field(pattern=_FEEDBACK_PATTERN)
    suggestion_id: str = Field(pattern=_RUN_PATTERN)
    recorded: Literal[True] = True
    outcome: Literal["confirmed", "none"]
    selected_detector_id: str | None = Field(
        default=None,
        pattern=_DETECTOR_PATTERN,
    )
    actor: Literal["customer", "agent"]
    recorded_at: datetime

    @field_validator("recorded_at")
    @classmethod
    def validate_recorded_at(cls, value: datetime) -> datetime:
        return _require_aware(value, field_name="recorded_at")


class SuggestionEvent(StrictContract):
    schema_version: Literal[1] = 1
    suggestion_id: str = Field(pattern=_RUN_PATTERN)
    sequence: int = Field(ge=1)
    type: Literal[
        "suggestion.accepted",
        "suggestion.started",
        "suggestion.completed",
        "suggestion.failed",
    ]
    occurred_at: datetime
    elapsed_ms: int = Field(ge=0)
    detail: str = Field(min_length=1, max_length=200)

    @field_validator("occurred_at")
    @classmethod
    def validate_occurred_at(cls, value: datetime) -> datetime:
        return _require_aware(value, field_name="event occurred_at")


__all__ = [
    "AccountAccessEvidence",
    "ChargeEvidence",
    "ChatAssistRequest",
    "ChatAssistResponse",
    "ChatChoice",
    "ChatIntegrationDirective",
    "ChatMessage",
    "Evidence",
    "EvidenceSummary",
    "FeedbackRequest",
    "FeedbackResponse",
    "FulfillmentEvidence",
    "ShipmentEvidence",
    "SuggestionCandidate",
    "SuggestionEvent",
    "SuggestionLinks",
    "SuggestionPolicy",
    "SuggestionRequest",
    "SuggestionResponse",
    "Utterance",
]

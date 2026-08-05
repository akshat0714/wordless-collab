"""Warm, privacy-preserving execution of the real-time suggestion pipeline."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import hmac
import json
from threading import Lock
from time import perf_counter_ns
from typing import Any

import numpy as np
from numpy.typing import NDArray

from wordless.core.embed import SentenceTransformerEmbedder
from wordless.core.models import Interaction, Message, StateFact, hash_customer_key
from wordless.core.redact import RedactionReport, Redactor
from wordless.pipeline.candidates import DEFAULT_DETECTORS
from wordless.pipeline.concepts import (
    CHAT_AUTO_MIN_CONCEPT_SIMILARITY,
    REPAIRED_CONCEPT_MIN_MARGIN,
    REPAIRED_CONCEPT_MIN_SIMILARITY,
    has_low_composition_cue,
    repair_fragment_for_concept,
    should_use_contextual_evidence_choices,
)
from wordless.pipeline.rerank import rerank_hypotheses
from wordless.pipeline.run import PipelineResult, PipelineRunner

from .auth import TenantPrincipal
from .config import ProductSettings
from .contracts import (
    AccountAccessEvidence,
    ChargeEvidence,
    ChatAssistRequest,
    ChatAssistResponse,
    ChatChoice,
    ChatIntegrationDirective,
    EvidenceSummary,
    FulfillmentEvidence,
    ShipmentEvidence,
    SuggestionCandidate,
    SuggestionEvent,
    SuggestionLinks,
    SuggestionPolicy,
    SuggestionRequest,
    SuggestionResponse,
)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _stable_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
        default=str,
    )


def _detector_set_version() -> str:
    payload = [
        item.model_dump(mode="json")
        for item in sorted(DEFAULT_DETECTORS, key=lambda detector: detector.id)
    ]
    digest = hashlib.sha256(_stable_json(payload).encode("utf-8")).hexdigest()
    return f"det_{digest[:16]}"


def _interaction_id(external_event_id: str, key: bytes) -> str:
    digest = hmac.new(key, external_event_id.encode("utf-8"), hashlib.sha256).hexdigest()
    # A raw hexadecimal digest can accidentally contain a Luhn-valid run of
    # digits and be rejected by the mandatory structural-ID PII scan.  Encode
    # each nibble as a letter and retain 240 bits so every generated identifier
    # is opaque, deterministic, within the 64-character structural grammar,
    # and incapable of resembling a phone/card/national-ID number.
    alpha_digest = digest.translate(str.maketrans("0123456789abcdef", "ABCDEFGHIJKLMNOP"))
    return f"EVT-{alpha_digest[:60]}"


def _safe_reference(value: str, *, key: bytes, prefix: str) -> str:
    """Return a stable, non-reversible reference accepted by redaction policy."""

    digest = hmac.new(
        key,
        f"{prefix}:{value}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{prefix}-{digest[:24]}"


def _state_fact(value: object, *, key: bytes) -> StateFact:
    if isinstance(value, ChargeEvidence):
        fields: dict[str, Any] = {
            "charge_id": _safe_reference(value.ref, key=key, prefix="ch"),
            "amount": value.amount,
            "currency": value.currency,
            "status": value.status,
        }
        if value.order_ref is not None:
            fields["order_id"] = _safe_reference(
                value.order_ref,
                key=key,
                prefix="ord",
            )
        return StateFact(
            source="billing",
            kind="charge",
            occurred_at=value.occurred_at,
            fields=fields,
            provenance="exported",
        )
    if isinstance(value, ShipmentEvidence):
        fields = {
            "shipment_id": _safe_reference(value.ref, key=key, prefix="txn"),
            "order_id": _safe_reference(value.order_ref, key=key, prefix="ord"),
            "status": value.status,
        }
        if value.expected_delivery_at is not None:
            fields["expected_delivery_at"] = value.expected_delivery_at
        return StateFact(
            source="shipping",
            kind="shipment",
            occurred_at=value.occurred_at,
            fields=fields,
            provenance="exported",
        )
    if isinstance(value, FulfillmentEvidence):
        return StateFact(
            source="orders",
            kind="fulfillment",
            occurred_at=value.occurred_at,
            fields={
                "fulfillment_id": _safe_reference(
                    value.ref,
                    key=key,
                    prefix="txn",
                ),
                "order_id": _safe_reference(
                    value.order_ref,
                    key=key,
                    prefix="ord",
                ),
                "ordered_sku": _safe_reference(
                    value.ordered_sku,
                    key=key,
                    prefix="sku",
                ),
                "delivered_sku": _safe_reference(
                    value.delivered_sku,
                    key=key,
                    prefix="sku",
                ),
                "status": value.status,
            },
            provenance="exported",
        )
    if isinstance(value, AccountAccessEvidence):
        return StateFact(
            source="authentication",
            kind="account",
            occurred_at=value.occurred_at,
            fields={
                "event_id": _safe_reference(value.ref, key=key, prefix="case"),
                "account_id": _safe_reference(
                    value.account_ref,
                    key=key,
                    prefix="case",
                ),
                "status": value.status,
                "locked": value.status in {"blocked", "locked", "locked_out"},
                "failed_attempts": value.failed_attempts,
            },
            provenance="exported",
        )
    raise TypeError("unsupported evidence type")


class _EphemeralEmbeddingAdapter:
    """Ensure request text never enters a persistent embedding cache."""

    def __init__(self, embedder: Any) -> None:
        method = getattr(embedder, "encode_ephemeral", None)
        if not callable(method):
            raise TypeError(
                "real-time embedding requires callable encode_ephemeral(texts); "
                "persistent encode(texts) is forbidden for request content"
            )
        self._encode_ephemeral = method

    def encode(self, texts: Sequence[str]) -> NDArray[np.float32]:
        raw = self._encode_ephemeral(texts)
        return np.asarray(raw, dtype=np.float32)


@dataclass(frozen=True)
class RuntimeEvaluation:
    interaction: Interaction
    response: SuggestionResponse
    events: tuple[SuggestionEvent, ...]
    redaction_report: RedactionReport


@dataclass(frozen=True)
class ChatRuntimeEvaluation:
    """The durable suggestion evaluation plus its host-chat presentation."""

    runtime: RuntimeEvaluation
    response: ChatAssistResponse


_CHAT_COPY: dict[str, tuple[str, str, str]] = {
    "duplicate_charge": (
        "I found two matching completed charges. Is that what you need help with?",
        "Charged twice",
        "I was charged twice for the same order.",
    ),
    "late_delivery": (
        "I found a delivery marked late or overdue. Is that what you need help with?",
        "Delivery is late",
        "My delivery is late.",
    ),
    "wrong_item": (
        "I found that the delivered item does not match the ordered item. Is that the problem?",
        "Wrong item",
        "I received the wrong item.",
    ),
    "account_lock": (
        "I found that the account is locked. Is that what you need help with?",
        "Account is locked",
        "I cannot get into my account.",
    ),
}

_DETECTOR_BY_ID = {detector.id: detector for detector in DEFAULT_DETECTORS}

_PAYMENT_TERMS = (
    "bill",
    "card",
    "charge",
    "money",
    "paid",
    "payment",
    "refund",
)
_DELIVERY_TERMS = (
    "arrive",
    "delivery",
    "package",
    "shipment",
    "shipping",
    "tracking",
)
_ITEM_TERMS = ("item", "product", "received")
_ACCOUNT_TERMS = (
    "account",
    "access",
    "log in",
    "login",
    "password",
    "sign in",
)


def _mentions(text: str, terms: tuple[str, ...]) -> bool:
    normalized = " ".join(text.casefold().split())
    return any(term in normalized for term in terms)


class ProductRuntime:
    """One warmed model, one detector set, and a serialized inference boundary."""

    def __init__(
        self,
        *,
        embedder: Any,
        model_id: str,
        model_revision: str,
        threshold: float,
        threshold_version: str,
        redactor: Redactor | None = None,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        if redactor is not None and type(redactor) is not Redactor:
            raise TypeError("redactor must be a concrete Redactor instance")
        self.redactor = redactor or Redactor(cache_results=False)
        if not self.redactor.boundary_safe or self.redactor.cache_results:
            raise ValueError(
                "real-time runtime requires mandatory redaction with result caching disabled"
            )
        self.model_id = model_id
        self.model_revision = model_revision
        self.threshold = threshold
        self.threshold_version = threshold_version
        self.clock = clock
        self._inference_lock = Lock()
        self.pipeline = PipelineRunner(
            embedder=_EphemeralEmbeddingAdapter(embedder),
            threshold=threshold,
            redactor=self.redactor,
        )
        self.detector_set_version = _detector_set_version()

    @classmethod
    def from_settings(cls, settings: ProductSettings) -> "ProductRuntime":
        embedder = SentenceTransformerEmbedder(
            model_id=settings.embedding_model_id,
            revision=settings.embedding_model_revision,
            cache_dir=settings.model_cache_dir,
            offline=settings.offline,
            batch_size=settings.embedding_batch_size,
            seed=settings.seed,
            device="cpu",
        )
        embedder.validate_model_available()
        return cls(
            embedder=embedder,
            model_id=settings.embedding_model_id,
            model_revision=settings.embedding_model_revision,
            threshold=settings.threshold,
            threshold_version=settings.threshold_version,
        )

    def _canonicalize(
        self,
        principal: TenantPrincipal,
        request: SuggestionRequest | ChatAssistRequest,
    ) -> tuple[Interaction, RedactionReport]:
        utterance = request.utterance if isinstance(request, SuggestionRequest) else request.message
        raw = Interaction(
            id=_interaction_id(request.external_event_id, principal.customer_hmac_key),
            customer_key=hash_customer_key(
                request.customer_external_id,
                principal.customer_hmac_key,
            ),
            opened_at=request.observed_at,
            channel=request.channel,
            messages=[
                Message(
                    author="customer",
                    sent_at=utterance.sent_at,
                    text=utterance.text,
                    redacted=False,
                )
            ],
            state_snapshot=[
                _state_fact(item, key=principal.customer_hmac_key)
                for item in request.evidence
            ],
            resolution=None,
            source_system=request.source_system,
            metadata=request.metadata,
        )
        sanitized, report = self.redactor.redact_interaction(raw)
        canonical = Interaction.model_validate(
            sanitized.model_dump(mode="python", round_trip=True)
        )
        if any(not message.redacted for message in canonical.messages):
            raise RuntimeError("redaction boundary did not mark every message")
        return canonical, report

    @staticmethod
    def _evidence_summary(
        fact: StateFact,
        *,
        key: bytes,
        input_index: int,
    ) -> EvidenceSummary:
        digest = hmac.new(
            key,
            _stable_json(fact.model_dump(mode="json")).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return EvidenceSummary(
            input_index=input_index,
            ref=f"ev_{digest[:24]}",
            source=fact.source,
            kind=fact.kind,
            occurred_at=fact.occurred_at,
            provenance=fact.provenance,
        )

    def _response(
        self,
        *,
        principal: TenantPrincipal,
        suggestion_id: str,
        interaction: Interaction,
        result: PipelineResult,
        report: RedactionReport,
        processing_ms: int,
    ) -> SuggestionResponse:
        fact_keys = tuple(
            _stable_json(fact.model_dump(mode="json"))
            for fact in interaction.state_snapshot
        )
        input_indices = {key: index for index, key in enumerate(fact_keys)}
        if len(input_indices) != len(fact_keys):
            raise RuntimeError("request evidence did not retain a unique canonical mapping")

        def summarize(fact: StateFact) -> EvidenceSummary:
            try:
                input_index = input_indices[
                    _stable_json(fact.model_dump(mode="json"))
                ]
            except KeyError as exc:
                raise RuntimeError(
                    "candidate evidence did not map to request evidence"
                ) from exc
            return self._evidence_summary(
                fact,
                key=principal.customer_hmac_key,
                input_index=input_index,
            )

        candidates = tuple(
            SuggestionCandidate(
                id=f"{suggestion_id}:{candidate.detector_id}",
                detector_id=candidate.detector_id,
                title=candidate.title,
                detail=candidate.detail,
                rank=candidate.rank,
                ranking_score=candidate.score,
                evidence=tuple(
                    summarize(fact)
                    for fact in candidate.evidence
                ),
            )
            for candidate in result.candidates
        )
        base = f"/v1/suggestions/{suggestion_id}"
        return SuggestionResponse(
            suggestion_id=suggestion_id,
            outcome="abstained" if result.abstained else "candidates",
            abstained=result.abstained,
            abstention_reason=result.abstention_reason,
            candidates=candidates,
            processing_ms=processing_ms,
            redaction_entity_counts=dict(sorted(report.entity_counts.items())),
            policy=SuggestionPolicy(
                detector_set_version=self.detector_set_version,
                threshold_version=self.threshold_version,
                threshold=self.threshold,
                embedding_model_id=self.model_id,
                embedding_model_revision=self.model_revision,
            ),
            links=SuggestionLinks(
                self=base,
                events=f"{base}/events",
                feedback=f"{base}/feedback",
            ),
        )

    def evaluate(
        self,
        *,
        principal: TenantPrincipal,
        request: SuggestionRequest | ChatAssistRequest,
        suggestion_id: str,
        evidence_only_choices: bool = False,
    ) -> RuntimeEvaluation:
        started_ns = perf_counter_ns()
        accepted_at = self.clock()
        interaction, report = self._canonicalize(principal, request)
        canonicalized_ms = max(0, (perf_counter_ns() - started_ns) // 1_000_000)
        with self._inference_lock:
            inference_started_at = self.clock()
            result = self.pipeline.run(interaction)
            contextual_evidence_choices = False
            strong_repaired_message = False
            if (
                isinstance(request, ChatAssistRequest)
                and request.assistance_mode == "auto"
                and result.ranked_candidates
            ):
                primary = result.ranked_candidates[0]
                hypothesis = next(
                    (
                        value
                        for value in result.hypotheses
                        if value.detector_id == primary.detector_id
                    ),
                    None,
                )
                # The mandatory NER boundary can conservatively replace pure
                # noise (for example ``asdf qqq``) with ``<PERSON>``. Inspect
                # only character shape on the in-memory request so that a
                # false-positive redaction cannot disable the compassionate
                # fallback; raw text still never reaches the embedder.
                routing_fragment = request.message.text
                if hypothesis is not None:
                    if has_low_composition_cue(routing_fragment, hypothesis):
                        contextual_evidence_choices = (
                            not result.abstained
                            or should_use_contextual_evidence_choices(
                                routing_fragment,
                                hypothesis,
                                concept_similarity=primary.cosine_similarity,
                            )
                        )
                    else:
                        repair = repair_fragment_for_concept(
                            routing_fragment,
                            hypothesis,
                        )
                        next_similarity = max(
                            (
                                candidate.cosine_similarity
                                for candidate in result.ranked_candidates[1:]
                            ),
                            default=-1.0,
                        )
                        strong_repaired_message = (
                            repair.changed_tokens > 0
                            and primary.cosine_similarity
                            >= REPAIRED_CONCEPT_MIN_SIMILARITY
                            and primary.cosine_similarity - next_similarity
                            >= REPAIRED_CONCEPT_MIN_MARGIN
                        )

            if (
                (evidence_only_choices or contextual_evidence_choices)
                and result.hypotheses
            ):
                evidence_ranked = rerank_hypotheses(
                    "",
                    result.hypotheses,
                    embedder=self.pipeline.embedder,
                    as_of=interaction.opened_at,
                    redactor=self.redactor,
                )
                result = PipelineResult.model_validate(
                    {
                        **result.model_dump(mode="python"),
                        "ranked_candidates": evidence_ranked,
                        "candidates": evidence_ranked[:2],
                        "abstained": not evidence_ranked,
                        "abstention_reason": (
                            None if evidence_ranked else result.abstention_reason
                        ),
                    }
                )
            elif (
                isinstance(request, ChatAssistRequest)
                and request.assistance_mode == "auto"
            ):
                # Max-over-prototype similarity has a different score
                # distribution from the older concatenated representation.
                # Apply an explicit semantic support floor before exposing an
                # adverse chat intent; the tenant's total-score threshold alone
                # is not sufficient for clear but unrelated messages.
                supported = [
                    candidate
                    for candidate in result.candidates
                    if candidate.cosine_similarity
                    >= CHAT_AUTO_MIN_CONCEPT_SIMILARITY
                ]
                if strong_repaired_message:
                    primary = result.ranked_candidates[0]
                    supported = [
                        primary,
                        *(
                            candidate
                            for candidate in supported
                            if candidate.detector_id != primary.detector_id
                        ),
                    ]
                selected = tuple(
                    candidate.model_copy(update={"rank": rank})
                    for rank, candidate in enumerate(supported[:2], start=1)
                )
                result = PipelineResult.model_validate(
                    {
                        **result.model_dump(mode="python"),
                        "candidates": selected,
                        "abstained": not selected,
                        "abstention_reason": (
                            None
                            if selected
                            else result.abstention_reason
                            or "below_confidence_floor"
                        ),
                    }
                )
            elif isinstance(request, ChatAssistRequest) and len(result.candidates) > 2:
                # Explicit choice mode is already capped above, but keep this
                # defensive branch for future assistance modes.
                result = PipelineResult.model_validate(
                    {
                        **result.model_dump(mode="python"),
                        "candidates": result.candidates[:2],
                    }
                )
            inference_completed_at = self.clock()
        completed_ms = max(0, (perf_counter_ns() - started_ns) // 1_000_000)
        response = self._response(
            principal=principal,
            suggestion_id=suggestion_id,
            interaction=interaction,
            result=result,
            report=report,
            processing_ms=completed_ms,
        )
        events = (
            SuggestionEvent(
                suggestion_id=suggestion_id,
                sequence=1,
                type="suggestion.accepted",
                occurred_at=accepted_at,
                elapsed_ms=0,
                detail="Authenticated request accepted for evidence evaluation.",
            ),
            SuggestionEvent(
                suggestion_id=suggestion_id,
                sequence=2,
                type="suggestion.started",
                occurred_at=inference_started_at,
                elapsed_ms=canonicalized_ms,
                detail="Canonical redaction completed; confirmed detectors started.",
            ),
            SuggestionEvent(
                suggestion_id=suggestion_id,
                sequence=3,
                type="suggestion.completed",
                occurred_at=inference_completed_at,
                elapsed_ms=completed_ms,
                detail=(
                    "Evaluation abstained without a supported candidate."
                    if response.abstained
                    else (
                        "Evaluation produced "
                        f"{len(response.candidates)} review-required candidate(s) "
                        "using contextual evidence-only ranking."
                    )
                    if contextual_evidence_choices
                    else (
                        "Evaluation produced "
                        f"{len(response.candidates)} review-required candidate(s) "
                        "using explicit evidence-only ranking."
                    )
                    if evidence_only_choices
                    else (
                        "Evaluation produced "
                        f"{len(response.candidates)} review-required candidate(s) "
                        "using detector-local repaired message ranking."
                    )
                    if strong_repaired_message
                    else (
                        "Evaluation produced "
                        f"{len(response.candidates)} review-required candidate(s)."
                    )
                ),
            ),
        )
        return RuntimeEvaluation(
            interaction=interaction,
            response=response,
            events=events,
            redaction_report=report,
        )

    @staticmethod
    def _known_grounded_reply(
        request: ChatAssistRequest,
    ) -> tuple[str, int] | None:
        """Return only replies that are directly entailed by supplied state."""

        text = request.message.text
        indexed = sorted(
            enumerate(request.evidence),
            key=lambda item: (item[1].occurred_at, item[0]),
            reverse=True,
        )
        successful_charges = [
            (index, evidence)
            for index, evidence in indexed
            if isinstance(evidence, ChargeEvidence)
        ]
        if len(successful_charges) == 1 and _mentions(text, _PAYMENT_TERMS):
            index, charge = successful_charges[0]
            return (
                f"I found one completed {charge.amount} {charge.currency} charge in the supplied records.",
                index,
            )

        if _mentions(text, _DELIVERY_TERMS):
            for index, evidence in indexed:
                if not isinstance(evidence, ShipmentEvidence):
                    continue
                if evidence.status == "delivered":
                    return (
                        "The latest supplied shipment record says the order was delivered "
                        f"on {evidence.occurred_at.date().isoformat()}.",
                        index,
                    )
                if evidence.status in {"in_transit", "shipped"}:
                    if evidence.expected_delivery_at is None:
                        return (
                            "The latest supplied shipment record says the order is in transit.",
                            index,
                        )
                    return (
                        "The latest supplied shipment record says the order is in transit "
                        f"with an expected delivery date of "
                        f"{evidence.expected_delivery_at.date().isoformat()}.",
                        index,
                    )

        if _mentions(text, _ITEM_TERMS):
            for index, evidence in indexed:
                if (
                    isinstance(evidence, FulfillmentEvidence)
                    and evidence.status == "delivered"
                    and evidence.ordered_sku == evidence.delivered_sku
                ):
                    return (
                        "The supplied order record shows that the expected item was delivered.",
                        index,
                    )

        if _mentions(text, _ACCOUNT_TERMS):
            for index, evidence in indexed:
                if (
                    isinstance(evidence, AccountAccessEvidence)
                    and evidence.status in {"active", "unlocked"}
                ):
                    return (
                        "The latest supplied account record says access is active.",
                        index,
                    )
        return None

    def compose_chat_response(
        self,
        *,
        principal: TenantPrincipal,
        request: ChatAssistRequest,
        suggestion: SuggestionResponse,
        interaction: Interaction | None = None,
    ) -> ChatAssistResponse:
        """Translate a detector result into a host-chat rendering directive."""

        canonical = interaction
        if canonical is None:
            canonical, _ = self._canonicalize(principal, request)

        if suggestion.candidates:
            candidates = suggestion.candidates[:2]
            backed_choices: list[ChatChoice] = []
            for candidate in candidates:
                try:
                    _candidate_prompt, label, reply = _CHAT_COPY[
                        candidate.detector_id
                    ]
                except KeyError as exc:
                    raise RuntimeError(
                        "chat copy is missing for a confirmed detector"
                    ) from exc
                backed_choices.append(
                    ChatChoice(
                        id=f"confirm_{candidate.detector_id}",
                        label=label,
                        reply=reply,
                        detector_id=candidate.detector_id,
                        evidence=candidate.evidence,
                    )
                )
            primary = candidates[0]
            primary_prompt = _CHAT_COPY[primary.detector_id][0]
            contextual_basis = (
                request.assistance_mode == "auto"
                and any(
                    detector is not None
                    and has_low_composition_cue(request.message.text, detector)
                    for detector in (
                        _DETECTOR_BY_ID.get(candidate.detector_id)
                        for candidate in candidates
                    )
                )
            )
            repaired_message = (
                request.assistance_mode == "auto"
                and not contextual_basis
                and any(
                    detector is not None
                    and repair_fragment_for_concept(
                        request.message.text,
                        detector,
                    ).changed_tokens
                    > 0
                    for detector in (
                        _DETECTOR_BY_ID.get(candidate.detector_id)
                        for candidate in candidates
                    )
                )
            )
            if contextual_basis:
                prompt = (
                    "You don’t need the exact words. Do either of these match "
                    "what you need?"
                    if len(candidates) == 2
                    else "You don’t need the exact words. Does this match what you need?"
                )
                selection_basis = "contextual_evidence_choices"
            elif request.assistance_mode == "show_choices":
                prompt = "You don’t need the exact words. Choose what fits best."
                selection_basis = "explicit_evidence_choices"
            elif repaired_message:
                prompt = (
                    "You don’t need the exact words. Do either of these match "
                    "what you need?"
                    if len(candidates) == 2
                    else "You don’t need the exact words. Does this match what you need?"
                )
                selection_basis = "evidence_and_message"
            elif len(candidates) == 2:
                prompt = "Do either of these match what you need?"
                selection_basis = "evidence_and_message"
            else:
                prompt = primary_prompt
                selection_basis = "evidence_and_message"

            choices = (
                *backed_choices,
                ChatChoice(
                    id="something_else",
                    label="Something else",
                    reply="I need help with something else.",
                    detector_id=None,
                    evidence=(),
                ),
            )
            return ChatAssistResponse(
                suggestion_id=suggestion.suggestion_id,
                outcome="clarification_choices",
                integration=ChatIntegrationDirective(
                    host_action="show_wordless",
                    render_mode="choices",
                ),
                message=prompt,
                choices=choices,
                detector_id=primary.detector_id,
                evidence=primary.evidence,
                reason=None,
                selection_basis=selection_basis,
                processing_ms=suggestion.processing_ms,
                redaction_entity_counts=suggestion.redaction_entity_counts,
                policy=suggestion.policy,
                links=suggestion.links,
            )

        known = self._known_grounded_reply(request)
        if known is not None:
            message, input_index = known
            fact = canonical.state_snapshot[input_index]
            summary = self._evidence_summary(
                fact,
                key=principal.customer_hmac_key,
                input_index=input_index,
            )
            return ChatAssistResponse(
                suggestion_id=suggestion.suggestion_id,
                outcome="grounded_reply",
                integration=ChatIntegrationDirective(
                    host_action="show_wordless",
                    render_mode="message",
                ),
                message=message,
                choices=(),
                detector_id=None,
                evidence=(summary,),
                reason=None,
                selection_basis="grounded_state",
                processing_ms=suggestion.processing_ms,
                redaction_entity_counts=suggestion.redaction_entity_counts,
                policy=suggestion.policy,
                links=suggestion.links,
            )

        reason = (
            "below_confidence_floor"
            if suggestion.abstention_reason == "below_confidence_floor"
            else "insufficient_context"
            if not request.evidence
            else "no_relevant_evidence"
        )
        show_fallback = request.assistance_mode == "show_choices"
        navigation_choices = (
            ChatChoice(
                id="payment_help",
                label="Payment",
                reply="I need help with a payment.",
                detector_id=None,
                evidence=(),
            ),
            ChatChoice(
                id="delivery_or_item",
                label="Delivery or item",
                reply="I need help with a delivery or item.",
                detector_id=None,
                evidence=(),
            ),
            ChatChoice(
                id="account_access",
                label="Sign-in or account",
                reply="I need help signing in to my account.",
                detector_id=None,
                evidence=(),
            ),
        )
        return ChatAssistResponse(
            suggestion_id=suggestion.suggestion_id,
            outcome="clarifying_fallback",
            integration=ChatIntegrationDirective(
                host_action="show_wordless" if show_fallback else "continue_host_bot",
                render_mode="choices" if show_fallback else "none",
            ),
            message=(
                "Choose what you need help with."
                if show_fallback
                else None
            ),
            choices=navigation_choices if show_fallback else (),
            detector_id=None,
            evidence=(),
            reason=reason,
            selection_basis="none",
            processing_ms=suggestion.processing_ms,
            redaction_entity_counts=suggestion.redaction_entity_counts,
            policy=suggestion.policy,
            links=suggestion.links,
        )

    def evaluate_chat(
        self,
        *,
        principal: TenantPrincipal,
        request: ChatAssistRequest,
        suggestion_id: str,
    ) -> ChatRuntimeEvaluation:
        """Evaluate one host message without performing any customer-system action."""

        runtime = self.evaluate(
            principal=principal,
            request=request,
            suggestion_id=suggestion_id,
            evidence_only_choices=request.assistance_mode == "show_choices",
        )
        response = self.compose_chat_response(
            principal=principal,
            request=request,
            suggestion=runtime.response,
            interaction=runtime.interaction,
        )
        return ChatRuntimeEvaluation(runtime=runtime, response=response)


__all__ = ["ChatRuntimeEvaluation", "ProductRuntime", "RuntimeEvaluation"]

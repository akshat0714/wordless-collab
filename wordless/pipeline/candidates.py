"""Evidence-first candidate generation from human-confirmed detectors.

The detectors in this module deliberately inspect only ``StateFact`` records.
Customer prose is not an input to candidate generation; it is used later as a
tie-breaker by :mod:`wordless.pipeline.rerank`.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from wordless.core.models import Interaction, StateFact


DetectorKind = Literal[
    "duplicate_charge",
    "late_delivery",
    "wrong_item",
    "account_lock",
]


class Detector(BaseModel):
    """A reviewable detector definition.

    ``confirmed`` is intentionally explicit.  The evaluator silently ignores
    unconfirmed definitions, making it impossible for a proposed rule to run
    merely because it was loaded alongside approved rules.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    kind: DetectorKind
    title: str
    base_score: float = Field(ge=0.0, le=1.0)
    variants: tuple[str, ...] = ()
    confirmed: bool = False
    derivation_proposal_id: str | None = Field(
        default=None,
        pattern=r"^[a-z][a-z0-9_]{1,48}$",
    )

    @field_validator("id", "title")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        if not value or value != value.strip():
            raise ValueError("detector identifiers and titles must be trimmed and non-empty")
        return value

    @field_validator("variants")
    @classmethod
    def validate_variants(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if any(not value or value != value.strip() for value in values):
            raise ValueError("detector variants must be trimmed and non-empty")
        if len(set(values)) != len(values):
            raise ValueError("detector variants must be unique")
        return values

    @model_validator(mode="after")
    def validate_derivation_provenance(self) -> "Detector":
        if self.derivation_proposal_id is not None and not self.confirmed:
            raise ValueError("a derived runtime detector must be confirmed")
        return self


class Hypothesis(BaseModel):
    """A detector match with the concrete facts that caused it to fire."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    detector_id: str
    title: str
    detail: str
    evidence: tuple[StateFact, ...]
    base_score: float = Field(ge=0.0, le=1.0)
    variants: tuple[str, ...] = ()
    derivation_proposal_id: str | None = Field(
        default=None,
        pattern=r"^[a-z][a-z0-9_]{1,48}$",
    )

    @model_validator(mode="after")
    def require_evidence(self) -> "Hypothesis":
        if not self.evidence:
            raise ValueError("a hypothesis must cite at least one state fact")
        return self

    @property
    def most_recent_evidence_at(self) -> datetime:
        return max(fact.occurred_at for fact in self.evidence)

    @property
    def embedding_text(self) -> str:
        values = (self.title, *self.variants)
        return ". ".join(value.rstrip(". ") for value in values if value).strip() + "."


DEFAULT_DETECTORS: tuple[Detector, ...] = (
    Detector(
        id="duplicate_charge",
        kind="duplicate_charge",
        title="You were charged twice",
        base_score=0.90,
        variants=("money taken twice", "paid two times", "duplicate card charge"),
        confirmed=True,
    ),
    Detector(
        id="late_delivery",
        kind="late_delivery",
        title="Your delivery is late",
        base_score=0.85,
        variants=("still not come", "order has not arrived", "package overdue"),
        confirmed=True,
    ),
    Detector(
        id="wrong_item",
        kind="wrong_item",
        title="You received the wrong item",
        base_score=0.90,
        variants=("order wrong thing", "different product arrived", "not what I ordered"),
        confirmed=True,
    ),
    Detector(
        id="account_lock",
        kind="account_lock",
        title="Your account is locked",
        base_score=0.90,
        variants=("cannot get in", "login blocked", "too many attempts"),
        confirmed=True,
    ),
)


_SUCCESS_STATUSES = {"captured", "complete", "completed", "paid", "posted", "succeeded", "successful"}
_CLOSED_DELIVERY_STATUSES = {"cancelled", "canceled", "delivered", "returned"}
_LATE_DELIVERY_STATUSES = {"delayed", "late", "lost", "missing", "overdue"}
_LOCKED_STATUSES = {"blocked", "locked", "locked_out", "lockout"}
_MONEY_RE = re.compile(r"[^0-9+\-.]")


def _normalized_token(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip().casefold().replace("-", "_").replace(" ", "_")


def _field(fact: StateFact, *names: str) -> Any:
    for name in names:
        if name in fact.fields and fact.fields[name] is not None:
            return fact.fields[name]
    return None


def _fact_sort_key(fact: StateFact) -> tuple[str, str, str, str, str]:
    fields = json.dumps(
        fact.fields,
        default=str,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return (
        fact.occurred_at.isoformat(),
        fact.source.casefold(),
        fact.kind.casefold(),
        fact.provenance,
        fields,
    )


def _ordered_facts(facts: Iterable[StateFact]) -> tuple[StateFact, ...]:
    return tuple(sorted(facts, key=_fact_sort_key))


def _parse_decimal(value: Any) -> Decimal | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, Decimal):
        return value
    cleaned = _MONEY_RE.sub("", str(value).strip()).replace(",", "")
    if not cleaned:
        return None
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        return None


def _format_money(amount: Decimal, currency: str) -> str:
    quantized = amount.quantize(Decimal("0.01"))
    if currency in {"", "USD"}:
        return f"${quantized:,.2f}"
    return f"{quantized:,.2f} {currency}"


def _parse_datetime(value: Any, *, relative_to: datetime) -> datetime | None:
    parsed: datetime
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime.combine(value, datetime.min.time())
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            try:
                parsed = datetime.combine(date.fromisoformat(text), datetime.min.time())
            except ValueError:
                return None
    else:
        return None
    if parsed.tzinfo is None and relative_to.tzinfo is not None:
        parsed = parsed.replace(tzinfo=relative_to.tzinfo)
    elif parsed.tzinfo is not None and relative_to.tzinfo is None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _record_id(fact: StateFact) -> str:
    return str(_field(fact, "charge_id", "transaction_id", "order_id", "id") or "").strip()


def _entity_id(fact: StateFact, *names: str) -> str:
    return str(_field(fact, *names) or "").strip()


def _latest_by_entity(
    facts: Iterable[StateFact],
    *reference_names: str,
) -> tuple[StateFact, ...]:
    latest: dict[str, StateFact] = {}
    for fact in facts:
        reference = _entity_id(fact, *reference_names) or "__anonymous__"
        current = latest.get(reference)
        if current is None or _fact_sort_key(fact) > _fact_sort_key(current):
            latest[reference] = fact
    return tuple(sorted(latest.values(), key=_fact_sort_key, reverse=True))


def _duplicate_charge(
    detector: Detector,
    facts: Sequence[StateFact],
    _as_of: datetime,
) -> Hypothesis | None:
    charges: list[tuple[StateFact, Decimal, str, str, str]] = []
    for fact in facts:
        if _normalized_token(fact.kind) not in {"charge", "payment", "transaction"}:
            continue
        status = _normalized_token(_field(fact, "status", "payment_status"))
        amount = _parse_decimal(_field(fact, "amount", "total", "value"))
        if amount is None:
            continue
        currency = str(_field(fact, "currency", "currency_code") or "USD").strip().upper()
        count = _as_int(_field(fact, "count", "charge_count", "occurrences"))
        # Rung-2 reconstruction may represent an agent's explicit observation
        # ("I can see two charges") as one aggregate fact.
        if count is not None and count >= 2 and status in _SUCCESS_STATUSES:
            amount_text = _format_money(amount, currency)
            return Hypothesis(
                detector_id=detector.id,
                title=detector.title,
                detail=f"Two successful {amount_text} charges were recorded within one hour.",
                evidence=(fact,),
                base_score=detector.base_score,
                variants=detector.variants,
                derivation_proposal_id=detector.derivation_proposal_id,
            )
        # An aggregate count with no successful status is insufficient.  In
        # particular, rung-2 conversation extraction may observe "two
        # declined charges" or merely "two charges"; neither supports a
        # successful-duplicate claim.
        if count is not None:
            continue
        if status not in _SUCCESS_STATUSES:
            continue
        order_id = _entity_id(fact, "order_id", "invoice_id", "purchase_id")
        charges.append((fact, amount, currency, _record_id(fact), order_id))

    ordered = sorted(charges, key=lambda item: _fact_sort_key(item[0]))
    for left_index, left in enumerate(ordered):
        for right in ordered[left_index + 1 :]:
            if (left[1], left[2]) != (right[1], right[2]):
                continue
            if left[3] and right[3] and left[3] == right[3]:
                continue
            if left[4] or right[4]:
                if not left[4] or not right[4] or left[4] != right[4]:
                    continue
            try:
                seconds = abs((right[0].occurred_at - left[0].occurred_at).total_seconds())
            except TypeError:
                continue
            if seconds > 3600:
                continue
            amount = _format_money(left[1], left[2])
            order_context = f" for order {left[4]}" if left[4] else ""
            return Hypothesis(
                detector_id=detector.id,
                title=detector.title,
                detail=(
                    f"Two successful {amount} charges were recorded{order_context} "
                    "within one hour."
                ),
                evidence=(left[0], right[0]),
                base_score=detector.base_score,
                variants=detector.variants,
                derivation_proposal_id=detector.derivation_proposal_id,
            )
    return None


def _late_delivery(
    detector: Detector,
    facts: Sequence[StateFact],
    as_of: datetime,
) -> Hypothesis | None:
    relevant = tuple(
        fact
        for fact in facts
        if _normalized_token(fact.kind) in {"delivery", "order", "shipment"}
        or _normalized_token(fact.source) in {"delivery", "orders", "shipping"}
    )
    for fact in _latest_by_entity(
        relevant,
        "shipment_id",
        "delivery_id",
        "order_id",
        "id",
    ):
        kind = _normalized_token(fact.kind)
        source = _normalized_token(fact.source)
        if kind not in {"delivery", "order", "shipment"} and source not in {"delivery", "orders", "shipping"}:
            continue
        status = _normalized_token(_field(fact, "delivery_status", "shipment_status", "status"))
        if status in _CLOSED_DELIVERY_STATUSES:
            continue
        due_value = _field(
            fact,
            "expected_delivery_at",
            "promised_delivery_at",
            "delivery_due_at",
            "due_at",
            "expected_at",
        )
        due_at = _parse_datetime(due_value, relative_to=as_of)
        explicitly_late = status in _LATE_DELIVERY_STATUSES
        if not explicitly_late and (due_at is None or due_at >= as_of):
            continue
        order_id = _record_id(fact)
        subject = f"Order {order_id}" if order_id else "The order"
        if due_at is not None:
            detail = f"{subject} was due {due_at.date().isoformat()} and was not delivered."
        else:
            detail = (
                f"{subject} was marked {status.replace('_', ' ')} and not delivered "
                f"by {as_of.date().isoformat()}."
            )
        return Hypothesis(
            detector_id=detector.id,
            title=detector.title,
            detail=detail,
            evidence=(fact,),
            base_score=detector.base_score,
            variants=detector.variants,
            derivation_proposal_id=detector.derivation_proposal_id,
        )
    return None


_ITEM_PAIRS: tuple[tuple[str, str], ...] = (
    ("ordered_sku", "delivered_sku"),
    ("expected_sku", "received_sku"),
    ("ordered_item", "delivered_item"),
    ("expected_item", "received_item"),
    ("ordered_product", "received_product"),
)


def _wrong_item(
    detector: Detector,
    facts: Sequence[StateFact],
    _as_of: datetime,
) -> Hypothesis | None:
    relevant = tuple(
        fact
        for fact in facts
        if _normalized_token(fact.kind) in {"fulfillment", "order", "wrong_item"}
        or any(
            _field(fact, expected_name, received_name) is not None
            for expected_name, received_name in _ITEM_PAIRS
        )
    )
    for fact in _latest_by_entity(
        relevant,
        "fulfillment_id",
        "shipment_id",
        "order_id",
        "id",
    ):
        status = _normalized_token(_field(fact, "fulfillment_status", "delivery_status", "status"))
        mismatch: tuple[str, str] | None = None
        for expected_name, received_name in _ITEM_PAIRS:
            expected = _field(fact, expected_name)
            received = _field(fact, received_name)
            if expected is None or received is None:
                continue
            if _normalized_token(expected) != _normalized_token(received):
                mismatch = (str(expected).strip(), str(received).strip())
                break
        explicit = _normalized_token(fact.kind) == "wrong_item" or status in {
            "incorrect_item",
            "mismatched",
            "wrong_item",
        }
        if mismatch is None and not explicit:
            continue
        order_id = _record_id(fact)
        subject = f"Order {order_id}" if order_id else "The order"
        if mismatch is None:
            detail = (
                f"{subject} was recorded as containing the wrong item on "
                f"{fact.occurred_at.date().isoformat()}."
            )
        else:
            detail = f"{subject} lists {mismatch[0]} ordered and {mismatch[1]} received."
        return Hypothesis(
            detector_id=detector.id,
            title=detector.title,
            detail=detail,
            evidence=(fact,),
            base_score=detector.base_score,
            variants=detector.variants,
            derivation_proposal_id=detector.derivation_proposal_id,
        )
    return None


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _account_lock(
    detector: Detector,
    facts: Sequence[StateFact],
    _as_of: datetime,
) -> Hypothesis | None:
    relevant = tuple(
        fact
        for fact in facts
        if _normalized_token(fact.kind)
        in {"access", "account", "authentication", "login", "lockout"}
        or _normalized_token(fact.source)
        in {"account", "authentication", "identity"}
    )
    for fact in _latest_by_entity(relevant, "account_id", "user_id", "id"):
        kind = _normalized_token(fact.kind)
        source = _normalized_token(fact.source)
        if kind not in {"access", "account", "authentication", "login", "lockout"} and source not in {
            "account",
            "authentication",
            "identity",
        }:
            continue
        status = _normalized_token(_field(fact, "lock_status", "access_status", "status"))
        locked_value = _field(fact, "locked", "is_locked")
        attempts = _as_int(_field(fact, "failed_attempts", "login_attempts", "attempts"))
        locked = locked_value is True or _normalized_token(locked_value) in {"1", "true", "yes"}
        if (not locked and status not in _LOCKED_STATUSES) or attempts is None or attempts < 3:
            continue
        detail = f"The account was locked after {attempts} failed attempts."
        return Hypothesis(
            detector_id=detector.id,
            title=detector.title,
            detail=detail,
            evidence=(fact,),
            base_score=detector.base_score,
            variants=detector.variants,
            derivation_proposal_id=detector.derivation_proposal_id,
        )
    return None


_EVALUATORS: dict[DetectorKind, Callable[[Detector, Sequence[StateFact], datetime], Hypothesis | None]] = {
    "duplicate_charge": _duplicate_charge,
    "late_delivery": _late_delivery,
    "wrong_item": _wrong_item,
    "account_lock": _account_lock,
}


def evaluate_detector(
    detector: Detector,
    state_snapshot: Sequence[StateFact],
    *,
    as_of: datetime,
) -> Hypothesis | None:
    """Evaluate one detector, returning no match unless it was confirmed."""

    if type(detector) is not Detector:
        raise TypeError("detector must be a concrete runtime Detector instance")
    if not detector.confirmed:
        return None
    facts = _ordered_facts(state_snapshot)
    for fact in facts:
        try:
            leaked = fact.occurred_at > as_of
        except TypeError as exc:
            raise ValueError("state and as_of timestamps must use consistent timezone awareness") from exc
        if leaked:
            raise ValueError("state_snapshot contains a fact from after as_of")
    return _EVALUATORS[detector.kind](detector, facts, as_of)


def evaluate_confirmed_detectors(
    state_snapshot: Sequence[StateFact],
    *,
    as_of: datetime,
    detectors: Sequence[Detector] = DEFAULT_DETECTORS,
) -> tuple[Hypothesis, ...]:
    """Return detector matches in stable detector-id order.

    A healthy snapshot produces an empty tuple.  There is no generic fallback
    candidate: inventing one would violate the clean-account invariant.
    """

    by_id: dict[str, Detector] = {}
    for detector in detectors:
        if type(detector) is not Detector:
            raise TypeError(
                "detectors must contain concrete runtime Detector instances"
            )
        if detector.id in by_id:
            raise ValueError(f"duplicate detector id: {detector.id}")
        by_id[detector.id] = detector
    matches = (
        evaluate_detector(detector, state_snapshot, as_of=as_of)
        for detector in sorted(by_id.values(), key=lambda item: item.id)
    )
    return tuple(match for match in matches if match is not None)


def generate_hypotheses(
    interaction: Interaction,
    *,
    detectors: Sequence[Detector] = DEFAULT_DETECTORS,
) -> tuple[Hypothesis, ...]:
    """Convenience boundary for candidate generation from an interaction."""

    return evaluate_confirmed_detectors(
        interaction.state_snapshot,
        as_of=interaction.opened_at,
        detectors=detectors,
    )


# Concise aliases used by callers and older fixtures.
ConfirmedDetector = Detector
build_candidates = generate_hypotheses


__all__ = [
    "ConfirmedDetector",
    "DEFAULT_DETECTORS",
    "Detector",
    "DetectorKind",
    "Hypothesis",
    "build_candidates",
    "evaluate_confirmed_detectors",
    "evaluate_detector",
    "generate_hypotheses",
]

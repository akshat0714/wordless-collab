"""Honest three-rung point-in-time state reconstruction.

Rung 1 uses explicitly linked records from the export.  If those are absent,
rung 2 uses an optional guarded LLM extractor, then a deliberately narrow
deterministic fallback, over agent turns only.  Rung 3 records that the corpus
is operating in degraded, customer-text-only mode.  It does not pretend that
text-only evidence is system state.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from collections.abc import Iterable, Iterator, Sequence
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from wordless.core.llm import LLMClient, LLMRequest
from wordless.core.models import Interaction, Message, StateFact
from wordless.core.redact import Redactor

from wordless.ingest.base import comparable_datetime


Provenance = Literal["exported", "reconstructed", "inferred"]
_ORDER: tuple[Provenance, ...] = ("exported", "reconstructed", "inferred")


class ReconstructionResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    interaction: Interaction
    rung: Provenance
    degraded: bool
    facts_added: int = Field(ge=0)
    method: str

    @model_validator(mode="after")
    def _consistent_degradation(self) -> "ReconstructionResult":
        if self.degraded != (self.rung == "inferred"):
            raise ValueError("Only inferred state is degraded")
        return self


class ProvenanceDistribution(BaseModel):
    """Interaction-level distribution with denominator and method attached."""

    model_config = ConfigDict(frozen=True)

    total_interactions: int = Field(ge=0)
    counts: dict[Provenance, int]
    rates: dict[Provenance, float]
    degraded_interactions: int = Field(ge=0)
    method: str = "highest-fidelity state provenance per interaction"

    @model_validator(mode="after")
    def _validate_denominator(self) -> "ProvenanceDistribution":
        if sum(self.counts.values()) != self.total_interactions:
            raise ValueError("Provenance counts must sum to total_interactions")
        return self


class StateReconstructor:
    """Reconstruct state without network calls or customer-system access."""

    def __init__(
        self,
        *,
        include_agent_extraction: bool = True,
        llm: LLMClient | None = None,
        seed: int = 17,
        redactor: Redactor | None = None,
    ) -> None:
        if llm is not None and not isinstance(llm, LLMClient):
            raise TypeError(
                "llm must be an LLMClient so timeout, cache, and fallback guarantees apply"
            )
        if seed < 0:
            raise ValueError("seed must be non-negative")
        if redactor is not None and type(redactor) is not Redactor:
            raise TypeError("redactor must be a concrete Redactor instance")
        if redactor is not None and not redactor.boundary_safe:
            raise ValueError("redactor must keep mandatory Presidio policy enabled")
        self.include_agent_extraction = include_agent_extraction
        self.llm = llm
        self.seed = seed
        self.redactor = redactor or Redactor()
        if not self.redactor.boundary_safe:
            raise ValueError(
                "reconstruction requires the available mandatory pinned Presidio policy"
            )

    def __call__(self, interaction: Interaction) -> ReconstructionResult:
        return self.reconstruct(interaction)

    def reconstruct(self, interaction: Interaction) -> ReconstructionResult:
        _require_redacted(interaction)
        interaction = Interaction.model_validate(
            interaction.model_dump(mode="python", round_trip=True)
        )
        interaction, _report = self.redactor.redact_interaction(interaction)
        interaction = Interaction.model_validate(
            interaction.model_dump(mode="python", round_trip=True)
        )
        _assert_as_of(interaction.state_snapshot, interaction.opened_at)

        existing_rung = _existing_rung(interaction.state_snapshot)
        if existing_rung is not None:
            method = _method(existing_rung, interaction.state_snapshot)
            return ReconstructionResult(
                interaction=_with_reconstruction_metadata(interaction, existing_rung),
                rung=existing_rung,
                degraded=existing_rung == "inferred",
                facts_added=0,
                method=method,
            )

        if self.include_agent_extraction:
            reconstructed = (
                extract_agent_facts_with_llm(
                    interaction.messages,
                    opened_at=interaction.opened_at,
                    llm=self.llm,
                    seed=self.seed,
                    redactor=self.redactor,
                )
                if self.llm is not None
                else []
            )
            if not reconstructed:
                reconstructed = extract_agent_facts(
                    interaction.messages,
                    opened_at=interaction.opened_at,
                )
            if reconstructed:
                method = _method("reconstructed", reconstructed)
                updated = _replace_state(
                    interaction,
                    reconstructed,
                    rung="reconstructed",
                    method=method,
                )
                return ReconstructionResult(
                    interaction=updated,
                    rung="reconstructed",
                    degraded=False,
                    facts_added=len(reconstructed),
                    method=method,
                )

        inferred = _inferred_text_fact(interaction)
        updated = _replace_state(interaction, [inferred], rung="inferred")
        return ReconstructionResult(
            interaction=updated,
            rung="inferred",
            degraded=True,
            facts_added=1,
            method=_method("inferred"),
        )


def reconstruct_state(
    interaction: Interaction,
    *,
    include_agent_extraction: bool = True,
    llm: LLMClient | None = None,
    seed: int = 17,
    redactor: Redactor | None = None,
) -> Interaction:
    """Functional convenience API returning only the updated interaction."""

    return StateReconstructor(
        include_agent_extraction=include_agent_extraction,
        llm=llm,
        seed=seed,
        redactor=redactor,
    ).reconstruct(interaction).interaction


def reconstruct_many(
    interactions: Iterable[Interaction],
    *,
    include_agent_extraction: bool = True,
    llm: LLMClient | None = None,
    seed: int = 17,
    redactor: Redactor | None = None,
) -> Iterator[ReconstructionResult]:
    """Stream reconstruction results; corpora are never materialized."""

    reconstructor = StateReconstructor(
        include_agent_extraction=include_agent_extraction,
        llm=llm,
        seed=seed,
        redactor=redactor,
    )
    for interaction in interactions:
        yield reconstructor.reconstruct(interaction)


def provenance_rung(interaction: Interaction) -> Provenance:
    """Return the highest-fidelity rung represented by an interaction."""

    return _existing_rung(interaction.state_snapshot) or "inferred"


def provenance_distribution(
    interactions: Iterable[Interaction | ReconstructionResult],
) -> ProvenanceDistribution:
    counts: Counter[Provenance] = Counter()
    total = 0
    for item in interactions:
        rung = item.rung if isinstance(item, ReconstructionResult) else provenance_rung(item)
        counts[rung] += 1
        total += 1
    complete_counts: dict[Provenance, int] = {rung: counts[rung] for rung in _ORDER}
    rates: dict[Provenance, float] = {
        rung: (complete_counts[rung] / total if total else 0.0) for rung in _ORDER
    }
    return ProvenanceDistribution(
        total_interactions=total,
        counts=complete_counts,
        rates=rates,
        degraded_interactions=complete_counts["inferred"],
    )


_EVIDENCE_MARKER = re.compile(
    r"\b(?:i\s+can\s+see|i\s+see|our\s+(?:records|system)\s+show(?:s)?|"
    r"the\s+(?:account|order|charge|subscription)\s+(?:shows|is)|"
    r"your\s+(?:account|order|subscription)\s+is)\b",
    re.IGNORECASE,
)
_AMOUNT = re.compile(
    r"(?P<symbol>[$£€])\s*(?P<amount>\d{1,9}(?:,\d{3})*(?:\.\d{1,2})?)",
    re.IGNORECASE,
)
_CHARGE = re.compile(r"\b(?:charges?|charged|transactions?|payments?)\b", re.IGNORECASE)
_DUPLICATE = re.compile(
    r"\b(?:two|2|twice|duplicate|duplicated|double)\b", re.IGNORECASE
)
_STATED_DAY = re.compile(r"\b(?:on\s+)?(?:the\s+)?(?P<day>\d{1,2}(?:st|nd|rd|th))\b", re.IGNORECASE)
_ORDER_ID = re.compile(
    r"\border\s*(?:#|id\s*)?(?P<order>[A-Z0-9][A-Z0-9_-]{2,31})\b", re.IGNORECASE
)
_ORDER_STATUS = re.compile(
    r"\b(?P<status>pending|processing|shipped|delivered|delayed|cancelled|canceled|returned)\b",
    re.IGNORECASE,
)
_ACCOUNT_LOCKED = re.compile(r"\baccount\b.{0,40}\b(?:locked|suspended|disabled)\b", re.IGNORECASE)
_SUBSCRIPTION = re.compile(
    r"\bsubscription\b.{0,50}\b(?P<status>active|paused|cancelled|canceled|expired)\b",
    re.IGNORECASE,
)
_ATTEMPTS = re.compile(r"\b(?P<count>\d{1,3})\s+(?:failed\s+)?attempts?\b", re.IGNORECASE)


def extract_agent_facts(messages: Sequence[Message], *, opened_at: datetime) -> list[StateFact]:
    """Extract only explicit agent observations using conservative patterns.

    Every fact is timestamped to ``opened_at`` as required by the provenance
    ladder.  Dates mentioned later in a turn remain attributes, never event
    timestamps, so they cannot leak post-contact state.
    """

    output: list[StateFact] = []
    seen: set[tuple[str, str, tuple[tuple[str, str], ...]]] = set()
    for message in messages:
        if message.author != "agent" or not _EVIDENCE_MARKER.search(message.text):
            continue
        text = message.text

        if _CHARGE.search(text):
            amounts = list(_AMOUNT.finditer(text))
            duplicate = bool(_DUPLICATE.search(text))
            for match in amounts:
                fields: dict[str, object] = {
                    "amount": _decimal_text(match.group("amount")),
                    "currency": {"$": "USD", "£": "GBP", "€": "EUR"}[match.group("symbol")],
                    "count": 2 if duplicate else 1,
                    "extractor": "deterministic_agent_v1",
                }
                day = _STATED_DAY.search(text)
                if day:
                    fields["stated_day"] = day.group("day").casefold()
                _append_unique(
                    output,
                    seen,
                    StateFact(
                        source="billing",
                        kind="charge",
                        occurred_at=opened_at,
                        fields=fields,
                        provenance="reconstructed",
                    ),
                )

        order = _ORDER_ID.search(text)
        status = _ORDER_STATUS.search(text)
        if order and status:
            _append_unique(
                output,
                seen,
                StateFact(
                    source="orders",
                    kind="order",
                    occurred_at=opened_at,
                    fields={
                        "order_id": order.group("order"),
                        "status": status.group("status").casefold().replace("canceled", "cancelled"),
                        "extractor": "deterministic_agent_v1",
                    },
                    provenance="reconstructed",
                ),
            )

        account = _ACCOUNT_LOCKED.search(text)
        if account:
            attempts = _ATTEMPTS.search(text)
            fields = {
                "status": "locked",
                "extractor": "deterministic_agent_v1",
            }
            if attempts:
                fields["failed_attempts"] = int(attempts.group("count"))
            _append_unique(
                output,
                seen,
                StateFact(
                    source="account",
                    kind="account",
                    occurred_at=opened_at,
                    fields=fields,
                    provenance="reconstructed",
                ),
            )

        subscription = _SUBSCRIPTION.search(text)
        if subscription:
            subscription_status = subscription.group("status").casefold().replace(
                "canceled", "cancelled"
            )
            _append_unique(
                output,
                seen,
                StateFact(
                    source="billing",
                    kind="subscription",
                    occurred_at=opened_at,
                    fields={
                        "status": subscription_status,
                        "extractor": "deterministic_agent_v1",
                    },
                    provenance="reconstructed",
                ),
            )
    return output


_LLM_FACT_KEYS = frozenset({"source", "kind", "fields"})
_LLM_FACT_IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]{0,48}$")


def extract_agent_facts_with_llm(
    messages: Sequence[Message],
    *,
    opened_at: datetime,
    llm: LLMClient,
    seed: int = 17,
    redactor: Redactor | None = None,
) -> list[StateFact]:
    """Extract explicit observations through the guarded LLM boundary.

    The request is assembled from agent turns alone.  Each included turn is
    redacted again immediately before the model boundary, even when its ingest
    flag claims it was already scrubbed.  Malformed, empty, or failed output is
    represented by an empty list so the caller can use the deterministic regex
    extractor.
    """

    if not isinstance(llm, LLMClient):
        raise TypeError(
            "llm must be an LLMClient so timeout, cache, and fallback guarantees apply"
        )
    if seed < 0:
        raise ValueError("seed must be non-negative")
    if redactor is not None and type(redactor) is not Redactor:
        raise TypeError("redactor must be a concrete Redactor instance")
    if redactor is not None and not redactor.boundary_safe:
        raise ValueError("redactor must keep mandatory Presidio policy enabled")
    active_redactor = redactor or Redactor()
    if not active_redactor.boundary_safe:
        raise ValueError(
            "reconstruction requires the available mandatory pinned Presidio policy"
        )
    agent_turns = [
        {
            "turn": agent_index,
            "text": active_redactor.redact(message.text).text,
        }
        for agent_index, message in enumerate(
            message for message in messages if message.author == "agent"
        )
    ]
    if not agent_turns:
        return []

    request = LLMRequest(
        prompt=(
            "Extract only system-state observations explicitly asserted in these "
            "redacted agent messages. Do not infer missing values. Return only a "
            "JSON array of objects with exactly source, kind, and non-empty fields. "
            "Use lowercase snake_case source and kind. Return [] when there is no "
            "explicit observation.\n"
            + json.dumps(
                agent_turns,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        ),
        system_prompt=(
            "You extract point-in-time facts from redacted agent messages only; "
            "output valid JSON only."
        ),
        seed=seed,
        temperature=0,
        max_output_tokens=2000,
        metadata={"stage": "state_reconstruction", "agent_turns": len(agent_turns)},
    )
    try:
        result = llm.generate(request)
    except Exception:
        return []
    return _parse_llm_agent_facts(result.text, opened_at=opened_at)


def _parse_llm_agent_facts(text: str, *, opened_at: datetime) -> list[StateFact]:
    try:
        raw = json.loads(text)
    except (json.JSONDecodeError, TypeError, ValueError):
        return []
    if not isinstance(raw, list) or len(raw) > 25:
        return []

    output: list[StateFact] = []
    seen: set[tuple[str, str, tuple[tuple[str, str], ...]]] = set()
    for value in raw:
        if not isinstance(value, dict) or set(value) != _LLM_FACT_KEYS:
            return []
        source = value.get("source")
        kind = value.get("kind")
        fields = value.get("fields")
        if (
            not isinstance(source, str)
            or not _LLM_FACT_IDENTIFIER.fullmatch(source)
            or not isinstance(kind, str)
            or not _LLM_FACT_IDENTIFIER.fullmatch(kind)
            or not isinstance(fields, dict)
            or not fields
            or len(fields) > 30
            or "extractor" in fields
            or any(
                not isinstance(name, str)
                or not name
                or name != name.strip()
                or len(name) > 80
                for name in fields
            )
            or not all(_strict_json_value(item) for item in fields.values())
        ):
            return []
        normalized_fields = dict(fields)
        normalized_fields["extractor"] = "llm_agent_v1"
        try:
            fact = StateFact(
                source=source,
                kind=kind,
                occurred_at=opened_at,
                fields=normalized_fields,
                provenance="reconstructed",
            )
        except (TypeError, ValueError):
            return []
        _append_unique(output, seen, fact)
    return output


def _strict_json_value(value: object, *, depth: int = 0) -> bool:
    if depth > 8:
        return False
    if value is None or isinstance(value, (str, bool, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return len(value) <= 50 and all(
            _strict_json_value(item, depth=depth + 1) for item in value
        )
    if isinstance(value, dict):
        return len(value) <= 30 and all(
            isinstance(name, str)
            and bool(name)
            and len(name) <= 80
            and _strict_json_value(item, depth=depth + 1)
            for name, item in value.items()
        )
    return False


def _append_unique(
    output: list[StateFact],
    seen: set[tuple[str, str, tuple[tuple[str, str], ...]]],
    fact: StateFact,
) -> None:
    key = (
        fact.source,
        fact.kind,
        tuple(sorted((str(name), repr(value)) for name, value in fact.fields.items())),
    )
    if key not in seen:
        seen.add(key)
        output.append(fact)


def _decimal_text(value: str) -> str:
    try:
        number = Decimal(value.replace(",", ""))
    except InvalidOperation:
        return value
    return format(number.quantize(Decimal("0.01")), "f")


def _inferred_text_fact(interaction: Interaction) -> StateFact:
    fragment = next(
        (message.text for message in interaction.messages if message.author == "customer"),
        "",
    )
    return StateFact(
        source="interaction",
        kind="request",
        occurred_at=interaction.opened_at,
        fields={
            "fragment": fragment,
            "basis": "customer_text_only",
            "degraded": True,
        },
        provenance="inferred",
    )


def _existing_rung(facts: Sequence[StateFact]) -> Provenance | None:
    provenances = {fact.provenance for fact in facts}
    for rung in _ORDER:
        if rung in provenances:
            return rung
    return None


def _replace_state(
    interaction: Interaction,
    facts: Sequence[StateFact],
    *,
    rung: Provenance,
    method: str | None = None,
) -> Interaction:
    payload = interaction.model_dump()
    payload["state_snapshot"] = list(facts)
    metadata = dict(interaction.metadata)
    metadata["state_reconstruction"] = {
        "rung": rung,
        "degraded": rung == "inferred",
        "method": method or _method(rung, facts),
    }
    payload["metadata"] = metadata
    return Interaction.model_validate(payload)


def _with_reconstruction_metadata(interaction: Interaction, rung: Provenance) -> Interaction:
    metadata = dict(interaction.metadata)
    desired = {
        "rung": rung,
        "degraded": rung == "inferred",
        "method": _method(rung, interaction.state_snapshot),
    }
    if metadata.get("state_reconstruction") == desired:
        return interaction
    payload = interaction.model_dump()
    metadata["state_reconstruction"] = desired
    payload["metadata"] = metadata
    return Interaction.model_validate(payload)


def _method(rung: Provenance, facts: Sequence[StateFact] = ()) -> str:
    if rung == "reconstructed" and any(
        fact.fields.get("extractor") == "llm_agent_v1" for fact in facts
    ):
        return "bounded LLM extraction from redacted agent turns only"
    return {
        "exported": "linked records supplied by the export",
        "reconstructed": "deterministic extraction from agent turns only",
        "inferred": "degraded customer-text-only inference",
    }[rung]


def _require_redacted(interaction: Interaction) -> None:
    if any(not message.redacted for message in interaction.messages):
        raise ValueError("State reconstruction requires redacted ingest output")


def _assert_as_of(facts: Sequence[StateFact], opened_at: datetime) -> None:
    future = [
        fact
        for fact in facts
        if comparable_datetime(fact.occurred_at) > comparable_datetime(opened_at)
    ]
    if future:
        raise ValueError("State reconstruction received facts after interaction.opened_at")

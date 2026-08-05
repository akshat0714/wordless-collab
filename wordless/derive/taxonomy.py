"""Stage 2: capped, deterministic intent taxonomy derivation.

An optional LLM proposes labels through the provider-neutral core wrapper. The
offline fallback is intentionally conservative and produces broad support
labels instead of pretending exploratory clustering is ground truth.
"""

from __future__ import annotations

from collections import defaultdict
import json
import re
from typing import Iterable, Sequence

from pydantic import BaseModel, ConfigDict, Field, model_validator

from wordless.core.llm import LLMClient, LLMRequest
from wordless.core.redact import Redactor

from .summarize import InteractionSummary


class TaxonomyLabel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(pattern=r"^[a-z][a-z0-9_]{1,48}$")
    name: str = Field(min_length=3, max_length=80)
    description: str = Field(min_length=8, max_length=240)
    support: int = Field(gt=0)
    example_interaction_ids: tuple[str, ...] = Field(min_length=1, max_length=5)


class Taxonomy(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    labels: tuple[TaxonomyLabel, ...] = Field(min_length=1, max_length=25)
    sample_size: int = Field(gt=0)
    method: str
    seed: int = Field(ge=0)
    human_review_required: bool = True

    @model_validator(mode="after")
    def unique_labels(self) -> "Taxonomy":
        identifiers = [label.id for label in self.labels]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("taxonomy label ids must be unique")
        return self


_RULES: tuple[tuple[str, str, str, tuple[str, ...]], ...] = (
    ("duplicate_charge", "Duplicate charge", "A payment appears more than once.", ("twice", "duplicate", "charged again", "two charges")),
    ("refund", "Refund", "A customer asks about money being returned.", ("refund", "money back", "credit back")),
    ("delivery", "Delivery", "A customer asks about a delivery or missing package.", ("delivery", "package", "parcel", "arrive", "shipment")),
    ("wrong_or_damaged_item", "Wrong or damaged item", "A delivered item is wrong, damaged, or incomplete.", ("wrong item", "damaged", "broken", "missing item")),
    ("account_access", "Account access", "A customer cannot access or verify an account.", ("password", "locked", "login", "sign in", "code")),
    ("subscription", "Subscription", "A customer asks to change or stop a recurring service.", ("subscription", "renew", "cancel plan", "membership")),
    ("document_request", "Document request", "A customer asks for a record, receipt, or transcript.", ("transcript", "receipt", "invoice", "document", "certificate")),
    ("other_support", "Other support", "A broad support request without a stable specific label.", ()),
)
_LLM_LABEL_KEYS = frozenset(
    {"id", "name", "description", "support", "example_interaction_ids"}
)


def _rule_label(text: str) -> tuple[str, str, str]:
    normalized = text.casefold()
    for identifier, name, description, terms in _RULES[:-1]:
        if any(term in normalized for term in terms):
            return identifier, name, description
    identifier, name, description, _ = _RULES[-1]
    return identifier, name, description


def _fallback_taxonomy(summaries: tuple[InteractionSummary, ...], max_labels: int, seed: int) -> Taxonomy:
    grouped: dict[tuple[str, str, str], list[str]] = defaultdict(list)
    for summary in summaries:
        grouped[_rule_label(summary.text)].append(summary.interaction_id)
    labels = [
        TaxonomyLabel(
            id=identifier,
            name=name,
            description=description,
            support=len(ids),
            example_interaction_ids=tuple(sorted(ids)[:5]),
        )
        for (identifier, name, description), ids in grouped.items()
    ]
    labels.sort(key=lambda item: (-item.support, item.id))
    return Taxonomy(
        labels=tuple(labels[:max_labels]),
        sample_size=len(summaries),
        method="deterministic conservative offline rules",
        seed=seed,
    )


def _parse_llm_labels(
    text: str,
    summaries: Sequence[InteractionSummary],
    max_labels: int,
) -> tuple[TaxonomyLabel, ...] | None:
    """Parse one batch proposal without repairing malformed model output.

    An empty array is a valid saturation signal.  Examples and support are
    constrained to the current batch so accumulated counts remain auditable.
    """

    try:
        raw = json.loads(text)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if not isinstance(raw, list):
        return None
    if not raw:
        return ()
    by_id = {summary.interaction_id for summary in summaries}
    labels: list[TaxonomyLabel] = []
    for value in raw[:max_labels]:
        if not isinstance(value, dict) or set(value) != _LLM_LABEL_KEYS:
            return None
        raw_identifier = value.get("id")
        if not isinstance(raw_identifier, str):
            return None
        identifier = re.sub(
            r"[^a-z0-9]+", "_", raw_identifier.casefold()
        ).strip("_")
        raw_examples = value.get("example_interaction_ids", [])
        if (
            not isinstance(raw_examples, list)
            or not raw_examples
            or any(not isinstance(item, str) or item not in by_id for item in raw_examples)
            or not isinstance(value.get("name"), str)
            or not isinstance(value.get("description"), str)
            or type(value.get("support")) is not int
        ):
            return None
        examples = tuple(sorted(set(raw_examples)))[:5]
        try:
            label = TaxonomyLabel(
                id=identifier,
                name=value["name"],
                description=value["description"],
                support=value["support"],
                example_interaction_ids=examples,
            )
        except (KeyError, TypeError, ValueError):
            return None
        if label.support > len(summaries) or label.support < len(examples):
            return None
        labels.append(label)
    return tuple(sorted(labels, key=lambda item: (-item.support, item.id)))


_GENERIC_LABEL_WORDS = {
    "issue",
    "issues",
    "problem",
    "problems",
    "request",
    "requests",
    "support",
}


def _label_tokens(value: str) -> frozenset[str]:
    tokens: set[str] = set()
    for raw in re.findall(r"[a-z0-9]+", value.casefold()):
        if raw in _GENERIC_LABEL_WORDS:
            continue
        if raw.endswith("ies") and len(raw) > 4:
            raw = raw[:-3] + "y"
        elif raw.endswith("s") and len(raw) > 3:
            raw = raw[:-1]
        tokens.add(raw)
    return frozenset(tokens)


def _near_duplicate(left: TaxonomyLabel, right: TaxonomyLabel) -> bool:
    if left.id == right.id:
        return True
    left_tokens = _label_tokens(f"{left.id} {left.name}")
    right_tokens = _label_tokens(f"{right.id} {right.name}")
    if not left_tokens or not right_tokens:
        return False
    overlap = len(left_tokens & right_tokens) / len(left_tokens | right_tokens)
    return overlap >= 0.8


def _merge_batch_labels(
    accumulated: list[TaxonomyLabel],
    proposals: Sequence[TaxonomyLabel],
    *,
    max_labels: int,
) -> int:
    """Merge a batch in place and return the number of genuinely new labels."""

    added = 0
    for proposal in proposals:
        matches = [
            (index, existing)
            for index, existing in enumerate(accumulated)
            if _near_duplicate(existing, proposal)
        ]
        if matches:
            index, existing = min(
                matches,
                key=lambda pair: (pair[1].id != proposal.id, pair[1].id),
            )
            accumulated[index] = existing.model_copy(
                update={
                    "support": existing.support + proposal.support,
                    "example_interaction_ids": tuple(
                        sorted(
                            set(existing.example_interaction_ids)
                            | set(proposal.example_interaction_ids)
                        )[:5]
                    ),
                }
            )
            continue
        if len(accumulated) >= max_labels:
            continue
        accumulated.append(proposal)
        added += 1
    accumulated.sort(key=lambda item: (-item.support, item.id))
    return added


def _taxonomy_request(
    batch: Sequence[InteractionSummary],
    existing: Sequence[TaxonomyLabel],
    *,
    batch_index: int,
    max_labels: int,
    seed: int,
) -> LLMRequest:
    sample = [{"id": item.interaction_id, "summary": item.text} for item in batch]
    known = [
        {
            "id": label.id,
            "name": label.name,
            "description": label.description,
        }
        for label in sorted(existing, key=lambda item: item.id)
    ]
    remaining = max(0, max_labels - len(existing))
    return LLMRequest(
        prompt=(
            "Assign this deterministic batch to the known broad support intents. "
            "Return every intent represented in this batch, reusing the exact known "
            "id, name, and description when one fits. Merge near-duplicates and add "
            f"at most {remaining} genuinely new labels. Output only a JSON array with "
            "id, name, description, support within this batch, and "
            "example_interaction_ids drawn only from this batch. Return [] only when "
            "the batch contains no classifiable support intent.\n"
            + json.dumps(
                {"known_labels": known, "batch": sample},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        ),
        system_prompt=(
            "You iteratively propose a taxonomy for human review. Output valid JSON only."
        ),
        seed=seed,
        temperature=0,
        max_output_tokens=2000,
        metadata={
            "stage": "taxonomy",
            "batch_index": batch_index,
            "batch_size": len(batch),
            "known_labels": len(existing),
        },
    )


def build_taxonomy(
    summaries: Iterable[InteractionSummary],
    *,
    llm: LLMClient | None = None,
    max_labels: int = 25,
    seed: int = 17,
    batch_size: int = 50,
    redactor: Redactor | None = None,
) -> Taxonomy:
    values = tuple(sorted(summaries, key=lambda item: item.interaction_id))
    if not values:
        raise ValueError("taxonomy requires at least one summary")
    if not 1 <= max_labels <= 25:
        raise ValueError("max_labels must be between 1 and 25")
    if batch_size < 1:
        raise ValueError("batch_size must be at least 1")
    if len({item.interaction_id for item in values}) != len(values):
        raise ValueError("taxonomy summary interaction IDs must be unique")
    if redactor is not None and type(redactor) is not Redactor:
        raise TypeError("redactor must be a concrete Redactor instance")
    if redactor is not None and not redactor.boundary_safe:
        raise ValueError("redactor must keep mandatory Presidio policy enabled")
    active_redactor = redactor or Redactor()
    if not active_redactor.boundary_safe:
        raise ValueError(
            "taxonomy derivation requires the available mandatory pinned Presidio policy"
        )
    safe_values: list[InteractionSummary] = []
    for index, summary in enumerate(values, start=1):
        # Prompt IDs are model inputs.  Canonical ingest IDs normally pass this
        # scan unchanged; arbitrary direct-call identifiers that resemble PII
        # become deterministic run-local handles instead of leaking verbatim.
        identifier_changed = (
            active_redactor.redact_external_identifier(summary.interaction_id).changed
            or active_redactor.redact(summary.interaction_id).changed
        )
        safe_values.append(
            summary.model_copy(
                update={
                    "interaction_id": (
                        f"redacted-interaction-{index:06d}"
                        if identifier_changed
                        else summary.interaction_id
                    ),
                    "text": active_redactor.redact(summary.text).text,
                },
                deep=True,
            )
        )
    values = tuple(safe_values)
    fallback = _fallback_taxonomy(values, max_labels, seed)
    if llm is None:
        return fallback
    if not isinstance(llm, LLMClient):
        raise TypeError(
            "llm must be an LLMClient so timeout, cache, and fallback guarantees apply"
        )
    labels: list[TaxonomyLabel] = []
    processed = 0
    batch_count = 0
    for offset in range(0, len(values), batch_size):
        if len(labels) >= max_labels:
            break
        batch = values[offset : offset + batch_size]
        batch_count += 1
        request = _taxonomy_request(
            batch,
            labels,
            batch_index=batch_count - 1,
            max_labels=max_labels,
            seed=seed,
        )
        try:
            result = llm.generate(request)
        except Exception:
            return fallback
        proposals = _parse_llm_labels(result.text, batch, max_labels)
        if proposals is None:
            return fallback
        processed += len(batch)
        added = _merge_batch_labels(labels, proposals, max_labels=max_labels)
        if not labels:
            return fallback
        if added == 0:
            break

    if not labels:
        return fallback
    return Taxonomy(
        labels=tuple(labels[:max_labels]),
        sample_size=processed,
        method=(
            "iterative LLM proposals over deterministic sorted batches; "
            "deterministic near-duplicate merge; human review required"
        ),
        seed=seed,
    )


__all__ = ["Taxonomy", "TaxonomyLabel", "build_taxonomy"]

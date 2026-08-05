"""Deterministic orchestration for taxonomy derivation and distillation.

This module joins the existing stage implementations without changing their
trust boundaries.  The LLM labels below are deliberately named ``weak_labels``
and every serialized record says that they are not human ground truth.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from hashlib import sha256
import json
import re
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator

from wordless.core.llm import LLMClient, LLMRequest
from wordless.core.models import Interaction
from wordless.core.redact import Redactor

from .detectors import DetectorDerivationOutcome, derive_detector_outcomes
from .distill import DistillationMetrics, DistilledClassifier, TextEmbedder
from .summarize import (
    InteractionSummary,
    interaction_fingerprint,
    summarize_interaction,
)
from .taxonomy import Taxonomy, TaxonomyLabel, build_taxonomy


_WEAK_LABEL_KEYS = frozenset({"interaction_id", "label_id"})
_TOKEN_PATTERN = re.compile(r"[a-z0-9]+")
_TRUTH_STATUS = (
    "weak LLM or deterministic labels for distillation; not human-reviewed ground truth"
)
_SAMPLING_METHOD = (
    "lowest SHA-256(seed + canonical interaction fingerprint), then interaction ID"
)
_CLASSIFICATION_TEXT_METHOD = (
    "redacted customer turns joined in chronological input order"
)


def _json_digest(value: object) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return sha256(payload).hexdigest()


class DerivationBatchAudit(BaseModel):
    """Membership, method, and sanitized output for one deterministic batch."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    stage: Literal["summarize", "weak_label"]
    batch_index: int = Field(ge=0)
    interaction_ids: tuple[str, ...] = Field(min_length=1)
    method: str = Field(min_length=3)
    output: tuple[str, ...] = Field(min_length=1)
    output_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    model_output: str | None = None
    model_output_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    fallback_reason: str | None = None

    @model_validator(mode="after")
    def validate_audit_hashes(self) -> "DerivationBatchAudit":
        if len(set(self.interaction_ids)) != len(self.interaction_ids):
            raise ValueError("batch interaction IDs must be unique")
        if self.output_sha256 != _json_digest(self.output):
            raise ValueError("batch output hash does not match output")
        if (self.model_output is None) != (self.model_output_sha256 is None):
            raise ValueError("model output and model output hash must appear together")
        if (
            self.model_output is not None
            and self.model_output_sha256 != _json_digest(self.model_output)
        ):
            raise ValueError("model output hash does not match sanitized model output")
        return self


WeakLabelSource = Literal[
    "provider",
    "cache",
    "llm_fallback",
    "deterministic_fallback",
]


class WeakLabel(BaseModel):
    """A training label with an explicit non-ground-truth status."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    interaction_id: str
    label_id: str
    source: WeakLabelSource
    human_reviewed: Literal[False] = False
    truth_status: Literal[
        "weak LLM or deterministic labels for distillation; not human-reviewed ground truth"
    ] = _TRUTH_STATUS


class CorpusPrediction(BaseModel):
    """Classifier output for one member of the complete canonical corpus."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    interaction_id: str
    label_id: str
    model_score: float = Field(ge=0, le=1)


class DerivationAudit(BaseModel):
    """Serializable evidence for one derivation and distillation run."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    corpus_size: int = Field(gt=0)
    sample_size: int = Field(ge=8)
    seed: int = Field(ge=0)
    sampling_method: str = _SAMPLING_METHOD
    sample_interaction_ids: tuple[str, ...] = Field(min_length=8)
    summary_batches: tuple[DerivationBatchAudit, ...] = Field(min_length=1)
    summaries: tuple[InteractionSummary, ...] = Field(min_length=8)
    taxonomy: Taxonomy
    weak_label_batches: tuple[DerivationBatchAudit, ...] = Field(min_length=1)
    weak_labels: tuple[WeakLabel, ...] = Field(min_length=8)
    distillation_metrics: DistillationMetrics
    classification_text_method: str = _CLASSIFICATION_TEXT_METHOD
    predictions: tuple[CorpusPrediction, ...] = Field(min_length=1)
    detector_outcomes: tuple[DetectorDerivationOutcome, ...] = Field(min_length=1)
    human_ground_truth_used: Literal[False] = False
    truth_status: Literal[
        "weak LLM or deterministic labels for distillation; not human-reviewed ground truth"
    ] = _TRUTH_STATUS

    @model_validator(mode="after")
    def validate_membership(self) -> "DerivationAudit":
        if self.sample_size > self.corpus_size:
            raise ValueError("sample_size cannot exceed corpus_size")
        sample_ids = self.sample_interaction_ids
        if len(sample_ids) != self.sample_size or len(set(sample_ids)) != len(sample_ids):
            raise ValueError("sample membership must contain sample_size unique IDs")
        if tuple(sorted(sample_ids)) != sample_ids:
            raise ValueError("sample membership must be in deterministic ID order")
        summary_ids = tuple(item.interaction_id for item in self.summaries)
        label_ids = tuple(item.interaction_id for item in self.weak_labels)
        if summary_ids != sample_ids or label_ids != sample_ids:
            raise ValueError("summaries and weak labels must align exactly to the sample")
        prediction_ids = tuple(item.interaction_id for item in self.predictions)
        if len(prediction_ids) != self.corpus_size or len(set(prediction_ids)) != len(
            prediction_ids
        ):
            raise ValueError("predictions must contain every corpus interaction exactly once")
        if tuple(sorted(prediction_ids)) != prediction_ids:
            raise ValueError("predictions must be in deterministic interaction ID order")
        if not set(sample_ids).issubset(prediction_ids):
            raise ValueError("sample membership must be drawn from the predicted corpus")

        taxonomy_ids = {label.id for label in self.taxonomy.labels}
        if any(item.label_id not in taxonomy_ids for item in self.weak_labels):
            raise ValueError("every weak label must use an exact derived taxonomy ID")
        if any(item.label_id not in taxonomy_ids for item in self.predictions):
            raise ValueError("every prediction must use an exact derived taxonomy ID")
        outcome_ids = tuple(item.taxonomy_label_id for item in self.detector_outcomes)
        if outcome_ids != tuple(sorted(taxonomy_ids)):
            raise ValueError("Stage 4 must record exactly one outcome per taxonomy label")
        taxonomy_names = {label.id: label.name for label in self.taxonomy.labels}
        if any(
            outcome.taxonomy_label != taxonomy_names[outcome.taxonomy_label_id]
            for outcome in self.detector_outcomes
        ):
            raise ValueError("Stage 4 labels must match the derived taxonomy")
        if len({outcome.minimum_support for outcome in self.detector_outcomes}) != 1:
            raise ValueError("Stage 4 outcomes must use one declared frequency floor")
        predicted_counts = Counter(item.label_id for item in self.predictions)
        if any(
            outcome.member_count != predicted_counts[outcome.taxonomy_label_id]
            for outcome in self.detector_outcomes
        ):
            raise ValueError("Stage 4 membership must match full-corpus predictions")
        if sum(outcome.member_count for outcome in self.detector_outcomes) != self.corpus_size:
            raise ValueError("Stage 4 memberships must partition the complete corpus")
        if self.distillation_metrics.label_count != len(
            {item.label_id for item in self.weak_labels}
        ):
            raise ValueError("metric label count must match weak-label classes")
        if (
            self.distillation_metrics.training_n
            + self.distillation_metrics.held_out_n
            != self.sample_size
        ):
            raise ValueError("distillation metric denominators must equal sample_size")

        summarized_batches = tuple(
            identifier
            for batch in self.summary_batches
            for identifier in batch.interaction_ids
        )
        labeled_batches = tuple(
            identifier
            for batch in self.weak_label_batches
            for identifier in batch.interaction_ids
        )
        if summarized_batches != sample_ids or labeled_batches != sample_ids:
            raise ValueError("batch membership must partition the deterministic sample")
        if tuple(batch.batch_index for batch in self.summary_batches) != tuple(
            range(len(self.summary_batches))
        ):
            raise ValueError("summary batch indexes must be contiguous from zero")
        if tuple(batch.batch_index for batch in self.weak_label_batches) != tuple(
            range(len(self.weak_label_batches))
        ):
            raise ValueError("weak-label batch indexes must be contiguous from zero")
        if any(batch.stage != "summarize" for batch in self.summary_batches):
            raise ValueError("summary_batches contains a non-summary batch")
        if any(batch.stage != "weak_label" for batch in self.weak_label_batches):
            raise ValueError("weak_label_batches contains a non-label batch")
        if any(
            len(batch.output) != len(batch.interaction_ids)
            for batch in (*self.summary_batches, *self.weak_label_batches)
        ):
            raise ValueError("every batch must expose one accepted output per member")
        return self


@dataclass(frozen=True)
class DerivationRun:
    """A fitted classifier paired with its immutable, serializable audit trail."""

    classifier: DistilledClassifier
    audit: DerivationAudit


def _validated_redactor(redactor: Redactor | None) -> Redactor:
    if redactor is not None and type(redactor) is not Redactor:
        raise TypeError("redactor must be a concrete Redactor instance")
    active = redactor or Redactor()
    if not active.boundary_safe:
        raise ValueError(
            "derivation orchestration requires the mandatory pinned Presidio policy"
        )
    return active


def _validated_corpus(
    interactions: Iterable[Interaction],
    *,
    redactor: Redactor,
) -> tuple[Interaction, ...]:
    values: list[Interaction] = []
    for value in interactions:
        if type(value) is not Interaction:
            raise TypeError("derivation requires canonical Interaction instances")
        canonical = Interaction.model_validate(
            value.model_dump(mode="python", round_trip=True)
        )
        if any(not message.redacted for message in canonical.messages):
            raise ValueError("derivation refuses interactions with unredacted messages")
        safe, _report = redactor.redact_interaction(canonical)
        values.append(
            Interaction.model_validate(
                safe.model_dump(mode="python", round_trip=True)
            )
        )
    if not values:
        raise ValueError("derivation requires at least one interaction")
    values.sort(key=lambda item: item.id)
    identifiers = [item.id for item in values]
    if len(identifiers) != len(set(identifiers)):
        raise ValueError("derivation interaction IDs must be unique")
    return tuple(values)


def _sample_corpus(
    corpus: Sequence[Interaction],
    *,
    sample_size: int,
    seed: int,
) -> tuple[Interaction, ...]:
    ranked = sorted(
        corpus,
        key=lambda item: (
            sha256(
                f"{seed}\x00{interaction_fingerprint(item)}".encode("utf-8")
            ).hexdigest(),
            item.id,
        ),
    )
    return tuple(sorted(ranked[:sample_size], key=lambda item: item.id))


def _batches(values: Sequence[Interaction], size: int) -> Iterable[tuple[Interaction, ...]]:
    for offset in range(0, len(values), size):
        yield tuple(values[offset : offset + size])


def _summarize_sample(
    sample: Sequence[Interaction],
    *,
    llm: LLMClient | None,
    seed: int,
    batch_size: int,
    redactor: Redactor,
) -> tuple[tuple[InteractionSummary, ...], tuple[DerivationBatchAudit, ...]]:
    summaries: list[InteractionSummary] = []
    audits: list[DerivationBatchAudit] = []
    for batch_index, batch in enumerate(_batches(sample, batch_size)):
        batch_summaries = tuple(
            summarize_interaction(
                interaction,
                llm=llm,
                seed=seed,
                redactor=redactor,
            )
            for interaction in batch
        )
        summaries.extend(batch_summaries)
        output = tuple(
            json.dumps(
                summary.model_dump(mode="json"),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            for summary in batch_summaries
        )
        sources = sorted({summary.source for summary in batch_summaries})
        audits.append(
            DerivationBatchAudit(
                stage="summarize",
                batch_index=batch_index,
                interaction_ids=tuple(item.id for item in batch),
                method=(
                    "summarize_interaction per canonical member; content-addressed "
                    "interaction fingerprint; LLMClient cache; sources="
                    + ",".join(sources)
                ),
                output=output,
                output_sha256=_json_digest(output),
                fallback_reason=(
                    "one or more deterministic summary fallbacks"
                    if "fallback" in sources
                    else None
                ),
            )
        )
    return tuple(summaries), tuple(audits)


def _label_request(
    batch: Sequence[InteractionSummary],
    taxonomy: Taxonomy,
    *,
    batch_index: int,
    seed: int,
) -> LLMRequest:
    labels = [
        {
            "id": label.id,
            "name": label.name,
            "description": label.description,
        }
        for label in sorted(taxonomy.labels, key=lambda item: item.id)
    ]
    sample = [
        {"interaction_id": summary.interaction_id, "summary": summary.text}
        for summary in batch
    ]
    return LLMRequest(
        prompt=(
            "Weak-label each interaction for classifier distillation. Return only a "
            "JSON array with exactly one object per input, in input order. Each object "
            "must contain exactly interaction_id and label_id. Copy interaction_id "
            "verbatim and use only an exact taxonomy id; do not invent, merge, rename, "
            "or omit labels. These are weak training labels, not human truth.\n"
            + json.dumps(
                {"taxonomy": labels, "sample": sample},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        ),
        system_prompt="Output valid JSON only. Do not include prose or personal data.",
        seed=seed,
        temperature=0,
        max_output_tokens=max(256, len(batch) * 48),
        metadata={
            "stage": "weak_label",
            "batch_index": batch_index,
            "batch_size": len(batch),
            "taxonomy_hash": _json_digest(taxonomy.model_dump(mode="json")),
        },
    )


def _parse_weak_labels(
    text: str,
    batch: Sequence[InteractionSummary],
    taxonomy: Taxonomy,
) -> tuple[tuple[str, str], ...] | None:
    try:
        raw = json.loads(text)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if not isinstance(raw, list) or len(raw) != len(batch):
        return None
    expected_ids = tuple(item.interaction_id for item in batch)
    taxonomy_ids = {label.id for label in taxonomy.labels}
    parsed: list[tuple[str, str]] = []
    for expected_id, value in zip(expected_ids, raw, strict=True):
        if not isinstance(value, dict) or set(value) != _WEAK_LABEL_KEYS:
            return None
        interaction_id = value.get("interaction_id")
        label_id = value.get("label_id")
        if (
            not isinstance(interaction_id, str)
            or not isinstance(label_id, str)
            or interaction_id != expected_id
            or label_id not in taxonomy_ids
        ):
            return None
        parsed.append((interaction_id, label_id))
    return tuple(parsed)


def _tokens(value: str) -> frozenset[str]:
    return frozenset(_TOKEN_PATTERN.findall(value.casefold()))


def _deterministic_label(summary: InteractionSummary, taxonomy: Taxonomy) -> str:
    """Choose only among derived IDs with transparent, deterministic scoring."""

    summary_tokens = _tokens(summary.text)
    scored: list[tuple[int, int, str]] = []
    for label in taxonomy.labels:
        label_tokens = _tokens(f"{label.id} {label.name} {label.description}")
        overlap = len(summary_tokens & label_tokens)
        phrase = int(label.name.casefold() in summary.text.casefold())
        scored.append((phrase, overlap, label.id))
    best_phrase = max(item[0] for item in scored)
    best_overlap = max(item[1] for item in scored if item[0] == best_phrase)
    if best_phrase or best_overlap:
        return min(
            item[2]
            for item in scored
            if item[0] == best_phrase and item[1] == best_overlap
        )
    if any(label.id == "other_support" for label in taxonomy.labels):
        return "other_support"
    return min(taxonomy.labels, key=lambda item: (-item.support, item.id)).id


def _fallback_batch(
    batch: Sequence[InteractionSummary], taxonomy: Taxonomy
) -> tuple[tuple[str, str], ...]:
    return tuple(
        (summary.interaction_id, _deterministic_label(summary, taxonomy))
        for summary in batch
    )


def _weak_label_sample(
    summaries: Sequence[InteractionSummary],
    taxonomy: Taxonomy,
    *,
    llm: LLMClient | None,
    seed: int,
    batch_size: int,
    redactor: Redactor,
    malformed_labels: Literal["fallback", "raise"],
) -> tuple[tuple[WeakLabel, ...], tuple[DerivationBatchAudit, ...]]:
    labels: list[WeakLabel] = []
    audits: list[DerivationBatchAudit] = []
    for batch_index, offset in enumerate(range(0, len(summaries), batch_size)):
        batch = tuple(summaries[offset : offset + batch_size])
        model_output: str | None = None
        fallback_reason: str | None = None
        source: WeakLabelSource
        parsed: tuple[tuple[str, str], ...] | None = None

        if llm is None:
            fallback_reason = "no LLM client configured"
            source = "deterministic_fallback"
        else:
            try:
                result = llm.generate(
                    _label_request(batch, taxonomy, batch_index=batch_index, seed=seed)
                )
            except Exception as exc:
                fallback_reason = f"guarded LLM error: {type(exc).__name__}"
                source = "deterministic_fallback"
            else:
                # LLMClient already sanitizes both provider and cache output;
                # rescan before retaining it in the audit record.
                model_output = redactor.redact(result.text).text
                parsed = _parse_weak_labels(model_output, batch, taxonomy)
                if parsed is None:
                    if malformed_labels == "raise":
                        raise ValueError(
                            f"weak-label batch {batch_index} returned malformed labels"
                        )
                    fallback_reason = (
                        "malformed output: expected one in-order assignment per member "
                        "using exact taxonomy IDs"
                    )
                    source = "deterministic_fallback"
                else:
                    source = (
                        "llm_fallback" if result.source == "fallback" else result.source
                    )

        if parsed is None:
            parsed = _fallback_batch(batch, taxonomy)

        batch_labels = tuple(
            WeakLabel(interaction_id=interaction_id, label_id=label_id, source=source)
            for interaction_id, label_id in parsed
        )
        labels.extend(batch_labels)
        output = tuple(
            json.dumps(
                item.model_dump(mode="json"),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            for item in batch_labels
        )
        audits.append(
            DerivationBatchAudit(
                stage="weak_label",
                batch_index=batch_index,
                interaction_ids=tuple(item.interaction_id for item in batch),
                method=(
                    "strict guarded LLM assignment to exact derived taxonomy IDs"
                    if source != "deterministic_fallback"
                    else (
                        "deterministic taxonomy-only lexical overlap fallback; "
                        "support-prior tie fallback"
                    )
                ),
                output=output,
                output_sha256=_json_digest(output),
                model_output=model_output,
                model_output_sha256=(
                    _json_digest(model_output) if model_output is not None else None
                ),
                fallback_reason=fallback_reason,
            )
        )
    return tuple(labels), tuple(audits)


def _classification_text(interaction: Interaction) -> str:
    customer_turns = [
        " ".join(message.text.split())
        for message in interaction.messages
        if message.author == "customer" and message.text.strip()
    ]
    return "\n".join(customer_turns) if customer_turns else "No customer text provided."


def run_derivation(
    interactions: Iterable[Interaction],
    *,
    embedder: TextEmbedder,
    llm: LLMClient | None = None,
    sample_size: int | None = None,
    summary_batch_size: int = 32,
    taxonomy_batch_size: int = 50,
    label_batch_size: int = 32,
    max_labels: int = 25,
    test_size: float = 0.25,
    seed: int = 17,
    malformed_labels: Literal["fallback", "raise"] = "fallback",
    detector_minimum_support: int = 2,
    redactor: Redactor | None = None,
) -> DerivationRun:
    """Derive a weak taxonomy/classifier and predict the complete corpus.

    The sample is content-addressed and independent of input order.  LLM labels
    are accepted only when every assignment is present, in deterministic order,
    and uses an exact taxonomy ID.  They remain weak labels in every output.
    """

    if llm is not None and type(llm) is not LLMClient:
        raise TypeError("llm must be a concrete LLMClient instance")
    if llm is not None and (
        type(llm.redactor) is not Redactor or not llm.redactor.boundary_safe
    ):
        raise ValueError("LLMClient must retain its mandatory concrete Redactor")
    if type(seed) is not int or seed < 0:
        raise ValueError("seed must be non-negative")
    if any(
        type(size) is not int or size < 1
        for size in (summary_batch_size, taxonomy_batch_size, label_batch_size)
    ):
        raise ValueError("all derivation batch sizes must be positive")
    if malformed_labels not in {"fallback", "raise"}:
        raise ValueError("malformed_labels must be 'fallback' or 'raise'")
    if type(detector_minimum_support) is not int or detector_minimum_support <= 0:
        raise ValueError("detector_minimum_support must be a positive integer")
    active_redactor = _validated_redactor(redactor)
    corpus = _validated_corpus(interactions, redactor=active_redactor)
    if sample_size is not None and type(sample_size) is not int:
        raise TypeError("sample_size must be an integer or None")
    selected_size = len(corpus) if sample_size is None else sample_size
    if selected_size < 8:
        raise ValueError("derivation sample_size must be at least eight")
    if selected_size > len(corpus):
        raise ValueError("derivation sample_size cannot exceed corpus size")

    sample = _sample_corpus(corpus, sample_size=selected_size, seed=seed)
    summaries, summary_audits = _summarize_sample(
        sample,
        llm=llm,
        seed=seed,
        batch_size=summary_batch_size,
        redactor=active_redactor,
    )
    taxonomy = build_taxonomy(
        summaries,
        llm=llm,
        max_labels=max_labels,
        seed=seed,
        batch_size=taxonomy_batch_size,
        redactor=active_redactor,
    )
    weak_labels, label_audits = _weak_label_sample(
        summaries,
        taxonomy,
        llm=llm,
        seed=seed,
        batch_size=label_batch_size,
        redactor=active_redactor,
        malformed_labels=malformed_labels,
    )
    label_counts = Counter(item.label_id for item in weak_labels)
    if len(label_counts) < 2 or min(label_counts.values()) < 2:
        raise ValueError(
            "weak-label sample cannot support distillation: at least two classes "
            "and two members per class are required"
        )

    corpus_by_id = {item.id: item for item in corpus}
    training_texts = tuple(
        _classification_text(corpus_by_id[item.interaction_id]) for item in weak_labels
    )
    classifier = DistilledClassifier.fit(
        training_texts,
        tuple(item.label_id for item in weak_labels),
        embedder=embedder,
        test_size=test_size,
        seed=seed,
        redactor=active_redactor,
    )

    full_texts = tuple(_classification_text(item) for item in corpus)
    predicted_labels = classifier.predict(full_texts)
    probabilities = classifier.predict_proba(full_texts)
    class_indexes = {label: index for index, label in enumerate(classifier.labels)}
    predictions = tuple(
        CorpusPrediction(
            interaction_id=interaction.id,
            label_id=label_id,
            model_score=float(probabilities[index, class_indexes[label_id]]),
        )
        for index, (interaction, label_id) in enumerate(
            zip(corpus, predicted_labels, strict=True)
        )
    )
    members_by_label: dict[str, list[Interaction]] = {
        label.id: [] for label in taxonomy.labels
    }
    for prediction in predictions:
        members_by_label[prediction.label_id].append(
            corpus_by_id[prediction.interaction_id]
        )
    detector_outcomes = derive_detector_outcomes(
        taxonomy,
        members_by_label=members_by_label,
        minimum_support=detector_minimum_support,
    )
    audit = DerivationAudit(
        corpus_size=len(corpus),
        sample_size=len(sample),
        seed=seed,
        sample_interaction_ids=tuple(item.id for item in sample),
        summary_batches=summary_audits,
        summaries=summaries,
        taxonomy=taxonomy,
        weak_label_batches=label_audits,
        weak_labels=weak_labels,
        distillation_metrics=classifier.metrics,
        predictions=predictions,
        detector_outcomes=detector_outcomes,
    )
    return DerivationRun(classifier=classifier, audit=audit)


__all__ = [
    "CorpusPrediction",
    "DerivationAudit",
    "DerivationBatchAudit",
    "DerivationRun",
    "WeakLabel",
    "WeakLabelSource",
    "run_derivation",
]

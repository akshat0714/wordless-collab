"""Semantic reranking for evidence-generated hypotheses."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta
import math
from typing import Any, Protocol, runtime_checkable

import numpy as np
from numpy.typing import NDArray
from pydantic import ConfigDict, Field

from wordless.core.redact import Redactor
from wordless.pipeline.candidates import Hypothesis
from wordless.pipeline.concepts import (
    concept_prototypes,
    repair_fragment_for_concept,
)


MAX_CANDIDATES = 3


@runtime_checkable
class EmbeddingService(Protocol):
    def encode(self, texts: Sequence[str]) -> NDArray[np.float32]: ...


class Candidate(Hypothesis):
    """A hypothesis with an auditable score decomposition."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    cosine_similarity: float = Field(ge=-1.0, le=1.0)
    recency_boost: float = Field(ge=0.0, le=0.5)
    score: float
    rank: int = Field(ge=1, le=MAX_CANDIDATES)

    @property
    def final_score(self) -> float:
        return self.score

    @property
    def semantic_similarity(self) -> float:
        return self.cosine_similarity


def cosine_similarity(left: Any, right: Any) -> float:
    """Return finite cosine similarity, treating a zero vector as no signal."""

    left_vector = np.asarray(left, dtype=np.float64)
    right_vector = np.asarray(right, dtype=np.float64)
    if left_vector.ndim != 1 or right_vector.ndim != 1:
        raise ValueError("cosine inputs must be one-dimensional")
    if left_vector.shape != right_vector.shape or left_vector.size == 0:
        raise ValueError("cosine inputs must have the same non-zero dimension")
    if not np.isfinite(left_vector).all() or not np.isfinite(right_vector).all():
        raise ValueError("cosine inputs must contain only finite values")
    denominator = float(np.linalg.norm(left_vector) * np.linalg.norm(right_vector))
    if denominator == 0.0:
        return 0.0
    value = float(np.dot(left_vector, right_vector) / denominator)
    # Floating-point accumulation can exceed the mathematical range by an ulp.
    return max(-1.0, min(1.0, value))


def recency_boost(hypothesis: Hypothesis, *, as_of: datetime) -> float:
    """Score the newest cited fact using the specification's two time bands."""

    try:
        age = as_of - hypothesis.most_recent_evidence_at
    except TypeError as exc:
        raise ValueError("as_of and evidence timestamps must use consistent timezone awareness") from exc
    if age < timedelta(0):
        raise ValueError("hypothesis evidence cannot occur after as_of")
    if age <= timedelta(hours=72):
        return 0.5
    if age <= timedelta(days=7):
        return 0.25
    return 0.0


def _encode(embedder: Any, texts: Sequence[str]) -> NDArray[np.float64]:
    if hasattr(embedder, "encode"):
        raw = embedder.encode(texts)
    elif callable(embedder):
        raw = embedder(texts)
    else:
        raise TypeError("embedder must provide encode(texts) or be callable")
    matrix = np.asarray(raw, dtype=np.float64)
    if matrix.ndim == 1 and len(texts) == 1:
        matrix = matrix.reshape(1, -1)
    if matrix.ndim != 2 or matrix.shape[0] != len(texts) or matrix.shape[1] == 0:
        raise ValueError("embedder returned an invalid matrix shape")
    if not np.isfinite(matrix).all():
        raise ValueError("embedder returned non-finite values")
    return matrix


def _validated_redactor(redactor: Redactor | None) -> Redactor:
    if redactor is not None and type(redactor) is not Redactor:
        raise TypeError("redactor must be a concrete Redactor instance")
    active = redactor or Redactor()
    if not active.boundary_safe:
        raise ValueError("reranking requires the mandatory pinned redaction policy")
    return active


def _redacted_hypothesis(
    hypothesis: Hypothesis,
    *,
    redactor: Redactor,
) -> Hypothesis:
    if type(hypothesis) is not Hypothesis:
        raise TypeError("hypotheses must contain concrete Hypothesis instances")
    canonical = Hypothesis.model_validate(
        hypothesis.model_dump(mode="python", round_trip=True),
        strict=True,
    )
    payload = canonical.model_dump(mode="python", round_trip=True)
    payload["title"] = redactor.redact(canonical.title).text
    payload["detail"] = redactor.redact(canonical.detail).text
    payload["variants"] = tuple(
        redactor.redact(value).text for value in canonical.variants
    )
    return Hypothesis.model_validate(payload, strict=True)


def rerank_hypotheses(
    fragment: str,
    hypotheses: Sequence[Hypothesis],
    *,
    embedder: EmbeddingService | Any,
    as_of: datetime,
    limit: int = MAX_CANDIDATES,
    redactor: Redactor | None = None,
) -> tuple[Candidate, ...]:
    """Apply ``base + recency + 0.4*concept cosine`` and return at most three.

    Empty or whitespace-only fragments are valid.  In that path the embedder
    is never called and semantic similarity is exactly zero, so ranking relies
    only on evidence strength and recency.  Non-empty fragments are compared
    with each short intent prototype independently.  A bounded detector-local
    spelling repair supplies an additional query vector; this avoids diluting
    telegraphic or jumbled wording inside one concatenated intent sentence.
    """

    if not isinstance(fragment, str):
        raise TypeError("fragment must be a string")
    if limit <= 0:
        raise ValueError("limit must be greater than zero")
    hard_limit = min(limit, MAX_CANDIDATES)
    raw_values = tuple(hypotheses)
    if not raw_values:
        return ()
    active_redactor = _validated_redactor(redactor)
    values = tuple(
        _redacted_hypothesis(hypothesis, redactor=active_redactor)
        for hypothesis in raw_values
    )

    similarities = [0.0] * len(values)
    if fragment.strip():
        redacted_fragment = active_redactor.redact(fragment).text
        query_sets: list[tuple[str, ...]] = []
        prototype_sets: list[tuple[str, ...]] = []
        embedding_texts: list[str] = []

        def include(text: str) -> str:
            safe = active_redactor.redact(text).text
            if safe not in embedding_texts:
                embedding_texts.append(safe)
            return safe

        include(redacted_fragment)
        for hypothesis in values:
            repaired = repair_fragment_for_concept(
                redacted_fragment,
                hypothesis,
            )
            queries = tuple(
                dict.fromkeys(
                    include(text)
                    for text in (redacted_fragment, repaired.text)
                    if text.strip()
                )
            )
            prototypes = tuple(
                dict.fromkeys(
                    include(prototype)
                    for prototype in concept_prototypes(hypothesis)
                )
            )
            query_sets.append(queries)
            prototype_sets.append(prototypes)

        matrix = _encode(embedder, tuple(embedding_texts))
        vector_by_text = {
            text: matrix[index]
            for index, text in enumerate(embedding_texts)
        }
        similarities = [
            max(
                cosine_similarity(vector_by_text[query], vector_by_text[prototype])
                for query in queries
                for prototype in prototypes
            )
            for queries, prototypes in zip(
                query_sets,
                prototype_sets,
                strict=True,
            )
        ]

    scored: list[tuple[float, float, float, Hypothesis]] = []
    for hypothesis, similarity in zip(values, similarities, strict=True):
        boost = recency_boost(hypothesis, as_of=as_of)
        final = float(hypothesis.base_score + boost + 0.4 * similarity)
        if not math.isfinite(final):
            raise ValueError("candidate score must be finite")
        scored.append((final, boost, similarity, hypothesis))

    scored.sort(key=lambda item: (-item[0], item[3].detector_id, item[3].title))
    candidates: list[Candidate] = []
    for rank, (final, boost, similarity, hypothesis) in enumerate(
        scored[:hard_limit], start=1
    ):
        candidates.append(
            Candidate(
                **hypothesis.model_dump(),
                cosine_similarity=similarity,
                recency_boost=boost,
                score=final,
                rank=rank,
            )
        )
    return tuple(candidates)


rerank = rerank_hypotheses


__all__ = [
    "Candidate",
    "EmbeddingService",
    "MAX_CANDIDATES",
    "cosine_similarity",
    "recency_boost",
    "rerank",
    "rerank_hypotheses",
]

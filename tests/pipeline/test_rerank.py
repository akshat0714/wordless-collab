from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from wordless.core.models import StateFact
from wordless.pipeline.candidates import DEFAULT_DETECTORS, Hypothesis
from wordless.pipeline.rerank import rerank_hypotheses


NOW = datetime(2026, 7, 20, 12, tzinfo=timezone.utc)


class FixedEmbedder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []

    def encode(self, texts: tuple[str, ...]) -> np.ndarray:
        self.calls.append(tuple(texts))
        vectors = {
            "fragment": [1.0, 0.0],
            "first.": [1.0, 0.0],
            "second.": [0.0, 1.0],
            "third.": [-1.0, 0.0],
            "fourth.": [0.5, 0.5],
        }
        return np.asarray([vectors[text] for text in texts], dtype=np.float32)


def _hypothesis(identifier: str, *, base: float, age: timedelta) -> Hypothesis:
    return Hypothesis(
        detector_id=identifier,
        title=identifier,
        detail="Concrete evidence.",
        evidence=(
            StateFact(
                source="fixture",
                kind="fact",
                occurred_at=NOW - age,
                fields={"id": identifier},
                provenance="exported",
            ),
        ),
        base_score=base,
    )


def test_formula_and_hard_top_three_cap() -> None:
    embedder = FixedEmbedder()
    hypotheses = (
        _hypothesis("first", base=0.5, age=timedelta(hours=1)),
        _hypothesis("second", base=0.9, age=timedelta(days=4)),
        _hypothesis("third", base=0.9, age=timedelta(days=9)),
        _hypothesis("fourth", base=0.2, age=timedelta(hours=1)),
    )

    candidates = rerank_hypotheses("fragment", hypotheses, embedder=embedder, as_of=NOW, limit=99)

    assert len(candidates) == 3
    assert candidates[0].detector_id == "first"
    assert candidates[0].score == 0.5 + 0.5 + 0.4 * 1.0
    second = next(candidate for candidate in candidates if candidate.detector_id == "second")
    assert second.score == 0.9 + 0.25 + 0.4 * 0.0
    assert [candidate.rank for candidate in candidates] == [1, 2, 3]


def test_empty_fragment_uses_evidence_only_and_never_calls_embedder() -> None:
    embedder = FixedEmbedder()
    candidates = rerank_hypotheses(
        "   ",
        (_hypothesis("first", base=0.5, age=timedelta(hours=1)),),
        embedder=embedder,
        as_of=NOW,
    )

    assert embedder.calls == []
    assert candidates[0].cosine_similarity == 0.0
    assert candidates[0].score == 1.0


def test_every_embedding_string_is_rescanned_at_rerank_boundary() -> None:
    class CapturingEmbedder:
        def __init__(self) -> None:
            self.calls: list[tuple[str, ...]] = []

        def encode(self, texts: tuple[str, ...]) -> np.ndarray:
            self.calls.append(tuple(texts))
            return np.tile(
                np.asarray([[1.0, 0.0]], dtype=np.float32),
                (len(texts), 1),
            )

    hypothesis = _hypothesis("first", base=0.5, age=timedelta(hours=1)).model_copy(
        update={
            "title": "Email alice@example.com now",
            "detail": "Call +1 415-555-0123",
            "variants": ("Ask for alice@example.com",),
        }
    )
    embedder = CapturingEmbedder()

    candidates = rerank_hypotheses(
        "Contact bob@example.com",
        (hypothesis,),
        embedder=embedder,
        as_of=NOW,
    )
    serialized = " ".join((*embedder.calls[0], candidates[0].title, candidates[0].detail))

    assert "alice@example.com" not in serialized
    assert "bob@example.com" not in serialized
    assert "415-555-0123" not in serialized
    assert "<EMAIL_ADDRESS>" in serialized
    assert "<PHONE_NUMBER>" in serialized


class ConceptEmbedder:
    """Small deterministic stand-in for concept-vector behavior."""

    def encode(self, texts: tuple[str, ...]) -> np.ndarray:
        vectors: list[list[float]] = []
        for value in texts:
            text = value.casefold()
            if any(
                phrase in text
                for phrase in (
                    "money twice",
                    "charged twice",
                    "money taken twice",
                    "paid two times",
                    "duplicate card charge",
                )
            ):
                vectors.append([1.0, 0.0, 0.0, 0.0])
            elif any(
                phrase in text
                for phrase in (
                    "not come",
                    "delivery is late",
                    "order has not arrived",
                    "package overdue",
                )
            ):
                vectors.append([0.0, 1.0, 0.0, 0.0])
            elif any(
                phrase in text
                for phrase in (
                    "thing box different",
                    "wrong item",
                    "order wrong thing",
                    "different product",
                    "not what i ordered",
                )
            ):
                vectors.append([0.0, 0.0, 1.0, 0.0])
            elif any(
                phrase in text
                for phrase in (
                    "cant in account",
                    "account is locked",
                    "cannot get in",
                    "login blocked",
                    "too many attempts",
                )
            ):
                vectors.append([0.0, 0.0, 0.0, 1.0])
            else:
                vectors.append([0.0, 0.0, 0.0, 0.0])
        return np.asarray(vectors, dtype=np.float32)


@pytest.mark.parametrize(
    "detector_id,fragment",
    (
        ("duplicate_charge", "mney twcie"),
        ("late_delivery", "pakg no com"),
        ("wrong_item", "thing box difrent"),
        ("account_lock", "cant in acount"),
    ),
)
def test_multi_prototype_vectors_embed_a_detector_local_repair(
    detector_id: str,
    fragment: str,
) -> None:
    detector = next(value for value in DEFAULT_DETECTORS if value.id == detector_id)
    hypothesis = Hypothesis(
        detector_id=detector.id,
        title=detector.title,
        detail="Confirmed fixture evidence.",
        evidence=(
            StateFact(
                source="fixture",
                kind="fact",
                occurred_at=NOW - timedelta(minutes=1),
                fields={"id": detector.id},
                provenance="exported",
            ),
        ),
        base_score=detector.base_score,
        variants=detector.variants,
    )

    candidate = rerank_hypotheses(
        fragment,
        (hypothesis,),
        embedder=ConceptEmbedder(),
        as_of=NOW,
    )[0]

    assert candidate.detector_id == detector_id
    assert candidate.cosine_similarity == 1.0

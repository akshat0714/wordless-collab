"""Stage 3: deterministic embedding + logistic-regression distillation."""

from __future__ import annotations

from collections import Counter
from typing import Protocol, Sequence

import numpy as np
from numpy.typing import NDArray
from pydantic import BaseModel, ConfigDict, Field
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score
from sklearn.model_selection import train_test_split

from wordless.core.redact import Redactor


class TextEmbedder(Protocol):
    def encode(self, texts: Sequence[str]) -> NDArray[np.float32]: ...


def _l2_normalize(matrix: NDArray[np.float32]) -> NDArray[np.float32]:
    """Return row-normalized embeddings while preserving all-zero rows."""

    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return np.divide(
        matrix,
        norms,
        out=np.zeros_like(matrix, dtype=np.float32),
        where=norms > 0,
    )


def _encode_normalized(
    embedder: TextEmbedder,
    texts: Sequence[str],
    *,
    redactor: Redactor,
) -> NDArray[np.float32]:
    if any(not isinstance(text, str) for text in texts):
        raise TypeError("every classifier input must be a string")
    safe_texts = tuple(redactor.redact(text).text for text in texts)
    matrix = np.asarray(embedder.encode(safe_texts), dtype=np.float32)
    if matrix.ndim != 2 or matrix.shape[0] != len(texts):
        raise ValueError("embedder returned an invalid matrix")
    if not np.isfinite(matrix).all():
        raise ValueError("embedder returned non-finite values")
    return _l2_normalize(matrix)


class DistillationMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    held_out_correct: int = Field(ge=0)
    held_out_n: int = Field(gt=0)
    held_out_accuracy: float = Field(ge=0, le=1)
    training_n: int = Field(gt=0)
    label_count: int = Field(gt=1)
    seed: int = Field(ge=0)
    method: str = "L2-normalized embeddings + multinomial logistic regression"


class DistilledClassifier:
    def __init__(
        self,
        estimator: LogisticRegression,
        embedder: TextEmbedder,
        labels: tuple[str, ...],
        metrics: DistillationMetrics,
        *,
        redactor: Redactor | None = None,
    ) -> None:
        if redactor is not None and type(redactor) is not Redactor:
            raise TypeError("redactor must be a concrete Redactor instance")
        if redactor is not None and not redactor.boundary_safe:
            raise ValueError("redactor must keep mandatory Presidio policy enabled")
        self.estimator = estimator
        self.embedder = embedder
        self.labels = labels
        self.metrics = metrics
        self.redactor = redactor or Redactor()
        if not self.redactor.boundary_safe:
            raise ValueError(
                "distillation requires the available mandatory pinned Presidio policy"
            )

    @classmethod
    def fit(
        cls,
        texts: Sequence[str],
        labels: Sequence[str],
        *,
        embedder: TextEmbedder,
        test_size: float = 0.25,
        seed: int = 17,
        redactor: Redactor | None = None,
    ) -> "DistilledClassifier":
        if len(texts) != len(labels) or len(texts) < 8:
            raise ValueError("distillation requires at least eight aligned texts and labels")
        counts = Counter(labels)
        if len(counts) < 2 or min(counts.values()) < 2:
            raise ValueError("distillation requires at least two examples for every label")
        if redactor is not None and type(redactor) is not Redactor:
            raise TypeError("redactor must be a concrete Redactor instance")
        if redactor is not None and not redactor.boundary_safe:
            raise ValueError("redactor must keep mandatory Presidio policy enabled")
        active_redactor = redactor or Redactor()
        if not active_redactor.boundary_safe:
            raise ValueError(
                "distillation requires the available mandatory pinned Presidio policy"
            )
        matrix = _encode_normalized(embedder, texts, redactor=active_redactor)
        indexes = np.arange(len(texts))
        train, test = train_test_split(
            indexes,
            test_size=test_size,
            random_state=seed,
            stratify=np.asarray(labels),
        )
        estimator = LogisticRegression(max_iter=1000, random_state=seed, solver="lbfgs")
        label_array = np.asarray(labels)
        estimator.fit(matrix[train], label_array[train])
        predictions = estimator.predict(matrix[test])
        correct = int(np.sum(predictions == label_array[test]))
        metrics = DistillationMetrics(
            held_out_correct=correct,
            held_out_n=len(test),
            held_out_accuracy=float(accuracy_score(label_array[test], predictions)),
            training_n=len(train),
            label_count=len(counts),
            seed=seed,
        )
        return cls(
            estimator,
            embedder,
            tuple(map(str, estimator.classes_)),
            metrics,
            redactor=active_redactor,
        )

    def predict(self, texts: Sequence[str]) -> tuple[str, ...]:
        matrix = _encode_normalized(self.embedder, texts, redactor=self.redactor)
        return tuple(map(str, self.estimator.predict(matrix)))

    def predict_proba(self, texts: Sequence[str]) -> NDArray[np.float64]:
        matrix = _encode_normalized(self.embedder, texts, redactor=self.redactor)
        return np.asarray(self.estimator.predict_proba(matrix), dtype=np.float64)


__all__ = ["DistillationMetrics", "DistilledClassifier", "TextEmbedder"]

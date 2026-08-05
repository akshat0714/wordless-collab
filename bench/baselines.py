"""Deterministic lexical and embedding rankers for Module 0.

Optional dependencies are imported only when their ranker is used.  Missing
packages or model files raise explicit availability errors; no ranker ever
substitutes fabricated scores or silently falls back to another method.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
import os
import random
import re
from typing import Any, Mapping, Sequence

from .pairs import TEXT_MODES, Target


_TOKEN_RE = re.compile(r"[^\W_]+(?:['\N{RIGHT SINGLE QUOTATION MARK}][^\W_]+)?", re.UNICODE)
REQUIRED_MODEL_ROLES = ("small", "strong_general", "instruction_tuned")


class RankerUnavailable(RuntimeError):
    """A method cannot run because its dependency or artifact is unavailable."""


class RankerConfigurationError(ValueError):
    """A ranker configuration cannot support an honest benchmark run."""


@dataclass(frozen=True)
class Ranking:
    """One candidate in a complete, deterministically ordered ranking."""

    rank: int
    target: str
    score: float

    def to_dict(self) -> dict[str, Any]:
        return {"rank": self.rank, "target": self.target, "score": self.score}


@dataclass(frozen=True)
class ModelSpec:
    """Configuration for one independently reported embedding method."""

    role: str
    model_id: str
    query_prefix: str = ""
    document_prefix: str = ""
    revision: str | None = None
    trust_remote_code: bool = False

    @property
    def method_id(self) -> str:
        role = re.sub(r"[^a-z0-9]+", "_", self.role.casefold()).strip("_")
        return f"embedding_{role}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "model_id": self.model_id,
            "query_prefix": self.query_prefix,
            "document_prefix": self.document_prefix,
            "revision": self.revision,
            "trust_remote_code": self.trust_remote_code,
        }


# These identifiers were verified for this build.  Environment variables and
# CLI flags may replace them, but every configured model is still validated by
# an actual SentenceTransformer load before it can produce a result.
DEFAULT_MODEL_SPECS = (
    ModelSpec(
        role="small",
        model_id="sentence-transformers/all-MiniLM-L6-v2",
        revision="1110a243fdf4706b3f48f1d95db1a4f5529b4d41",
    ),
    ModelSpec(
        role="strong_general",
        model_id="sentence-transformers/all-mpnet-base-v2",
        revision="e8c3b32edf5434bc2275fc9bab85f82640a19130",
    ),
    ModelSpec(
        role="instruction_tuned",
        model_id="intfloat/e5-base-v2",
        query_prefix="query: ",
        document_prefix="passage: ",
        revision="f52bf8ec8c7124536f0efb74aca902b2995e5bcd",
    ),
)


def tokenize(text: str) -> tuple[str, ...]:
    """Apply the shared Unicode, case-insensitive lexical tokenizer."""

    if not isinstance(text, str):
        raise TypeError("text must be a string")
    return tuple(match.group(0).casefold() for match in _TOKEN_RE.finditer(text))


def validate_model_specs(specs: Sequence[ModelSpec]) -> tuple[ModelSpec, ...]:
    """Validate roles and identifiers before expensive model loading starts."""

    normalized = tuple(specs)
    if len(normalized) < 3:
        raise RankerConfigurationError(
            "at least three embedding models must be configured: small, "
            "strong_general, and instruction_tuned"
        )
    roles = [spec.role for spec in normalized]
    duplicate_roles = sorted({role for role in roles if roles.count(role) > 1})
    if duplicate_roles:
        raise RankerConfigurationError(
            f"embedding model roles must be unique; duplicates: {', '.join(duplicate_roles)}"
        )
    missing = [role for role in REQUIRED_MODEL_ROLES if role not in roles]
    if missing:
        raise RankerConfigurationError(
            f"missing required embedding model roles: {', '.join(missing)}"
        )
    for spec in normalized:
        if not spec.role.strip() or spec.role != spec.role.strip():
            raise RankerConfigurationError("embedding model role must be trimmed and non-empty")
        if not spec.model_id.strip() or spec.model_id != spec.model_id.strip():
            raise RankerConfigurationError(
                f"model id for role {spec.role!r} must be trimmed and non-empty"
            )
        if any(character.isspace() for character in spec.model_id):
            raise RankerConfigurationError(
                f"model id for role {spec.role!r} must not contain whitespace"
            )
        if spec.model_id.startswith(("http://", "https://")):
            raise RankerConfigurationError(
                f"model id for role {spec.role!r} must be a registry id or local path, not a URL"
            )
        if spec.revision is not None and not spec.revision.strip():
            raise RankerConfigurationError(
                f"revision for role {spec.role!r} must be non-empty when provided"
            )
        if spec.revision is None:
            raise RankerConfigurationError(
                f"revision for role {spec.role!r} is required to pin model weights"
            )
        if not isinstance(spec.trust_remote_code, bool):
            raise RankerConfigurationError("trust_remote_code must be a boolean")
    return normalized


def configured_model_specs(environ: Mapping[str, str] | None = None) -> tuple[ModelSpec, ...]:
    """Return the three defaults with optional per-role environment overrides.

    Variables are ``WORDLESS_BENCH_MODEL_SMALL``,
    ``WORDLESS_BENCH_MODEL_STRONG_GENERAL``, and
    ``WORDLESS_BENCH_MODEL_INSTRUCTION_TUNED``.
    """

    values = os.environ if environ is None else environ
    result = []
    for spec in DEFAULT_MODEL_SPECS:
        key = f"WORDLESS_BENCH_MODEL_{spec.role.upper()}"
        revision_key = f"WORDLESS_BENCH_REVISION_{spec.role.upper()}"
        configured_id = values.get(key, spec.model_id)
        configured_revision = values.get(revision_key)
        if configured_revision is None and configured_id == spec.model_id:
            configured_revision = spec.revision
        result.append(
            ModelSpec(
                role=spec.role,
                model_id=configured_id,
                query_prefix=spec.query_prefix,
                document_prefix=spec.document_prefix,
                revision=configured_revision,
                trust_remote_code=spec.trust_remote_code,
            )
        )
    return validate_model_specs(result)


def _validate_candidates(candidates: Sequence[Target]) -> tuple[Target, ...]:
    result = tuple(candidates)
    if not result:
        raise ValueError("candidate pool must not be empty")
    ids = [candidate.target for candidate in result]
    duplicates = sorted({target for target in ids if ids.count(target) > 1})
    if duplicates:
        raise ValueError(f"candidate target ids must be unique: {', '.join(duplicates)}")
    return result


def _pool_key(candidates: Sequence[Target], text_mode: str) -> tuple[tuple[str, str], ...]:
    if text_mode not in TEXT_MODES:
        raise ValueError(f"unknown candidate text mode {text_mode!r}")
    return tuple((candidate.target, candidate.text(text_mode)) for candidate in candidates)


def _ordered_rankings(
    candidates: Sequence[Target], scores: Sequence[float]
) -> tuple[Ranking, ...]:
    if len(candidates) != len(scores):
        raise ValueError("candidate and score lengths differ")
    scored: list[tuple[str, float]] = []
    for candidate, raw_score in zip(candidates, scores):
        score = float(raw_score)
        if not math.isfinite(score):
            raise RuntimeError(
                f"ranker produced a non-finite score for target {candidate.target!r}"
            )
        scored.append((candidate.target, score))
    # Target id is the declared universal tiebreaker.  It makes rankings
    # independent of JSON catalog order and underlying sort implementations.
    scored.sort(key=lambda item: (-item[1], item[0]))
    return tuple(
        Ranking(rank=index, target=target, score=score)
        for index, (target, score) in enumerate(scored, start=1)
    )


class TokenOverlapRanker:
    """Raw unique-token intersection, the deliberately naive baseline."""

    method_id = "token_overlap"
    kind = "lexical"
    display_name = "Token overlap"

    def prepare(
        self,
        pools: Mapping[str, Sequence[Target]],
        *,
        text_mode: str = "description",
    ) -> None:
        for candidates in pools.values():
            _pool_key(_validate_candidates(candidates), text_mode)

    def rank(
        self,
        query: str,
        candidates: Sequence[Target],
        *,
        text_mode: str = "description",
    ) -> tuple[Ranking, ...]:
        pool = _validate_candidates(candidates)
        _pool_key(pool, text_mode)
        query_tokens = set(tokenize(query))
        scores = [
            float(len(query_tokens.intersection(tokenize(candidate.text(text_mode)))))
            for candidate in pool
        ]
        return _ordered_rankings(pool, scores)

    def metadata(self) -> dict[str, Any]:
        return {
            "method_id": self.method_id,
            "kind": self.kind,
            "display_name": self.display_name,
            "scoring": "count of unique case-folded Unicode tokens shared with candidate text",
            "tie_breaker": "target id ascending",
        }


class BM25Ranker:
    """BM25Okapi over the same candidate text exposed to every other method."""

    method_id = "bm25"
    kind = "lexical"
    display_name = "BM25"

    def __init__(self) -> None:
        self._indexes: dict[tuple[tuple[str, str], ...], Any] = {}

    @staticmethod
    def _bm25_class() -> Any:
        try:
            from rank_bm25 import BM25Okapi
        except (ImportError, ModuleNotFoundError) as exc:
            raise RankerUnavailable(
                "BM25 unavailable: install the required 'rank_bm25' package"
            ) from exc
        return BM25Okapi

    def _prepare_pool(self, candidates: Sequence[Target], text_mode: str) -> Any:
        pool = _validate_candidates(candidates)
        key = _pool_key(pool, text_mode)
        if key not in self._indexes:
            bm25_class = self._bm25_class()
            corpus = [list(tokenize(candidate.text(text_mode))) for candidate in pool]
            self._indexes[key] = bm25_class(corpus)
        return self._indexes[key]

    def prepare(
        self,
        pools: Mapping[str, Sequence[Target]],
        *,
        text_mode: str = "description",
    ) -> None:
        # Import even for an empty mapping so dependency availability is never
        # inferred from a method that did not execute.
        self._bm25_class()
        for candidates in pools.values():
            self._prepare_pool(candidates, text_mode)

    def rank(
        self,
        query: str,
        candidates: Sequence[Target],
        *,
        text_mode: str = "description",
    ) -> tuple[Ranking, ...]:
        pool = _validate_candidates(candidates)
        index = self._prepare_pool(pool, text_mode)
        scores = index.get_scores(list(tokenize(query)))
        return _ordered_rankings(pool, scores)

    def metadata(self) -> dict[str, Any]:
        return {
            "method_id": self.method_id,
            "kind": self.kind,
            "display_name": self.display_name,
            "scoring": "rank_bm25.BM25Okapi over shared tokenization",
            "tie_breaker": "target id ascending",
            "dependency": "rank_bm25",
        }


def seed_everything(seed: int) -> None:
    """Seed supported RNGs and request deterministic tensor operations."""

    if seed < 0:
        raise ValueError("seed must be non-negative")
    random.seed(seed)
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    try:
        import numpy as np

        np.random.seed(seed)
    except (ImportError, ModuleNotFoundError):
        pass
    try:
        import torch

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
        if hasattr(torch, "use_deterministic_algorithms"):
            torch.use_deterministic_algorithms(True, warn_only=True)
        if hasattr(torch.backends, "cudnn"):
            torch.backends.cudnn.benchmark = False
            torch.backends.cudnn.deterministic = True
    except (ImportError, ModuleNotFoundError):
        pass


class EmbeddingRanker:
    """Cosine-similarity ranker backed by one configured SentenceTransformer."""

    kind = "semantic"

    def __init__(
        self,
        model: ModelSpec,
        *,
        seed: int = 17,
        batch_size: int = 32,
        device: str | None = None,
        local_files_only: bool = False,
    ) -> None:
        validate_model_specs(
            (
                model,
                *(
                    default
                    for default in DEFAULT_MODEL_SPECS
                    if default.role != model.role
                ),
            )
        ) if model.role in REQUIRED_MODEL_ROLES else self._validate_single(model)
        if batch_size < 1:
            raise RankerConfigurationError("batch_size must be at least 1")
        self.spec = model
        self.method_id = model.method_id
        self.display_name = f"Embedding ({model.role})"
        self.seed = seed
        self.batch_size = batch_size
        self.device = device
        self.local_files_only = local_files_only
        self._model: Any | None = None
        self._embeddings: dict[tuple[tuple[str, str], ...], Any] = {}

    @staticmethod
    def _validate_single(model: ModelSpec) -> None:
        if not model.role.strip() or not model.model_id.strip():
            raise RankerConfigurationError("embedding role and model id must be non-empty")
        if any(character.isspace() for character in model.model_id):
            raise RankerConfigurationError("embedding model id must not contain whitespace")

    def _load_model(self) -> Any:
        if self._model is not None:
            return self._model
        seed_everything(self.seed)
        try:
            from sentence_transformers import SentenceTransformer
        except (ImportError, ModuleNotFoundError) as exc:
            raise RankerUnavailable(
                "embedding method unavailable: install the required "
                "'sentence-transformers' package"
            ) from exc
        kwargs: dict[str, Any] = {
            "trust_remote_code": self.spec.trust_remote_code,
            "local_files_only": self.local_files_only,
        }
        if self.spec.revision is not None:
            kwargs["revision"] = self.spec.revision
        if self.device is not None:
            kwargs["device"] = self.device
        try:
            self._model = SentenceTransformer(self.spec.model_id, **kwargs)
            self._model.eval()
        except Exception as exc:
            mode = "local cache" if self.local_files_only else "configured source or cache"
            raise RankerUnavailable(
                f"embedding model {self.spec.model_id!r} ({self.spec.role}) could not "
                f"be loaded from the {mode}: {type(exc).__name__}: {exc}"
            ) from exc
        return self._model

    def _encode(self, texts: Sequence[str]) -> Any:
        model = self._load_model()
        seed_everything(self.seed)
        try:
            return model.encode(
                list(texts),
                batch_size=self.batch_size,
                show_progress_bar=False,
                convert_to_numpy=True,
                normalize_embeddings=True,
            )
        except Exception as exc:
            raise RankerUnavailable(
                f"embedding model {self.spec.model_id!r} failed during encoding: "
                f"{type(exc).__name__}: {exc}"
            ) from exc

    def _prepare_pool(self, candidates: Sequence[Target], text_mode: str) -> Any:
        pool = _validate_candidates(candidates)
        key = _pool_key(pool, text_mode)
        if key not in self._embeddings:
            documents = [
                self.spec.document_prefix + candidate.text(text_mode) for candidate in pool
            ]
            self._embeddings[key] = self._encode(documents)
        return self._embeddings[key]

    def prepare(
        self,
        pools: Mapping[str, Sequence[Target]],
        *,
        text_mode: str = "description",
    ) -> None:
        self._load_model()
        for domain in sorted(pools):
            self._prepare_pool(pools[domain], text_mode)

    def rank(
        self,
        query: str,
        candidates: Sequence[Target],
        *,
        text_mode: str = "description",
    ) -> tuple[Ranking, ...]:
        pool = _validate_candidates(candidates)
        documents = self._prepare_pool(pool, text_mode)
        query_vector = self._encode([self.spec.query_prefix + query])[0]
        scores = [float(document @ query_vector) for document in documents]
        return _ordered_rankings(pool, scores)

    def metadata(self) -> dict[str, Any]:
        return {
            "method_id": self.method_id,
            "kind": self.kind,
            "display_name": self.display_name,
            "scoring": "cosine similarity of L2-normalized SentenceTransformer embeddings",
            "tie_breaker": "target id ascending",
            "model": self.spec.to_dict(),
            "seed": self.seed,
            "batch_size": self.batch_size,
            "device": self.device or "auto",
            "local_files_only": self.local_files_only,
        }


__all__ = [
    "BM25Ranker",
    "DEFAULT_MODEL_SPECS",
    "EmbeddingRanker",
    "ModelSpec",
    "REQUIRED_MODEL_ROLES",
    "RankerConfigurationError",
    "RankerUnavailable",
    "Ranking",
    "TokenOverlapRanker",
    "configured_model_specs",
    "seed_everything",
    "tokenize",
    "validate_model_specs",
]

"""Deterministic SentenceTransformer embeddings with an offline disk cache."""

from __future__ import annotations

from collections.abc import Callable, Sequence
import hashlib
import json
from pathlib import Path
import random
import tempfile
import threading
from typing import Any

import numpy as np
from numpy.typing import NDArray


_CACHE_SCHEMA_VERSION = 2


class EmbeddingUnavailableError(RuntimeError):
    """A requested embedding is neither cached nor locally computable."""


class EmbeddingCacheError(RuntimeError):
    """Cached vectors for one configured model are internally inconsistent."""


def _seed_everything(seed: int) -> None:
    if seed < 0:
        raise ValueError("seed must be non-negative")
    random.seed(seed)
    np.random.seed(seed)
    try:
        import torch
    except (ImportError, ModuleNotFoundError):
        return
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    try:
        torch.use_deterministic_algorithms(True, warn_only=True)
    except (AttributeError, RuntimeError):
        pass


class SentenceTransformerEmbedder:
    """Lazy, reproducible embedding service with per-text cache entries.

    No model identifier is embedded in the source.  The caller must supply a
    verified registry ID or local path.  ``offline=True`` passes
    ``local_files_only`` to SentenceTransformer; already-cached vectors can be
    read without importing or constructing SentenceTransformer at all.
    """

    def __init__(
        self,
        *,
        model_id: str,
        cache_dir: str | Path = Path(".wordless/cache/embeddings"),
        revision: str | None = None,
        offline: bool = False,
        normalize_embeddings: bool = True,
        batch_size: int = 32,
        seed: int = 0,
        device: str = "cpu",
        model_factory: Callable[..., Any] | None = None,
    ) -> None:
        if not model_id or model_id != model_id.strip():
            raise ValueError("model_id must be trimmed and non-empty")
        if any(character.isspace() for character in model_id):
            raise ValueError("model_id must not contain whitespace")
        if revision is not None and (not revision or revision != revision.strip()):
            raise ValueError("revision must be trimmed and non-empty when supplied")
        if batch_size <= 0:
            raise ValueError("batch_size must be greater than zero")
        if seed < 0:
            raise ValueError("seed must be non-negative")
        if not device.strip():
            raise ValueError("device must be non-empty")
        self.model_id = model_id
        self.revision = revision
        self.offline = offline
        self.normalize_embeddings = normalize_embeddings
        self.batch_size = batch_size
        self.seed = seed
        self.device = device
        self.cache_dir = Path(cache_dir)
        self._vectors_dir = self.cache_dir / "vectors"
        self._models_dir = self.cache_dir / "models"
        self._model_factory = model_factory
        self._model: Any | None = None
        self._model_lock = threading.Lock()
        self._cache_lock = threading.Lock()

    def _vector_key(self, text: str) -> str:
        value = json.dumps(
            {
                "model_id": self.model_id,
                "normalize_embeddings": self.normalize_embeddings,
                "revision": self.revision,
                "seed": self.seed,
                "device": self.device,
                "batch_size": self.batch_size,
                "schema_version": _CACHE_SCHEMA_VERSION,
                "text": text,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(value).hexdigest()

    def _vector_path(self, key: str) -> Path:
        return self._vectors_dir / key[:2] / f"{key}.npy"

    def _read_vector(self, key: str) -> NDArray[np.float32] | None:
        try:
            raw = np.load(self._vector_path(key), allow_pickle=False)
        except (OSError, ValueError, EOFError):
            return None
        vector = np.asarray(raw, dtype=np.float32)
        if vector.ndim != 1 or vector.size == 0 or not np.isfinite(vector).all():
            return None
        return vector

    def _write_vector(self, key: str, vector: NDArray[np.float32]) -> None:
        path = self._vector_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=path.parent,
                prefix=f".{key}.",
                suffix=".npy",
                delete=False,
            ) as temporary:
                np.save(temporary, vector, allow_pickle=False)
                temporary.flush()
                temporary_name = temporary.name
            Path(temporary_name).replace(path)
        finally:
            if temporary_name is not None:
                try:
                    Path(temporary_name).unlink(missing_ok=True)
                except OSError:
                    pass

    def _load_model(self) -> Any:
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is not None:
                return self._model
            _seed_everything(self.seed)
            factory = self._model_factory
            if factory is None:
                try:
                    from sentence_transformers import SentenceTransformer
                except (ImportError, ModuleNotFoundError) as exc:
                    raise EmbeddingUnavailableError(
                        "sentence-transformers is required for uncached embeddings"
                    ) from exc
                factory = SentenceTransformer
            kwargs: dict[str, Any] = {
                "cache_folder": str(self._models_dir),
                "device": self.device,
                "local_files_only": self.offline,
                "trust_remote_code": False,
            }
            if self.revision is not None:
                kwargs["revision"] = self.revision
            try:
                model = factory(self.model_id, **kwargs)
            except Exception as exc:
                mode = "offline/local" if self.offline else "configured"
                raise EmbeddingUnavailableError(
                    f"could not load {mode} embedding model {self.model_id!r}"
                ) from exc
            if hasattr(model, "eval"):
                model.eval()
            self._model = model
            return model

    def validate_model_available(self) -> None:
        """Eagerly resolve the configured artifact for startup validation.

        Normal embedding calls stay lazy, but application startup can invoke
        this method to prove that the configured ID and immutable revision are
        loadable in the selected online/offline mode before serving traffic.
        """

        self._load_model()

    def _compute(self, texts: Sequence[str]) -> NDArray[np.float32]:
        model = self._load_model()
        _seed_everything(self.seed)
        try:
            raw = model.encode(
                list(texts),
                batch_size=self.batch_size,
                show_progress_bar=False,
                convert_to_numpy=True,
                normalize_embeddings=False,
            )
        except Exception as exc:
            raise EmbeddingUnavailableError(
                f"embedding model {self.model_id!r} could not encode input"
            ) from exc
        matrix = np.asarray(raw, dtype=np.float32)
        if matrix.ndim == 1 and len(texts) == 1:
            matrix = matrix.reshape(1, -1)
        if matrix.ndim != 2 or matrix.shape[0] != len(texts) or matrix.shape[1] == 0:
            raise RuntimeError(
                "SentenceTransformer returned an invalid embedding matrix shape"
            )
        if not np.isfinite(matrix).all():
            raise RuntimeError("SentenceTransformer returned non-finite embeddings")
        if self.normalize_embeddings:
            norms = np.linalg.norm(matrix, axis=1, keepdims=True)
            matrix = np.divide(
                matrix,
                norms,
                out=np.zeros_like(matrix, dtype=np.float32),
                where=norms > 0,
            )
        return np.ascontiguousarray(matrix, dtype=np.float32)

    def encode(self, texts: Sequence[str]) -> NDArray[np.float32]:
        """Embed text in input order, computing only unique cache misses."""

        if isinstance(texts, (str, bytes)):
            raise TypeError("texts must be a sequence of strings, not one string")
        values = tuple(texts)
        if any(not isinstance(text, str) for text in values):
            raise TypeError("every embedding input must be a string")
        if not values:
            return np.empty((0, 0), dtype=np.float32)

        vectors: dict[str, NDArray[np.float32]] = {}
        missing_by_key: dict[str, str] = {}
        for text in values:
            key = self._vector_key(text)
            if key in vectors or key in missing_by_key:
                continue
            cached = self._read_vector(key)
            if cached is None:
                missing_by_key[key] = text
            else:
                vectors[key] = cached

        if missing_by_key:
            missing_keys = tuple(missing_by_key)
            computed = self._compute(tuple(missing_by_key.values()))
            for key, vector in zip(missing_keys, computed, strict=True):
                stored = np.ascontiguousarray(vector, dtype=np.float32)
                with self._cache_lock:
                    self._write_vector(key, stored)
                vectors[key] = stored

        ordered = [vectors[self._vector_key(text)] for text in values]
        dimensions = {vector.shape[0] for vector in ordered}
        if len(dimensions) != 1:
            raise EmbeddingCacheError(
                "cached embeddings disagree on dimension; pin a model revision and "
                "use a fresh cache directory"
            )
        return np.stack(ordered).astype(np.float32, copy=False)

    def encode_ephemeral(self, texts: Sequence[str]) -> NDArray[np.float32]:
        """Embed request-scoped text without reading or writing the disk cache."""

        if isinstance(texts, (str, bytes)):
            raise TypeError("texts must be a sequence of strings, not one string")
        values = tuple(texts)
        if any(not isinstance(text, str) for text in values):
            raise TypeError("every embedding input must be a string")
        if not values:
            return np.empty((0, 0), dtype=np.float32)
        unique = tuple(dict.fromkeys(values))
        computed = self._compute(unique)
        by_text = {
            text: np.ascontiguousarray(vector, dtype=np.float32)
            for text, vector in zip(unique, computed, strict=True)
        }
        return np.stack([by_text[text] for text in values]).astype(
            np.float32,
            copy=False,
        )

    def encode_one(self, text: str) -> NDArray[np.float32]:
        return self.encode((text,))[0]


Embedder = SentenceTransformerEmbedder


__all__ = [
    "Embedder",
    "EmbeddingCacheError",
    "EmbeddingUnavailableError",
    "SentenceTransformerEmbedder",
]

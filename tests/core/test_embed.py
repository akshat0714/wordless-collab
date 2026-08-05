from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pytest

from wordless.core.embed import EmbeddingUnavailableError, SentenceTransformerEmbedder


class FakeModel:
    def __init__(self) -> None:
        self.batches: list[tuple[str, ...]] = []
        self.kwargs: list[dict[str, Any]] = []
        self.eval_called = False

    def eval(self) -> None:
        self.eval_called = True

    def encode(self, texts: list[str], **kwargs: Any) -> np.ndarray:
        self.batches.append(tuple(texts))
        self.kwargs.append(kwargs)
        return np.asarray(
            [
                [
                    float(len(text) + 1),
                    float(sum(map(ord, text)) % 101 + 1),
                    float(text.count(" ") + 1),
                ]
                for text in texts
            ],
            dtype=np.float32,
        )


class Factory:
    def __init__(self, model: FakeModel | None = None, error: Exception | None = None) -> None:
        self.model = model
        self.error = error
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, model_id: str, **kwargs: Any) -> FakeModel:
        self.calls.append((model_id, kwargs))
        if self.error is not None:
            raise self.error
        assert self.model is not None
        return self.model


def _embedder(tmp_path: Path, factory: Factory, **overrides: Any) -> SentenceTransformerEmbedder:
    options: dict[str, Any] = {
        "model_id": "verified/fixture-embed",
        "cache_dir": tmp_path,
        "model_factory": factory,
        "seed": 17,
    }
    options.update(overrides)
    return SentenceTransformerEmbedder(**options)


def test_embedder_deduplicates_misses_and_preserves_input_order(tmp_path: Path) -> None:
    model = FakeModel()
    factory = Factory(model)
    embedder = _embedder(tmp_path, factory)

    matrix = embedder.encode(("alpha", "beta", "alpha"))

    assert matrix.shape == (3, 3)
    np.testing.assert_array_equal(matrix[0], matrix[2])
    np.testing.assert_allclose(np.linalg.norm(matrix, axis=1), np.ones(3), atol=1e-6)
    assert model.batches == [("alpha", "beta")]
    assert model.eval_called is True
    assert model.kwargs[0]["show_progress_bar"] is False
    assert model.kwargs[0]["normalize_embeddings"] is False


def test_fully_cached_embeddings_work_offline_without_loading_a_model(
    tmp_path: Path,
) -> None:
    online_model = FakeModel()
    _embedder(tmp_path, Factory(online_model)).encode(("cached", "also cached"))
    unavailable_factory = Factory(error=RuntimeError("network forbidden"))

    matrix = _embedder(tmp_path, unavailable_factory, offline=True).encode(
        ("also cached", "cached")
    )

    assert matrix.shape == (2, 3)
    assert unavailable_factory.calls == []


def test_partial_cache_computes_only_missing_text(tmp_path: Path) -> None:
    first_model = FakeModel()
    _embedder(tmp_path, Factory(first_model)).encode(("existing",))
    second_model = FakeModel()

    matrix = _embedder(tmp_path, Factory(second_model)).encode(("existing", "new"))

    assert matrix.shape == (2, 3)
    assert second_model.batches == [("new",)]


def test_cache_namespace_includes_revision_seed_device_and_batch(tmp_path: Path) -> None:
    first = FakeModel()
    _embedder(
        tmp_path,
        Factory(first),
        revision="commit-a",
        seed=17,
        batch_size=4,
        device="cpu",
    ).encode(("same",))

    for overrides in (
        {"revision": "commit-b", "seed": 17, "batch_size": 4, "device": "cpu"},
        {"revision": "commit-a", "seed": 18, "batch_size": 4, "device": "cpu"},
        {"revision": "commit-a", "seed": 17, "batch_size": 5, "device": "cpu"},
        {"revision": "commit-a", "seed": 17, "batch_size": 4, "device": "mps"},
    ):
        model = FakeModel()
        _embedder(tmp_path, Factory(model), **overrides).encode(("same",))
        assert model.batches == [("same",)]


def test_offline_cache_miss_requests_local_files_only(tmp_path: Path) -> None:
    model = FakeModel()
    factory = Factory(model)

    _embedder(tmp_path, factory, offline=True).encode(("locally available",))

    assert factory.calls[0][1]["local_files_only"] is True
    assert factory.calls[0][1]["device"] == "cpu"
    assert factory.calls[0][1]["trust_remote_code"] is False


def test_offline_unavailable_model_raises_explicit_error(tmp_path: Path) -> None:
    embedder = _embedder(
        tmp_path,
        Factory(error=OSError("not in local model cache")),
        offline=True,
    )

    with pytest.raises(EmbeddingUnavailableError, match="offline/local"):
        embedder.encode_one("uncached")


def test_empty_batch_neither_loads_model_nor_writes_cache(tmp_path: Path) -> None:
    factory = Factory(error=AssertionError("must not load"))
    matrix = _embedder(tmp_path, factory).encode(())

    assert matrix.shape == (0, 0)
    assert matrix.dtype == np.float32
    assert factory.calls == []


def test_ephemeral_embeddings_never_read_or_write_vector_cache(tmp_path: Path) -> None:
    cached_model = FakeModel()
    _embedder(tmp_path, Factory(cached_model)).encode(("cached text",))
    cache_files_before = tuple(sorted(tmp_path.rglob("*.npy")))
    model = FakeModel()
    embedder = _embedder(tmp_path, Factory(model))

    matrix = embedder.encode_ephemeral(("customer text", "customer text"))

    assert matrix.shape == (2, 3)
    assert model.batches == [("customer text",)]
    assert tuple(sorted(tmp_path.rglob("*.npy"))) == cache_files_before


def test_model_id_is_required_and_single_string_input_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="model_id"):
        SentenceTransformerEmbedder(model_id="", cache_dir=tmp_path)
    with pytest.raises(TypeError, match="sequence"):
        _embedder(tmp_path, Factory(FakeModel())).encode("one string")  # type: ignore[arg-type]

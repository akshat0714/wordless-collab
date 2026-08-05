from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

from wordless.core.llm import LLMClient, LLMRequest
from wordless.core.models import Resolution, StateFact
from wordless.pipeline.rerank import Candidate
from wordless.replay.judge import ReplayJudge


NOW = datetime(2026, 7, 20, 12, tzinfo=timezone.utc)


def _candidate() -> Candidate:
    return Candidate(
        detector_id="duplicate_charge",
        title="You were charged twice",
        detail="Two successful $84.00 charges were recorded within one hour.",
        evidence=(
            StateFact(
                source="billing",
                kind="charge",
                occurred_at=NOW,
                fields={"amount": "84.00"},
                provenance="exported",
            ),
        ),
        base_score=0.9,
        variants=("duplicate card charge",),
        cosine_similarity=0.5,
        recency_boost=0.5,
        score=1.6,
        rank=1,
    )


def _resolution(text: str = "We refunded the duplicate card charge.") -> Resolution:
    return Resolution(
        resolved_at=NOW,
        original_label="duplicate_charge",
        actions=["Refunded the second charge"],
        closing_text=text,
    )


class PairEmbedder:
    def __init__(self, similarity: str) -> None:
        self.similarity = similarity

    def encode(self, _texts: tuple[str, str]) -> np.ndarray:
        right = {
            "high": [1.0, 0.0],
            "middle": [0.5, 0.8660254],
            "low": [0.0, 1.0],
        }[self.similarity]
        return np.asarray(([1.0, 0.0], right), dtype=np.float32)


class InspectingPairEmbedder(PairEmbedder):
    def encode(self, texts: tuple[str, str]) -> np.ndarray:
        assert all("jane@example.com" not in text for text in texts)
        assert any("<EMAIL_ADDRESS>" in text for text in texts)
        return super().encode(texts)


class FixedProvider:
    def __init__(self, response: str) -> None:
        self.response = response
        self.calls: list[tuple[LLMRequest, str, float]] = []

    def complete(
        self,
        request: LLMRequest,
        *,
        model_id: str,
        timeout_seconds: float,
    ) -> str:
        self.calls.append((request, model_id, timeout_seconds))
        return self.response


def client(tmp_path: Path, provider: FixedProvider, *, name: str) -> LLMClient:
    return LLMClient(
        provider=provider,
        provider_id="fixture",
        model_id=f"fixture/{name}",
        cache_dir=tmp_path / name,
        timeout_seconds=0.5,
        max_retries=0,
        fallback="unclear",
    )


def test_embedding_prefilter_handles_clear_yes_and_no_without_llm(tmp_path: Path) -> None:
    provider = FixedProvider("yes")
    llm = client(tmp_path, provider, name="forbidden")

    yes = ReplayJudge(embedder=PairEmbedder("high"), llm=llm).judge(
        _candidate(), _resolution()
    )
    no = ReplayJudge(embedder=PairEmbedder("low"), llm=llm).judge(
        _candidate(), _resolution("We changed the delivery address.")
    )

    assert (yes.decision, yes.stage) == ("yes", "embedding")
    assert (no.decision, no.stage) == ("no", "embedding")
    assert provider.calls == []


def test_ambiguous_prefilter_uses_llm_client_and_invalid_output_has_fallback(
    tmp_path: Path,
) -> None:
    yes_provider = FixedProvider("yes")
    invalid_provider = FixedProvider("maybe")
    llm_result = ReplayJudge(
        embedder=PairEmbedder("middle"),
        llm=client(tmp_path, yes_provider, name="yes"),
    ).judge(
        _candidate(), _resolution()
    )
    fallback = ReplayJudge(
        embedder=PairEmbedder("middle"),
        llm=client(tmp_path, invalid_provider, name="invalid"),
    ).judge(
        _candidate(), _resolution()
    )

    assert (llm_result.decision, llm_result.stage) == ("yes", "llm")
    assert llm_result.llm_source == "provider"
    request, model_id, timeout = yes_provider.calls[0]
    assert request.seed == 0
    assert request.temperature == 0
    assert request.metadata == {"task": "replay_resolution_match"}
    assert model_id == "fixture/yes"
    assert timeout == 0.5
    assert fallback.stage == "fallback"
    assert fallback.decision in {"yes", "no", "unclear"}


def test_replay_judge_rejects_unbounded_llm_objects() -> None:
    class RawProviderLikeObject:
        def complete(self, _prompt: str) -> str:
            return "yes"

    with pytest.raises(TypeError, match="must be an LLMClient"):
        ReplayJudge(embedder=PairEmbedder("middle"), llm=RawProviderLikeObject())  # type: ignore[arg-type]


def test_direct_judge_rescans_resolution_before_embedding_and_llm(
    tmp_path: Path,
) -> None:
    provider = FixedProvider("unclear")
    judge = ReplayJudge(
        embedder=InspectingPairEmbedder("middle"),
        llm=client(tmp_path, provider, name="pii-boundary"),
    )

    judge.judge(
        _candidate(),
        _resolution("We emailed jane@example.com about the duplicate card charge."),
    )

    assert provider.calls
    assert "jane@example.com" not in provider.calls[0][0].prompt
    assert "<EMAIL_ADDRESS>" in provider.calls[0][0].prompt

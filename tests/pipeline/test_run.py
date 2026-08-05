from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError

from wordless.core.models import Interaction
from wordless.core.redact import Redactor
from wordless.pipeline.run import PipelineRunner


FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "pipeline_interactions.json"


class ConstantEmbedder:
    def encode(self, texts: tuple[str, ...]) -> np.ndarray:
        return np.tile(np.asarray([[1.0, 0.0]], dtype=np.float32), (len(texts), 1))


def test_pipeline_requires_concrete_redactor() -> None:
    class RedactorSubclass(Redactor):
        pass

    with pytest.raises(TypeError, match="concrete Redactor"):
        PipelineRunner(
            embedder=ConstantEmbedder(),
            redactor=RedactorSubclass(),
        )


def test_two_pipeline_runs_are_byte_identical() -> None:
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))[0]
    interaction = Interaction.model_validate(raw)
    runner = PipelineRunner(embedder=ConstantEmbedder(), threshold=0.0)

    first = runner.run(interaction).model_dump_json()
    second = runner.run(interaction).model_dump_json()

    assert first == second
    assert len(json.loads(first)["candidates"]) <= 3


def test_clean_account_abstains_without_embedding() -> None:
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))[-1]
    interaction = Interaction.model_validate(raw)

    class FailingEmbedder:
        def encode(self, _texts: tuple[str, ...]) -> np.ndarray:
            raise AssertionError("clean account must not reach semantic reranking")

    result = PipelineRunner(embedder=FailingEmbedder(), threshold=0.0).run(interaction)
    assert result.abstained is True
    assert result.abstention_reason == "no_evidence_hypotheses"


def test_unredacted_message_never_reaches_embedding() -> None:
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))[0]
    raw["messages"][0]["redacted"] = False
    raw["messages"][0]["text"] = "contact jane@example.com"
    interaction = Interaction.model_validate(raw)

    class SpyEmbedder:
        def encode(self, _texts: tuple[str, ...]) -> np.ndarray:
            raise AssertionError("unredacted text reached semantic reranking")

    with pytest.raises(ValueError, match="requires redacted ingest output"):
        PipelineRunner(embedder=SpyEmbedder(), threshold=0.0).run(interaction)


def test_forged_redacted_flag_is_rescanned_before_embedding() -> None:
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))[0]
    raw["messages"][0]["redacted"] = True
    raw["messages"][0]["text"] = "contact jane@example.com about money one twice"
    interaction = Interaction.model_validate(raw)

    class InspectingEmbedder:
        def encode(self, texts: tuple[str, ...]) -> np.ndarray:
            assert all("jane@example.com" not in text for text in texts)
            return np.tile(
                np.asarray([[1.0, 0.0]], dtype=np.float32),
                (len(texts), 1),
            )

    result = PipelineRunner(embedder=InspectingEmbedder(), threshold=0.0).run(
        interaction
    )
    assert "jane@example.com" not in result.fragment
    assert "<EMAIL_ADDRESS>" in result.fragment


def test_pipeline_revalidates_mutated_future_state_before_embedding() -> None:
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))[0]
    interaction = Interaction.model_validate(raw)
    interaction.state_snapshot[0].occurred_at = interaction.opened_at + timedelta(seconds=1)

    class SpyEmbedder:
        def encode(self, _texts: tuple[str, ...]) -> np.ndarray:
            raise AssertionError("invalid canonical state reached semantic reranking")

    with pytest.raises(ValidationError, match="temporal leakage"):
        PipelineRunner(embedder=SpyEmbedder(), threshold=0.0).run(interaction)


def test_pipeline_revalidates_mutated_customer_key_before_embedding() -> None:
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))[0]
    interaction = Interaction.model_validate(raw)
    interaction.__dict__["customer_key"] = f"sha256:{'a' * 64}"

    class SpyEmbedder:
        def encode(self, _texts: tuple[str, ...]) -> np.ndarray:
            raise AssertionError("invalid canonical key reached semantic reranking")

    with pytest.raises(ValidationError, match="hmac-sha256"):
        PipelineRunner(embedder=SpyEmbedder(), threshold=0.0).run(interaction)


def test_recent_message_context_is_redacted_before_concept_embedding() -> None:
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))[0]
    raw["metadata"]["wordless_recent_customer_messages"] = [
        "Email jane@example.com because money was taken twice",
    ]
    interaction = Interaction.model_validate(raw)

    class InspectingEmbedder:
        def encode(self, texts: tuple[str, ...]) -> np.ndarray:
            assert all("jane@example.com" not in text for text in texts)
            assert any("<EMAIL_ADDRESS>" in text for text in texts)
            return np.tile(
                np.asarray([[1.0, 0.0]], dtype=np.float32),
                (len(texts), 1),
            )

    result = PipelineRunner(embedder=InspectingEmbedder(), threshold=0.0).run(
        interaction
    )

    assert result.candidates

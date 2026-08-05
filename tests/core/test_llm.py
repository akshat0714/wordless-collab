from __future__ import annotations

from collections.abc import Sequence
import json
from pathlib import Path
import time

import pytest

from wordless.core.llm import LLMClient, LLMRequest


class SequenceProvider:
    def __init__(self, outcomes: Sequence[str | Exception]) -> None:
        self.outcomes = list(outcomes)
        self.calls: list[tuple[LLMRequest, str, float]] = []

    def complete(
        self,
        request: LLMRequest,
        *,
        model_id: str,
        timeout_seconds: float,
    ) -> str:
        self.calls.append((request, model_id, timeout_seconds))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class SleepingProvider:
    def complete(
        self,
        request: LLMRequest,
        *,
        model_id: str,
        timeout_seconds: float,
    ) -> str:
        time.sleep(0.2)
        return "too late"


def _client(tmp_path: Path, provider: object, **overrides: object) -> LLMClient:
    options = {
        "provider": provider,
        "provider_id": "fixture",
        "model_id": "verified/model",
        "cache_dir": tmp_path,
        "timeout_seconds": 0.5,
        "max_retries": 0,
        "retry_backoff_seconds": 0,
        "fallback": "deterministic fallback",
    }
    options.update(overrides)
    return LLMClient(**options)  # type: ignore[arg-type]


def test_provider_result_is_cached_and_reused_without_an_sdk_call(tmp_path: Path) -> None:
    provider = SequenceProvider(["answer"])
    request = LLMRequest(prompt="classify this", seed=7)
    first = _client(tmp_path, provider).generate(request)

    unavailable = SequenceProvider([AssertionError("cache should satisfy request")])
    second = _client(tmp_path, unavailable, offline=True).generate(request)

    assert first.text == "answer"
    assert first.source == "provider"
    assert first.attempts == 1
    assert second.text == "answer"
    assert second.source == "cache"
    assert second.attempts == 0
    assert unavailable.calls == []


def test_wrapper_redacts_inputs_outputs_and_cache_before_persistence(
    tmp_path: Path,
) -> None:
    provider = SequenceProvider(["Contact jane@example.com."])
    client = _client(tmp_path, provider)

    result = client.generate(
        LLMRequest(
            prompt="Help alice@example.com",
            metadata={"contact": "bob@example.com"},
        )
    )

    assert provider.calls
    sent_request = provider.calls[0][0]
    assert "alice@example.com" not in sent_request.prompt
    assert "bob@example.com" not in json.dumps(sent_request.metadata)
    assert result.text == "Contact <EMAIL_ADDRESS>."
    persisted = b"".join(path.read_bytes() for path in tmp_path.rglob("*.json"))
    assert b"jane@example.com" not in persisted
    assert b"<EMAIL_ADDRESS>" in persisted


def test_provider_failures_retry_a_bounded_number_then_succeed(tmp_path: Path) -> None:
    provider = SequenceProvider([ConnectionError("one"), TimeoutError("two"), "ok"])
    result = _client(tmp_path, provider, max_retries=2).generate(
        LLMRequest(prompt="retry")
    )

    assert result.text == "ok"
    assert result.source == "provider"
    assert result.attempts == 3
    assert len(provider.calls) == 3


def test_exhausted_provider_returns_deterministic_fallback_with_provenance(
    tmp_path: Path,
) -> None:
    provider = SequenceProvider([RuntimeError("down"), RuntimeError("still down")])
    client = _client(
        tmp_path,
        provider,
        max_retries=1,
        fallback="fallback:11",
    )

    result = client.generate(LLMRequest(prompt="x", seed=11))

    assert result.text == "fallback:11"
    assert result.source == "fallback"
    assert result.attempts == 2
    assert result.error_type == "RuntimeError"


def test_arbitrary_callable_fallback_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(TypeError, match="deterministic string"):
        _client(
            tmp_path,
            SequenceProvider([RuntimeError("down")]),
            fallback=lambda request: f"unsafe:{request.seed}",
        )


def test_wrapper_enforces_wall_clock_timeout_before_falling_back(tmp_path: Path) -> None:
    client = _client(tmp_path, SleepingProvider(), timeout_seconds=0.02)
    started = time.monotonic()

    result = client.generate(LLMRequest(prompt="will hang"))

    assert time.monotonic() - started < 0.15
    assert result.source == "fallback"
    assert result.error_type == "TimeoutError"


def test_no_provider_still_completes_with_fallback(tmp_path: Path) -> None:
    client = LLMClient(
        provider=None,
        cache_dir=tmp_path,
        fallback="offline fixture",
        offline=True,
    )

    assert client.complete("anything") == "offline fixture"


def test_cache_key_includes_every_output_affecting_request_field(tmp_path: Path) -> None:
    provider = SequenceProvider(["seed one", "seed two"])
    client = _client(tmp_path, provider)

    assert client.generate(LLMRequest(prompt="same", seed=1)).text == "seed one"
    assert client.generate(LLMRequest(prompt="same", seed=2)).text == "seed two"
    assert len(provider.calls) == 2


def test_provider_and_model_identifiers_are_required_together(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="configured together"):
        LLMClient(provider=None, provider_id="only", cache_dir=tmp_path)
    with pytest.raises(ValueError, match="required when provider"):
        LLMClient(provider=SequenceProvider(["x"]), cache_dir=tmp_path)

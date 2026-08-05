from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from wordless.core.config import (
    CoreConfig,
    ModelValidationError,
    Settings,
    load_config,
    validate_configured_models,
)


def test_default_config_is_offline_capable_without_unverified_model_ids() -> None:
    config = CoreConfig()

    assert config.llm_provider is None
    assert config.llm_model_id is None
    assert config.embedding_model_id is None
    assert Settings is CoreConfig


def test_from_env_loads_and_types_every_declared_setting() -> None:
    config = load_config(
        {
            "WORDLESS_LLM_PROVIDER": "fixture-provider",
            "WORDLESS_LLM_MODEL_ID": "verified/model-v1",
            "WORDLESS_EMBED_MODEL_ID": "verified/embed-v2",
            "WORDLESS_EMBED_MODEL_REVISION": "abc123",
            "WORDLESS_CACHE_DIR": "/tmp/wordless-test-cache",
            "WORDLESS_OFFLINE": "true",
            "WORDLESS_LLM_TIMEOUT_SECONDS": "4.5",
            "WORDLESS_LLM_MAX_RETRIES": "3",
            "WORDLESS_LLM_RETRY_BACKOFF_SECONDS": "0",
            "WORDLESS_EMBED_BATCH_SIZE": "7",
            "WORDLESS_SEED": "42",
            "WORDLESS_UNRELATED_SETTING": "ignored",
        }
    )

    assert config.llm_provider == "fixture-provider"
    assert config.llm_model_id == "verified/model-v1"
    assert config.embedding_model_revision == "abc123"
    assert config.cache_dir == Path("/tmp/wordless-test-cache")
    assert config.llm_cache_dir == Path("/tmp/wordless-test-cache/llm")
    assert config.embedding_cache_dir == Path("/tmp/wordless-test-cache/embeddings")
    assert config.offline is True
    assert config.llm_timeout_seconds == 4.5
    assert config.llm_max_retries == 3
    assert config.embedding_batch_size == 7
    assert config.seed == 42


@pytest.mark.parametrize(
    "environment",
    [
        {"WORDLESS_LLM_PROVIDER": "provider-only"},
        {"WORDLESS_LLM_MODEL_ID": "model-only"},
        {"WORDLESS_EMBED_MODEL_REVISION": "revision-without-model"},
        {"WORDLESS_EMBED_MODEL_ID": "verified/model-without-revision"},
        {"WORDLESS_LLM_TIMEOUT_SECONDS": "0"},
        {"WORDLESS_LLM_MAX_RETRIES": "-1"},
        {"WORDLESS_EMBED_MODEL_ID": "has whitespace"},
        {"WORDLESS_LLM_MODEL_ID": "https://example.com/model", "WORDLESS_LLM_PROVIDER": "x"},
    ],
)
def test_invalid_startup_configuration_fails_immediately(
    environment: dict[str, str],
) -> None:
    with pytest.raises(ValidationError):
        CoreConfig.from_env(environment)


def test_startup_resolves_exact_embedding_revision_and_llm_model(tmp_path: Path) -> None:
    embedding_calls: list[tuple[str, dict[str, object]]] = []
    llm_calls: list[str] = []

    class LocalModel:
        def eval(self) -> None:
            return None

    def embedding_factory(model_id: str, **kwargs: object) -> LocalModel:
        embedding_calls.append((model_id, kwargs))
        return LocalModel()

    def llm_validator(model_id: str) -> bool:
        llm_calls.append(model_id)
        return model_id == "verified/model-v1"

    config = CoreConfig(
        llm_provider="fixture-provider",
        llm_model_id="verified/model-v1",
        embedding_model_id="verified/embed-v2",
        embedding_model_revision="abc123",
        cache_dir=tmp_path,
        offline=True,
    )

    validate_configured_models(
        config,
        embedding_model_factory=embedding_factory,
        llm_model_validators={"fixture-provider": llm_validator},
    )

    assert llm_calls == ["verified/model-v1"]
    assert embedding_calls[0][0] == "verified/embed-v2"
    assert embedding_calls[0][1]["revision"] == "abc123"
    assert embedding_calls[0][1]["local_files_only"] is True


def test_startup_rejects_llm_id_without_provider_registry_validation() -> None:
    config = CoreConfig(llm_provider="ghost", llm_model_id="not-real")

    with pytest.raises(ModelValidationError, match="no startup model validator"):
        validate_configured_models(config)

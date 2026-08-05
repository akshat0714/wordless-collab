"""Validated startup configuration for provider-neutral core services.

Model identifiers intentionally have no defaults here.  A deployment must
name the exact provider artifacts it has verified, while an offline deployment
may omit them and use fixture/cached results.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
import os
from pathlib import Path
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


_ENVIRONMENT_FIELDS: dict[str, str] = {
    "WORDLESS_LLM_PROVIDER": "llm_provider",
    "WORDLESS_LLM_MODEL_ID": "llm_model_id",
    "WORDLESS_EMBED_MODEL_ID": "embedding_model_id",
    "WORDLESS_EMBED_MODEL_REVISION": "embedding_model_revision",
    "WORDLESS_CACHE_DIR": "cache_dir",
    "WORDLESS_OFFLINE": "offline",
    "WORDLESS_LLM_TIMEOUT_SECONDS": "llm_timeout_seconds",
    "WORDLESS_LLM_MAX_RETRIES": "llm_max_retries",
    "WORDLESS_LLM_RETRY_BACKOFF_SECONDS": "llm_retry_backoff_seconds",
    "WORDLESS_EMBED_BATCH_SIZE": "embedding_batch_size",
    "WORDLESS_SEED": "seed",
}


class CoreConfig(BaseModel):
    """Configuration validated once before pipeline services are constructed."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    llm_provider: str | None = None
    llm_model_id: str | None = None
    embedding_model_id: str | None = None
    embedding_model_revision: str | None = None

    cache_dir: Path = Path(".wordless/cache")
    offline: bool = False
    llm_timeout_seconds: float = Field(default=30.0, gt=0)
    llm_max_retries: int = Field(default=2, ge=0, le=10)
    llm_retry_backoff_seconds: float = Field(default=0.25, ge=0, le=60)
    embedding_batch_size: int = Field(default=32, gt=0)
    seed: int = Field(default=0, ge=0)

    @field_validator(
        "llm_provider",
        "llm_model_id",
        "embedding_model_id",
        "embedding_model_revision",
    )
    @classmethod
    def validate_configured_identifier(
        cls, value: str | None, info: Any
    ) -> str | None:
        if value is None:
            return None
        if not value or value != value.strip():
            raise ValueError(f"{info.field_name} must be trimmed and non-empty")
        if any(character.isspace() for character in value):
            raise ValueError(f"{info.field_name} must not contain whitespace")
        if value.startswith(("http://", "https://")):
            raise ValueError(
                f"{info.field_name} must be a provider/registry identifier or local path, "
                "not a URL"
            )
        return value

    @field_validator("cache_dir")
    @classmethod
    def validate_cache_dir(cls, value: Path) -> Path:
        if not str(value).strip():
            raise ValueError("cache_dir must not be empty")
        return value

    @model_validator(mode="after")
    def validate_related_fields(self) -> Self:
        if (self.llm_provider is None) != (self.llm_model_id is None):
            raise ValueError(
                "WORDLESS_LLM_PROVIDER and WORDLESS_LLM_MODEL_ID must be set together"
            )
        if self.embedding_model_revision and not self.embedding_model_id:
            raise ValueError(
                "WORDLESS_EMBED_MODEL_REVISION requires WORDLESS_EMBED_MODEL_ID"
            )
        if self.embedding_model_id and not self.embedding_model_revision:
            raise ValueError(
                "WORDLESS_EMBED_MODEL_ID requires WORDLESS_EMBED_MODEL_REVISION "
                "to pin model weights"
            )
        return self

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Self:
        """Load only declared Wordless settings from an environment mapping."""

        values = os.environ if environ is None else environ
        payload = {
            field_name: values[environment_name]
            for environment_name, field_name in _ENVIRONMENT_FIELDS.items()
            if environment_name in values
        }
        return cls.model_validate(payload)

    @property
    def llm_cache_dir(self) -> Path:
        return self.cache_dir / "llm"

    @property
    def embedding_cache_dir(self) -> Path:
        return self.cache_dir / "embeddings"


# ``Settings`` is kept as a concise import name for application startup code.
Settings = CoreConfig


class ModelValidationError(RuntimeError):
    """A configured provider artifact could not be proven available."""


def validate_configured_models(
    config: CoreConfig,
    *,
    embedding_model_factory: Callable[..., Any] | None = None,
    llm_model_validators: Mapping[str, Callable[[str], bool]] | None = None,
) -> None:
    """Eagerly verify every configured model before application startup.

    Embedding IDs are resolved through SentenceTransformers using the exact
    configured revision and offline policy.  LLM registries are
    provider-specific, so a deployment must explicitly install a validator
    for its configured provider; accepting an unverified string is forbidden.
    The default fixture/offline configuration names no models and therefore
    needs no network or provider SDK.
    """

    if not isinstance(config, CoreConfig):
        raise TypeError("config must be a CoreConfig")
    if config.embedding_model_id is not None:
        from wordless.core.embed import (
            EmbeddingUnavailableError,
            SentenceTransformerEmbedder,
        )

        embedder = SentenceTransformerEmbedder(
            model_id=config.embedding_model_id,
            revision=config.embedding_model_revision,
            cache_dir=config.embedding_cache_dir,
            offline=config.offline,
            batch_size=config.embedding_batch_size,
            seed=config.seed,
            device="cpu",
            model_factory=embedding_model_factory,
        )
        try:
            embedder.validate_model_available()
        except EmbeddingUnavailableError as exc:
            raise ModelValidationError(
                "configured embedding model/revision is unavailable at startup"
            ) from exc

    if config.llm_provider is not None and config.llm_model_id is not None:
        validators = llm_model_validators or {}
        validator = validators.get(config.llm_provider)
        if validator is None:
            raise ModelValidationError(
                "configured LLM provider has no startup model validator: "
                f"{config.llm_provider!r}"
            )
        try:
            exists = validator(config.llm_model_id)
        except Exception as exc:
            raise ModelValidationError(
                "configured LLM model could not be verified at startup"
            ) from exc
        if exists is not True:
            raise ModelValidationError(
                "configured LLM model does not exist or was not verified at startup"
            )


def load_config(environ: Mapping[str, str] | None = None) -> CoreConfig:
    """Validate and return current startup configuration without global caching."""

    return CoreConfig.from_env(environ)


__all__ = [
    "CoreConfig",
    "ModelValidationError",
    "Settings",
    "load_config",
    "validate_configured_models",
]

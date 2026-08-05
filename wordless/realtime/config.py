"""Fail-closed configuration for the real-time product service."""

from __future__ import annotations

from collections.abc import Mapping
import os
from pathlib import Path
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


DEV_MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2"
DEV_MODEL_REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
_PLACEHOLDER_THRESHOLD_VERSIONS = frozenset(
    {
        "changeme",
        "default",
        "demo",
        "demo-floor-v1",
        "demo-v1",
        "pilot-v1",
        "placeholder",
        "replace-me",
        "test",
        "test-v1",
        "unset",
    }
)


class ProductSettings(BaseModel):
    """Runtime settings with fail-closed production pins and decision policy."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    workspace: Path = Path.cwd()
    database_path: Path = Path(".wordless/realtime.sqlite3")
    model_cache_dir: Path = Path(".wordless/cache/embeddings")
    dev_mode: bool = False
    offline: bool = False
    embedding_model_id: str | None = None
    embedding_model_revision: str | None = None
    embedding_batch_size: int = Field(default=32, gt=0, le=256)
    seed: int = Field(default=17, ge=0)
    threshold: float = Field(default=1.5, ge=0.0, le=3.0)
    threshold_version: str = Field(default="demo-floor-v1", min_length=1, max_length=64)
    max_body_bytes: int = Field(default=262_144, ge=1_024, le=1_048_576)
    max_json_depth: int = Field(default=12, ge=4, le=32)
    rate_limit_per_minute: int = Field(default=120, ge=1, le=100_000)
    max_inference_concurrency: int = Field(default=4, ge=1, le=64)
    signature_tolerance_seconds: int = Field(default=300, ge=30, le=900)
    max_future_observed_seconds: int = Field(default=300, ge=0, le=3_600)
    require_signatures: bool = True
    pending_timeout_seconds: int = Field(default=300, ge=30, le=3_600)
    retention_days: int = Field(default=30, ge=1, le=90)
    cleanup_interval_seconds: int = Field(default=3_600, ge=60, le=86_400)

    @field_validator("embedding_model_id", "embedding_model_revision")
    @classmethod
    def validate_model_identifier(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not value or value != value.strip() or any(char.isspace() for char in value):
            raise ValueError("model identifiers must be trimmed and contain no whitespace")
        if value.startswith(("http://", "https://")):
            raise ValueError("model identifiers must not be URLs")
        return value

    @field_validator("threshold_version")
    @classmethod
    def validate_threshold_version(cls, value: str) -> str:
        if value != value.strip():
            raise ValueError("threshold_version must be trimmed")
        return value

    @model_validator(mode="after")
    def resolve_paths_and_require_production_pins(self) -> Self:
        workspace = self.workspace.expanduser().resolve()
        if not workspace.is_dir():
            raise ValueError("WORDLESS_REALTIME_WORKSPACE must be an existing directory")

        def contained(path: Path, *, name: str) -> Path:
            candidate = path.expanduser()
            if not candidate.is_absolute():
                candidate = workspace / candidate
            candidate = candidate.resolve(strict=False)
            try:
                candidate.relative_to(workspace)
            except ValueError as exc:
                raise ValueError(f"{name} must remain inside the real-time workspace") from exc
            return candidate

        database_path = contained(
            self.database_path,
            name="WORDLESS_REALTIME_DATABASE_PATH",
        )
        cache_dir = contained(
            self.model_cache_dir,
            name="WORDLESS_REALTIME_MODEL_CACHE_DIR",
        )
        if database_path.suffix not in {".db", ".sqlite", ".sqlite3"}:
            raise ValueError("real-time database path must use .db, .sqlite, or .sqlite3")

        model_id = self.embedding_model_id
        revision = self.embedding_model_revision
        if self.dev_mode:
            model_id = model_id or DEV_MODEL_ID
            revision = revision or DEV_MODEL_REVISION
        if model_id is None or revision is None:
            raise ValueError(
                "production real-time mode requires exact embedding model ID and revision"
            )
        if not self.dev_mode:
            if "threshold" not in self.model_fields_set or self.threshold <= 0:
                raise ValueError(
                    "production real-time mode requires an explicitly configured "
                    "nonzero threshold"
                )
            if (
                "threshold_version" not in self.model_fields_set
                or self.threshold_version.casefold()
                in _PLACEHOLDER_THRESHOLD_VERSIONS
            ):
                raise ValueError(
                    "production real-time mode requires an explicitly configured "
                    "non-placeholder threshold_version"
                )
        if self.dev_mode and self.require_signatures:
            object.__setattr__(self, "require_signatures", False)
        elif not self.dev_mode and not self.require_signatures:
            raise ValueError(
                "production real-time mode requires exact-body request signatures"
            )
        object.__setattr__(self, "workspace", workspace)
        object.__setattr__(self, "database_path", database_path)
        object.__setattr__(self, "model_cache_dir", cache_dir)
        object.__setattr__(self, "embedding_model_id", model_id)
        object.__setattr__(self, "embedding_model_revision", revision)
        return self

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Self:
        values = os.environ if environ is None else environ
        mapping = {
            "WORDLESS_REALTIME_WORKSPACE": "workspace",
            "WORDLESS_REALTIME_DATABASE_PATH": "database_path",
            "WORDLESS_REALTIME_MODEL_CACHE_DIR": "model_cache_dir",
            "WORDLESS_REALTIME_DEV_MODE": "dev_mode",
            "WORDLESS_REALTIME_OFFLINE": "offline",
            "WORDLESS_REALTIME_EMBED_MODEL_ID": "embedding_model_id",
            "WORDLESS_REALTIME_EMBED_MODEL_REVISION": "embedding_model_revision",
            "WORDLESS_REALTIME_EMBED_BATCH_SIZE": "embedding_batch_size",
            "WORDLESS_REALTIME_SEED": "seed",
            "WORDLESS_REALTIME_THRESHOLD": "threshold",
            "WORDLESS_REALTIME_THRESHOLD_VERSION": "threshold_version",
            "WORDLESS_REALTIME_MAX_BODY_BYTES": "max_body_bytes",
            "WORDLESS_REALTIME_MAX_JSON_DEPTH": "max_json_depth",
            "WORDLESS_REALTIME_RATE_LIMIT_PER_MINUTE": "rate_limit_per_minute",
            "WORDLESS_REALTIME_MAX_INFERENCE_CONCURRENCY": "max_inference_concurrency",
            "WORDLESS_REALTIME_SIGNATURE_TOLERANCE_SECONDS": "signature_tolerance_seconds",
            "WORDLESS_REALTIME_MAX_FUTURE_OBSERVED_SECONDS": "max_future_observed_seconds",
            "WORDLESS_REALTIME_REQUIRE_SIGNATURES": "require_signatures",
            "WORDLESS_REALTIME_PENDING_TIMEOUT_SECONDS": "pending_timeout_seconds",
            "WORDLESS_REALTIME_RETENTION_DAYS": "retention_days",
            "WORDLESS_REALTIME_CLEANUP_INTERVAL_SECONDS": "cleanup_interval_seconds",
        }
        payload = {
            field_name: values[environment_name]
            for environment_name, field_name in mapping.items()
            if environment_name in values
        }
        return cls.model_validate(payload)


__all__ = ["DEV_MODEL_ID", "DEV_MODEL_REVISION", "ProductSettings"]

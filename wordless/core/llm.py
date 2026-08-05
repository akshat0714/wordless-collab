"""Thin provider-neutral LLM boundary with deterministic failure behavior.

Business logic supplies an implementation of :class:`LLMProvider`; this module
owns the cross-cutting guarantees every call needs: a wall-clock timeout,
bounded deterministic retries, content-addressed disk caching, and a fallback
that also works when no provider is configured.
"""

from __future__ import annotations

from collections.abc import Callable
import hashlib
import json
from pathlib import Path
import queue
import tempfile
import threading
import time
from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from wordless.core.redact import Redactor


_CACHE_SCHEMA_VERSION = 2


class LLMRequest(BaseModel):
    """Provider-independent inputs that affect a completion and its cache key."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    prompt: str
    system_prompt: str | None = None
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    seed: int = Field(default=0, ge=0)
    max_output_tokens: int | None = Field(default=None, gt=0)
    metadata: dict[str, JsonValue] = Field(default_factory=dict)


class LLMResult(BaseModel):
    """A completion plus enough provenance to audit provider/fallback use."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    text: str
    source: Literal["provider", "cache", "fallback"]
    provider_id: str | None
    model_id: str | None
    attempts: int = Field(ge=0)
    error_type: str | None = None

    @property
    def cached(self) -> bool:
        return self.source == "cache"


@runtime_checkable
class LLMProvider(Protocol):
    """The only interface a provider adapter must implement."""

    def complete(
        self,
        request: LLMRequest,
        *,
        model_id: str,
        timeout_seconds: float,
    ) -> str: ...


Fallback = Callable[[LLMRequest], str]


def empty_fallback(_request: LLMRequest) -> str:
    """Deterministic, explicit no-answer fallback used by default."""

    return ""


def _validated_identifier(value: str | None, *, name: str) -> str | None:
    if value is None:
        return None
    if not value or value != value.strip() or any(char.isspace() for char in value):
        raise ValueError(f"{name} must be trimmed, non-empty, and contain no whitespace")
    return value


class _DiskCompletionCache:
    """Small content-addressed JSON cache with atomic writes."""

    def __init__(self, directory: str | Path) -> None:
        self.directory = Path(directory)

    def path_for(self, key: str) -> Path:
        return self.directory / key[:2] / f"{key}.json"

    def get(self, key: str) -> str | None:
        path = self.path_for(key)
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return None
        if not isinstance(value, dict):
            return None
        if (
            value.get("schema_version") != _CACHE_SCHEMA_VERSION
            or value.get("key") != key
            or not isinstance(value.get("text"), str)
        ):
            return None
        return value["text"]

    def put(self, key: str, text: str) -> None:
        path = self.path_for(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            {
                "key": key,
                "schema_version": _CACHE_SCHEMA_VERSION,
                "text": text,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=path.parent,
                prefix=f".{key}.",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary.write(payload)
                temporary.flush()
                temporary_name = temporary.name
            Path(temporary_name).replace(path)
        finally:
            if temporary_name is not None:
                try:
                    Path(temporary_name).unlink(missing_ok=True)
                except OSError:
                    pass


class LLMClient:
    """Execute provider completions behind one deterministic reliability layer."""

    def __init__(
        self,
        *,
        provider: LLMProvider | None,
        provider_id: str | None = None,
        model_id: str | None = None,
        cache_dir: str | Path = Path(".wordless/cache/llm"),
        timeout_seconds: float = 30.0,
        max_retries: int = 2,
        retry_backoff_seconds: float = 0.25,
        fallback: Fallback | str | None = None,
        offline: bool = False,
        redactor: Redactor | None = None,
    ) -> None:
        self.provider = provider
        self.provider_id = _validated_identifier(provider_id, name="provider_id")
        self.model_id = _validated_identifier(model_id, name="model_id")
        if (self.provider_id is None) != (self.model_id is None):
            raise ValueError("provider_id and model_id must be configured together")
        if provider is not None and self.model_id is None:
            raise ValueError("provider_id and model_id are required when provider is set")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be greater than zero")
        if max_retries < 0:
            raise ValueError("max_retries must be non-negative")
        if retry_backoff_seconds < 0:
            raise ValueError("retry_backoff_seconds must be non-negative")
        self.timeout_seconds = float(timeout_seconds)
        self.max_retries = max_retries
        self.retry_backoff_seconds = float(retry_backoff_seconds)
        self.offline = offline
        if redactor is not None and type(redactor) is not Redactor:
            raise TypeError("redactor must be a concrete Redactor instance")
        if redactor is not None and not redactor.boundary_safe:
            raise ValueError("redactor must keep mandatory Presidio policy enabled")
        self.redactor = redactor or Redactor()
        if not self.redactor.boundary_safe:
            raise ValueError(
                "LLM boundary requires the available mandatory pinned Presidio policy"
            )
        self._cache = _DiskCompletionCache(cache_dir)
        if fallback is None:
            self.fallback: Fallback = empty_fallback
        elif isinstance(fallback, str):
            fallback_text = fallback
            self.fallback = lambda _request: fallback_text
        elif fallback is empty_fallback:
            self.fallback = fallback
        else:
            raise TypeError(
                "fallback must be a deterministic string, empty_fallback, or None"
            )

    def _cache_key(self, request: LLMRequest) -> str:
        serialized = json.dumps(
            {
                "model_id": self.model_id,
                "provider_id": self.provider_id,
                "request": request.model_dump(mode="json"),
                "schema_version": _CACHE_SCHEMA_VERSION,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(serialized).hexdigest()

    def _provider_call(self, request: LLMRequest) -> str:
        """Enforce a wall-clock bound without trusting a provider SDK.

        Python cannot safely kill arbitrary code in a thread.  The worker is a
        daemon so a provider that ignores its own timeout cannot hold pipeline
        completion or interpreter shutdown hostage; its late value is ignored.
        """

        if self.provider is None or self.model_id is None:
            raise RuntimeError("no LLM provider configured")
        outcomes: queue.Queue[tuple[bool, Any]] = queue.Queue(maxsize=1)

        def invoke() -> None:
            try:
                text = self.provider.complete(
                    request,
                    model_id=self.model_id or "",
                    timeout_seconds=self.timeout_seconds,
                )
                outcomes.put((True, text))
            except Exception as exc:  # provider exceptions are retryable at this layer
                outcomes.put((False, exc))

        thread = threading.Thread(target=invoke, name="wordless-llm-call", daemon=True)
        thread.start()
        try:
            succeeded, value = outcomes.get(timeout=self.timeout_seconds)
        except queue.Empty as exc:
            raise TimeoutError(
                f"LLM provider exceeded {self.timeout_seconds:g}s timeout"
            ) from exc
        if not succeeded:
            raise value
        if not isinstance(value, str):
            raise TypeError("LLM provider must return a string")
        return value

    def generate(self, request: LLMRequest) -> LLMResult:
        """Return a cached/provider/fallback result; never fail on provider errors."""

        if not isinstance(request, LLMRequest):
            raise TypeError("request must be an LLMRequest")
        metadata, _metadata_report = self.redactor.redact_value(request.metadata)
        if not isinstance(metadata, dict):
            raise TypeError("redacted LLM metadata must remain an object")
        request = request.model_copy(
            update={
                "prompt": self.redactor.redact(request.prompt).text,
                "system_prompt": (
                    self.redactor.redact(request.system_prompt).text
                    if request.system_prompt is not None
                    else None
                ),
                "metadata": metadata,
            },
            deep=True,
        )
        key = self._cache_key(request)
        cached = self._cache.get(key)
        if cached is not None:
            safe_cached = self.redactor.redact(cached).text
            return LLMResult(
                text=safe_cached,
                source="cache",
                provider_id=self.provider_id,
                model_id=self.model_id,
                attempts=0,
            )

        attempts = 0
        last_error: Exception | None = None
        if not self.offline and self.provider is not None:
            for attempt in range(self.max_retries + 1):
                attempts += 1
                try:
                    text = self._provider_call(request)
                except Exception as exc:
                    last_error = exc
                    if attempt < self.max_retries and self.retry_backoff_seconds:
                        time.sleep(self.retry_backoff_seconds * (2**attempt))
                    continue
                safe_text = self.redactor.redact(text).text
                try:
                    self._cache.put(key, safe_text)
                except OSError:
                    # A read-only or exhausted local cache must not turn a
                    # successful bounded provider call into a pipeline crash.
                    pass
                return LLMResult(
                    text=safe_text,
                    source="provider",
                    provider_id=self.provider_id,
                    model_id=self.model_id,
                    attempts=attempts,
                )

        fallback_text = self.fallback(request)
        if not isinstance(fallback_text, str):
            raise TypeError("LLM fallback must return a string")
        fallback_text = self.redactor.redact(fallback_text).text
        return LLMResult(
            text=fallback_text,
            source="fallback",
            provider_id=self.provider_id,
            model_id=self.model_id,
            attempts=attempts,
            error_type=type(last_error).__name__ if last_error is not None else None,
        )

    def complete(
        self,
        prompt: str,
        *,
        system_prompt: str | None = None,
        temperature: float = 0.0,
        seed: int = 0,
        max_output_tokens: int | None = None,
        metadata: dict[str, JsonValue] | None = None,
    ) -> str:
        """Convenience API for call sites that only need the completion text."""

        request = LLMRequest(
            prompt=prompt,
            system_prompt=system_prompt,
            temperature=temperature,
            seed=seed,
            max_output_tokens=max_output_tokens,
            metadata={} if metadata is None else metadata,
        )
        return self.generate(request).text


# A shorter name is convenient where the provider boundary is wired up.
LLM = LLMClient


__all__ = [
    "Fallback",
    "LLM",
    "LLMClient",
    "LLMProvider",
    "LLMRequest",
    "LLMResult",
    "empty_fallback",
]

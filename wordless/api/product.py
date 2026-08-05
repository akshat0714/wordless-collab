"""Authenticated real-time Wordless suggestion API.

This application is intentionally separate from :mod:`wordless.api.main`,
which remains the immutable local audit/demo surface.  Product requests are
server-to-server, tenant identity comes only from the API key, and every
candidate still requires a person to confirm it.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from collections.abc import Callable, Mapping
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import json
import logging
import math
import re
import secrets
from threading import Lock
import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from wordless.realtime.auth import (
    AuthenticationError,
    TenantPrincipal,
    TenantRegistry,
    verify_request_signature,
)
from wordless.realtime.config import ProductSettings
from wordless.realtime.contracts import (
    ChatAssistRequest,
    ChatAssistResponse,
    FeedbackRequest,
    FeedbackResponse,
    SuggestionEvent,
    SuggestionRequest,
    SuggestionResponse,
)
from wordless.realtime.repository import (
    FeedbackConflict,
    IdempotencyConflict,
    RealtimeRepository,
    SuggestionInProgress,
    SuggestionNotFound,
)
from wordless.realtime.service import ProductRuntime


_IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$")
_SUGGESTION_ID = re.compile(r"^sg_[0-9a-f]{32}$")
_SQLITE_SIGNED_INTEGER_MAX = (1 << 63) - 1
_LOGGER = logging.getLogger("wordless.product")


def _request_body_openapi(model: type[BaseModel]) -> dict[str, object]:
    """Describe a raw, exact-byte request body without parsing it early."""

    schema = model.model_json_schema(mode="validation")
    definitions = schema.pop("$defs", {})

    def inline(value: object, *, stack: tuple[str, ...] = ()) -> object:
        if isinstance(value, list):
            return [inline(item, stack=stack) for item in value]
        if not isinstance(value, dict):
            return value
        reference = value.get("$ref")
        if isinstance(reference, str) and reference.startswith("#/$defs/"):
            name = reference.removeprefix("#/$defs/")
            if name in stack or name not in definitions:
                raise ValueError("request contract contains an invalid schema reference")
            target = inline(definitions[name], stack=(*stack, name))
            if not isinstance(target, dict):
                raise ValueError("request contract schema reference must resolve to an object")
            siblings = {
                key: inline(item, stack=stack)
                for key, item in value.items()
                if key != "$ref"
            }
            return {**target, **siblings}
        return {
            key: inline(item, stack=stack)
            for key, item in value.items()
            if key != "$defs"
        }

    return {
        "required": True,
        "content": {
            "application/json": {
                # Local Pydantic ``#/$defs`` references are invalid once a
                # schema is nested inside an OpenAPI requestBody. Inline this
                # small, non-recursive contract so Swagger clients can use it.
                "schema": inline(schema),
            }
        },
    }


def _install_openapi_contract(application: FastAPI) -> None:
    """Add the manually enforced auth boundary to generated API documentation."""

    def product_openapi() -> dict[str, Any]:
        if application.openapi_schema is not None:
            return application.openapi_schema
        schema = get_openapi(
            title=application.title,
            version=application.version,
            description=application.description,
            routes=application.routes,
        )
        components = schema.setdefault("components", {})
        security_schemes = components.setdefault("securitySchemes", {})
        security_schemes["BearerAuth"] = {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "wl_live_<key-id>.<secret>",
            "description": (
                "Tenant-scoped server credential. Keep it in the integrating "
                "backend; never expose it to browser code."
            ),
        }
        for path, path_item in schema.get("paths", {}).items():
            if not path.startswith("/v1/"):
                continue
            for method, operation in path_item.items():
                if method not in {"get", "post", "put", "patch", "delete"}:
                    continue
                operation["security"] = [{"BearerAuth": []}]
                if method != "post":
                    continue
                parameters = operation.setdefault("parameters", [])
                for parameter in parameters:
                    if (
                        parameter.get("in") == "header"
                        and parameter.get("name") == "Idempotency-Key"
                    ):
                        parameter["required"] = True
                        parameter["description"] = (
                            "Stable 16–128 character key for this logical write. "
                            "Reuse it only with the exact same request body."
                        )
                        parameter["schema"] = {
                            "type": "string",
                            "minLength": 16,
                            "maxLength": 128,
                            "pattern": _IDEMPOTENCY_KEY.pattern,
                        }
                parameters.extend(
                    (
                        {
                            "name": "X-Wordless-Timestamp",
                            "in": "header",
                            "required": True,
                            "description": (
                                "Unix timestamp in whole seconds used by the v1 "
                                "exact-request signature."
                            ),
                            "schema": {"type": "string", "pattern": r"^[0-9]+$"},
                        },
                        {
                            "name": "X-Wordless-Signature",
                            "in": "header",
                            "required": True,
                            "description": (
                                "v1=<lowercase hex HMAC-SHA256> over timestamp, "
                                "method, exact path, idempotency key, and exact body bytes."
                            ),
                            "schema": {
                                "type": "string",
                                "pattern": r"^v1=[0-9a-f]{64}$",
                            },
                        },
                    )
                )
        application.openapi_schema = schema
        return schema

    application.openapi = product_openapi  # type: ignore[method-assign]


class _RateLimitExceeded(RuntimeError):
    def __init__(self, retry_after: int) -> None:
        super().__init__("rate limit exceeded")
        self.retry_after = retry_after


class _SlidingWindowLimiter:
    def __init__(self, *, limit: int, window_seconds: int = 60) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._values: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def check(self, key: str, *, now: float | None = None) -> None:
        current = time.monotonic() if now is None else now
        cutoff = current - self.window_seconds
        with self._lock:
            values = self._values[key]
            while values and values[0] <= cutoff:
                values.popleft()
            if len(values) >= self.limit:
                retry = max(1, math.ceil(values[0] + self.window_seconds - current))
                raise _RateLimitExceeded(retry)
            values.append(current)


def _reject_duplicate_keys(items: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate JSON keys are not allowed")
        result[key] = value
    return result


def _reject_non_finite(value: str) -> None:
    raise ValueError(f"non-finite number {value} is not allowed")


def _json_depth(value: object, *, limit: int, depth: int = 0) -> int:
    if depth > limit:
        raise ValueError("JSON nesting exceeds the configured limit")
    if isinstance(value, dict):
        return max(
            ([_json_depth(item, limit=limit, depth=depth + 1) for item in value.values()]),
            default=depth,
        )
    if isinstance(value, list):
        return max(
            ([_json_depth(item, limit=limit, depth=depth + 1) for item in value]),
            default=depth,
        )
    return depth


def _safe_error(
    *,
    status: int,
    code: str,
    message: str,
    request_id: str,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={
            "error": {
                "code": code,
                "message": message,
                "request_id": request_id,
            }
        },
        headers=dict(headers or {}),
    )


async def _bounded_body(request: Request, *, max_bytes: int) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared = int(content_length)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid_content_length") from exc
        if declared < 0:
            raise HTTPException(status_code=400, detail="invalid_content_length")
        if declared > max_bytes:
            raise HTTPException(status_code=413, detail="request_too_large")
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > max_bytes:
            raise HTTPException(status_code=413, detail="request_too_large")
        chunks.append(chunk)
    return b"".join(chunks)


def _strict_json(body: bytes, *, max_depth: int) -> object:
    try:
        value = json.loads(
            body,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_non_finite,
        )
        _json_depth(value, limit=max_depth)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="invalid_json") from exc
    return value


def _idempotency_key(value: str | None) -> str:
    if value is None or _IDEMPOTENCY_KEY.fullmatch(value) is None:
        raise HTTPException(status_code=400, detail="invalid_idempotency_key")
    return value


def _sse(event: SuggestionEvent) -> bytes:
    return (
        f"id: {event.sequence}\n"
        f"event: {event.type}\n"
        f"data: {event.model_dump_json()}\n\n"
    ).encode("utf-8")


def create_product_app(
    *,
    settings: ProductSettings | None = None,
    registry: TenantRegistry | None = None,
    repository: RealtimeRepository | None = None,
    runtime: ProductRuntime | None = None,
    environ: Mapping[str, str] | None = None,
    clock_seconds: Callable[[], int] | None = None,
) -> FastAPI:
    """Create a warmed product app; dependency injection keeps contract tests local."""

    active_settings = settings or ProductSettings.from_env(environ)
    active_registry = registry or TenantRegistry.from_env(active_settings, environ)
    active_repository = repository or RealtimeRepository(
        active_settings.database_path,
        pending_timeout_seconds=active_settings.pending_timeout_seconds,
    )
    active_runtime = runtime or ProductRuntime.from_settings(active_settings)
    limiter = _SlidingWindowLimiter(limit=active_settings.rate_limit_per_minute)
    inference_slots = asyncio.Semaphore(active_settings.max_inference_concurrency)
    retention_state = {"healthy": True}

    async def cleanup_expired_records() -> None:
        cutoff = datetime.now(timezone.utc) - timedelta(days=active_settings.retention_days)
        result = await run_in_threadpool(
            active_repository.cleanup,
            retention_before=cutoff,
        )
        retention_state["healthy"] = True
        if result.completed or result.processing:
            _LOGGER.info(
                "Expired product records removed completed=%d processing=%d",
                result.completed,
                result.processing,
            )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        # Refuse startup when the configured retention boundary cannot run.
        await cleanup_expired_records()
        stop = asyncio.Event()

        async def retention_loop() -> None:
            delay_seconds = active_settings.cleanup_interval_seconds
            while True:
                try:
                    await asyncio.wait_for(
                        stop.wait(),
                        timeout=delay_seconds,
                    )
                    return
                except TimeoutError:
                    pass
                try:
                    await cleanup_expired_records()
                    delay_seconds = active_settings.cleanup_interval_seconds
                except Exception as exc:
                    retention_state["healthy"] = False
                    delay_seconds = min(60, active_settings.cleanup_interval_seconds)
                    _LOGGER.error(
                        "Product retention cleanup failed error_type=%s",
                        type(exc).__name__,
                    )

        task = asyncio.create_task(retention_loop(), name="wordless-retention")
        try:
            yield
        finally:
            stop.set()
            await task

    application = FastAPI(
        title="Wordless support-chat assistance",
        description=(
            "Authenticated evidence-backed assistance for existing support systems. "
            "Wordless is read-only, ordinary messages can continue to the host bot, "
            "and every Wordless output requires human confirmation."
        ),
        version="1.0.0-pilot",
        docs_url="/docs" if active_settings.dev_mode else None,
        redoc_url=None,
        openapi_url="/openapi.json" if active_settings.dev_mode else None,
        lifespan=lifespan,
    )
    application.state.product_settings = active_settings
    application.state.tenant_registry = active_registry
    application.state.realtime_repository = active_repository
    application.state.product_runtime = active_runtime

    @application.middleware("http")
    async def product_boundary(request: Request, call_next: Any) -> Response:
        request_id = f"req_{secrets.token_hex(12)}"
        request.state.request_id = request_id
        if active_settings.dev_mode:
            client_host = request.client.host if request.client is not None else ""
            if client_host not in {"127.0.0.1", "::1", "testclient"}:
                return _safe_error(
                    status=403,
                    code="dev_mode_loopback_only",
                    message="Development mode accepts loopback requests only.",
                    request_id=request_id,
                )
        response: Response = await call_next(request)
        response.headers["X-Wordless-Request-Id"] = request_id
        response.headers["X-Wordless-Mode"] = (
            "local-development" if active_settings.dev_mode else "realtime-product"
        )
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @application.exception_handler(AuthenticationError)
    async def authentication_error(request: Request, exc: AuthenticationError) -> JSONResponse:
        status = 403 if exc.code == "insufficient_scope" else 401
        return _safe_error(
            status=status,
            code=exc.code,
            message=exc.safe_message,
            request_id=request.state.request_id,
            headers={"WWW-Authenticate": "Bearer"},
        )

    @application.exception_handler(_RateLimitExceeded)
    async def rate_limit_error(request: Request, exc: _RateLimitExceeded) -> JSONResponse:
        return _safe_error(
            status=429,
            code="rate_limit_exceeded",
            message="The tenant request limit has been reached.",
            request_id=request.state.request_id,
            headers={"Retry-After": str(exc.retry_after)},
        )

    @application.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException) -> JSONResponse:
        code = str(exc.detail)
        messages = {
            "invalid_content_length": "Content-Length must be a valid non-negative integer.",
            "request_too_large": "The request body exceeds the configured byte limit.",
            "invalid_json": "The request body must be strict JSON without duplicate keys.",
            "invalid_schema": "The request body does not match the versioned API contract.",
            "invalid_idempotency_key": "A 16–128 character Idempotency-Key is required.",
            "unsupported_media_type": "Content-Type must be application/json.",
            "invalid_last_event_id": "Last-Event-ID must be a non-negative integer.",
            "idempotency_key_reused": "The Idempotency-Key was already used with different content.",
            "suggestion_in_progress": "The matching suggestion is still processing.",
            "feedback_conflict": "Feedback was already recorded or did not match an offered candidate.",
            "not_found": "The requested suggestion was not found.",
            "not_ready": "The real-time service is not ready.",
            "observed_at_in_future": "observed_at is beyond the allowed clock-skew window.",
        }
        return _safe_error(
            status=exc.status_code,
            code=code,
            message=messages.get(code, "The request could not be completed."),
            request_id=request.state.request_id,
            headers=exc.headers,
        )

    @application.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        request_id = getattr(request.state, "request_id", "req_unavailable")
        # Never interpolate exception text: provider/database failures can carry
        # URLs, credentials, or customer content. Operators correlate by the
        # opaque request id and exception class only.
        _LOGGER.error(
            "Unhandled product request failure request_id=%s error_type=%s",
            request_id,
            type(exc).__name__,
        )
        return _safe_error(
            status=500,
            code="internal_error",
            message="The request could not be completed.",
            request_id=request_id,
            headers={
                "X-Wordless-Request-Id": request_id,
                "X-Wordless-Mode": (
                    "local-development" if active_settings.dev_mode else "realtime-product"
                ),
                "Cache-Control": "no-store",
                "Pragma": "no-cache",
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
            },
        )

    def principal_for(request: Request, *, scope: str) -> TenantPrincipal:
        principal = active_registry.authenticate(request.headers.get("authorization"))
        principal.require_scope(scope)
        limiter.check(f"{principal.tenant_id}:{principal.key_id}")
        return principal

    async def signed_body(
        request: Request,
        principal: TenantPrincipal,
        *,
        idempotency_key: str,
    ) -> bytes:
        media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if media_type != "application/json":
            raise HTTPException(status_code=415, detail="unsupported_media_type")
        body = await _bounded_body(request, max_bytes=active_settings.max_body_bytes)
        if active_settings.require_signatures:
            raw_path = request.scope.get("raw_path")
            try:
                exact_path = (
                    bytes(raw_path).decode("ascii")
                    if isinstance(raw_path, bytes | bytearray)
                    else request.url.path
                )
            except UnicodeDecodeError as exc:
                raise AuthenticationError(
                    "invalid_signature",
                    "The request signature is invalid.",
                ) from exc
            verify_request_signature(
                principal,
                body,
                timestamp_header=request.headers.get("x-wordless-timestamp"),
                signature_header=request.headers.get("x-wordless-signature"),
                method=request.method,
                path=exact_path,
                idempotency_key=idempotency_key,
                tolerance_seconds=active_settings.signature_tolerance_seconds,
                now_seconds=(clock_seconds or (lambda: int(time.time())))(),
            )
        _strict_json(body, max_depth=active_settings.max_json_depth)
        return body

    @application.get("/health/live", tags=["system"])
    def health_live() -> dict[str, object]:
        return {
            "status": "ok",
            "mode": "development" if active_settings.dev_mode else "product",
        }

    @application.get("/health/ready", tags=["system"])
    def health_ready() -> dict[str, object]:
        ready = active_repository.healthcheck() and retention_state["healthy"]
        if not ready:
            raise HTTPException(status_code=503, detail="not_ready")
        return {
            "status": "ready",
            "database": "ready",
            "model": "ready",
            "detector_set_version": active_runtime.detector_set_version,
        }

    @application.post(
        "/v1/suggestions",
        response_model=SuggestionResponse,
        status_code=201,
        tags=["suggestions"],
        openapi_extra={"requestBody": _request_body_openapi(SuggestionRequest)},
    )
    async def create_suggestion(
        request: Request,
        response: Response,
        idempotency_key: str | None = Header(
            default=None,
            alias="Idempotency-Key",
            description="Stable key for safe retries of this logical write.",
        ),
    ) -> SuggestionResponse:
        principal = principal_for(request, scope="suggestions:write")
        key = _idempotency_key(idempotency_key)
        body = await signed_body(request, principal, idempotency_key=key)
        digest = hashlib.sha256(body).hexdigest()
        try:
            contract = SuggestionRequest.model_validate_json(body, strict=True)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail="invalid_schema") from exc
        current_seconds = (clock_seconds or (lambda: int(time.time())))()
        current_time = datetime.fromtimestamp(current_seconds, tz=timezone.utc)
        if contract.observed_at > current_time + timedelta(
            seconds=active_settings.max_future_observed_seconds
        ):
            raise HTTPException(status_code=422, detail="observed_at_in_future")
        try:
            reservation = active_repository.reserve(
                tenant_id=principal.tenant_id,
                idempotency_key=key,
                request_sha256=digest,
            )
        except IdempotencyConflict as exc:
            raise HTTPException(status_code=409, detail="idempotency_key_reused") from exc
        except SuggestionInProgress as exc:
            raise HTTPException(
                status_code=409,
                detail="suggestion_in_progress",
                headers={"Retry-After": "1"},
            ) from exc
        if reservation.completed_result is not None:
            response.status_code = 200
            response.headers["Idempotent-Replayed"] = "true"
            return reservation.completed_result
        try:
            async with inference_slots:
                evaluation = await run_in_threadpool(
                    active_runtime.evaluate,
                    principal=principal,
                    request=contract,
                    suggestion_id=reservation.suggestion_id,
                )
            active_repository.complete(
                tenant_id=principal.tenant_id,
                suggestion_id=reservation.suggestion_id,
                interaction_json=evaluation.interaction.model_dump_json(),
                result=evaluation.response,
                events=evaluation.events,
            )
        except Exception:
            active_repository.abandon(
                tenant_id=principal.tenant_id,
                suggestion_id=reservation.suggestion_id,
            )
            raise
        return evaluation.response

    @application.post(
        "/v1/chat/assist",
        response_model=ChatAssistResponse,
        status_code=201,
        tags=["chat assistance"],
        summary="Assist one message without replacing the host chatbot",
        description=(
            "Returns a grounded reply, accessible clarification choices, or an "
            "explicit instruction to continue the host bot. It never changes the "
            "customer system and every visible output requires review."
        ),
        openapi_extra={"requestBody": _request_body_openapi(ChatAssistRequest)},
    )
    async def create_chat_assist(
        request: Request,
        response: Response,
        idempotency_key: str | None = Header(
            default=None,
            alias="Idempotency-Key",
            description="Stable key for safe retries of this logical evaluation.",
        ),
    ) -> ChatAssistResponse:
        principal = principal_for(request, scope="suggestions:write")
        key = _idempotency_key(idempotency_key)
        body = await signed_body(request, principal, idempotency_key=key)
        digest = hashlib.sha256(body).hexdigest()
        try:
            contract = ChatAssistRequest.model_validate_json(body, strict=True)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail="invalid_schema") from exc
        current_seconds = (clock_seconds or (lambda: int(time.time())))()
        current_time = datetime.fromtimestamp(current_seconds, tz=timezone.utc)
        if contract.observed_at > current_time + timedelta(
            seconds=active_settings.max_future_observed_seconds
        ):
            raise HTTPException(status_code=422, detail="observed_at_in_future")
        try:
            reservation = active_repository.reserve(
                tenant_id=principal.tenant_id,
                idempotency_key=key,
                request_sha256=digest,
            )
        except IdempotencyConflict as exc:
            raise HTTPException(status_code=409, detail="idempotency_key_reused") from exc
        except SuggestionInProgress as exc:
            raise HTTPException(
                status_code=409,
                detail="suggestion_in_progress",
                headers={"Retry-After": "1"},
            ) from exc
        if reservation.completed_result is not None:
            response.status_code = 200
            response.headers["Idempotent-Replayed"] = "true"
            return active_runtime.compose_chat_response(
                principal=principal,
                request=contract,
                suggestion=reservation.completed_result,
            )
        try:
            async with inference_slots:
                evaluation = await run_in_threadpool(
                    active_runtime.evaluate_chat,
                    principal=principal,
                    request=contract,
                    suggestion_id=reservation.suggestion_id,
                )
            active_repository.complete(
                tenant_id=principal.tenant_id,
                suggestion_id=reservation.suggestion_id,
                interaction_json=evaluation.runtime.interaction.model_dump_json(),
                result=evaluation.runtime.response,
                events=evaluation.runtime.events,
            )
        except Exception:
            active_repository.abandon(
                tenant_id=principal.tenant_id,
                suggestion_id=reservation.suggestion_id,
            )
            raise
        return evaluation.response

    @application.get(
        "/v1/suggestions/{suggestion_id}",
        response_model=SuggestionResponse,
        tags=["suggestions"],
    )
    def get_suggestion(request: Request, suggestion_id: str) -> SuggestionResponse:
        principal = principal_for(request, scope="suggestions:read")
        if _SUGGESTION_ID.fullmatch(suggestion_id) is None:
            raise HTTPException(status_code=404, detail="not_found")
        try:
            return active_repository.get_result(
                tenant_id=principal.tenant_id,
                suggestion_id=suggestion_id,
            )
        except SuggestionNotFound as exc:
            raise HTTPException(status_code=404, detail="not_found") from exc

    @application.get("/v1/suggestions/{suggestion_id}/events", tags=["suggestions"])
    def suggestion_events(
        request: Request,
        suggestion_id: str,
        last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    ) -> StreamingResponse:
        principal = principal_for(request, scope="suggestions:read")
        if _SUGGESTION_ID.fullmatch(suggestion_id) is None:
            raise HTTPException(status_code=404, detail="not_found")
        try:
            after = 0 if last_event_id is None else int(last_event_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid_last_event_id") from exc
        if after < 0 or after > _SQLITE_SIGNED_INTEGER_MAX:
            raise HTTPException(status_code=400, detail="invalid_last_event_id")
        try:
            events = active_repository.get_events(
                tenant_id=principal.tenant_id,
                suggestion_id=suggestion_id,
                after_sequence=after,
            )
        except SuggestionNotFound as exc:
            raise HTTPException(status_code=404, detail="not_found") from exc
        return StreamingResponse(
            (_sse(event) for event in events),
            media_type="text/event-stream",
            headers={"X-Accel-Buffering": "no"},
        )

    @application.post(
        "/v1/suggestions/{suggestion_id}/feedback",
        response_model=FeedbackResponse,
        tags=["feedback"],
        openapi_extra={"requestBody": _request_body_openapi(FeedbackRequest)},
    )
    async def create_feedback(
        request: Request,
        suggestion_id: str,
        idempotency_key: str | None = Header(
            default=None,
            alias="Idempotency-Key",
            description="Stable key for safe retries of this logical write.",
        ),
    ) -> FeedbackResponse:
        principal = principal_for(request, scope="feedback:write")
        if _SUGGESTION_ID.fullmatch(suggestion_id) is None:
            raise HTTPException(status_code=404, detail="not_found")
        key = _idempotency_key(idempotency_key)
        body = await signed_body(request, principal, idempotency_key=key)
        digest = hashlib.sha256(body).hexdigest()
        try:
            feedback = FeedbackRequest.model_validate_json(body, strict=True)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail="invalid_schema") from exc
        try:
            return active_repository.record_feedback(
                tenant_id=principal.tenant_id,
                suggestion_id=suggestion_id,
                idempotency_key=key,
                request_sha256=digest,
                feedback=feedback,
            )
        except SuggestionNotFound as exc:
            raise HTTPException(status_code=404, detail="not_found") from exc
        except IdempotencyConflict as exc:
            raise HTTPException(status_code=409, detail="idempotency_key_reused") from exc
        except FeedbackConflict as exc:
            raise HTTPException(status_code=409, detail="feedback_conflict") from exc

    _install_openapi_contract(application)
    return application


__all__ = ["create_product_app"]

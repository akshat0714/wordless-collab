from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import hashlib
import hmac
import json
from pathlib import Path
from typing import Any, Iterator

from fastapi.testclient import TestClient
import numpy as np
import pytest

from wordless.api.product import create_product_app
from wordless.realtime.auth import (
    TenantRegistry,
    canonical_request_signature_bytes,
)
from wordless.realtime.config import (
    DEV_MODEL_ID,
    DEV_MODEL_REVISION,
    ProductSettings,
)
from wordless.realtime.repository import RealtimeRepository
from wordless.realtime.service import ProductRuntime


NOW = datetime(2026, 7, 25, 20, 0, tzinfo=UTC)
NOW_SECONDS = int(NOW.timestamp())
PEPPER = "pepper-0123456789-abcdefghijklmnop"
TENANTS = {
    "alpha": {
        "api_secret": "alpha-api-secret-0123456789-abcd",
        "reader_secret": "alpha-reader-secret-0123456789-ab",
        "signing_secret": "alpha-signing-secret-0123456789-ab",
        "customer_key": "alpha-customer-hmac-0123456789-abcd",
    },
    "beta": {
        "api_secret": "beta-api-secret-0123456789-abcde",
        "signing_secret": "beta-signing-secret-0123456789-abc",
        "customer_key": "beta-customer-hmac-0123456789-abcde",
    },
}


class EphemeralEmbedder:
    def encode_ephemeral(self, texts: object) -> np.ndarray:
        values = tuple(texts)  # type: ignore[arg-type]
        return np.ones((len(values), 4), dtype=np.float32)


@pytest.fixture(scope="module")
def runtime() -> ProductRuntime:
    return ProductRuntime(
        embedder=EphemeralEmbedder(),
        model_id=DEV_MODEL_ID,
        model_revision=DEV_MODEL_REVISION,
        threshold=1.6,
        threshold_version="demo-floor-v1",
        clock=lambda: NOW,
    )


@dataclass
class ProductHarness:
    client: TestClient
    database_path: Path


def _registry_document() -> str:
    return json.dumps(
        {
            "alpha": {
                "api_keys": [
                    {
                        "id": "alpha",
                        "secret": TENANTS["alpha"]["api_secret"],
                        "scopes": [
                            "suggestions:read",
                            "suggestions:write",
                            "feedback:write",
                        ],
                    },
                    {
                        "id": "alpha_reader",
                        "secret": TENANTS["alpha"]["reader_secret"],
                        "scopes": ["suggestions:read"],
                    },
                ],
                "customer_hmac_key": TENANTS["alpha"]["customer_key"],
                "signing_secrets": [TENANTS["alpha"]["signing_secret"]],
            },
            "beta": {
                "api_keys": [
                    {
                        "id": "beta",
                        "secret": TENANTS["beta"]["api_secret"],
                        "scopes": [
                            "suggestions:read",
                            "suggestions:write",
                            "feedback:write",
                        ],
                    }
                ],
                "customer_hmac_key": TENANTS["beta"]["customer_key"],
                "signing_secrets": [TENANTS["beta"]["signing_secret"]],
            },
        }
    )


@pytest.fixture
def product(tmp_path: Path, runtime: ProductRuntime) -> Iterator[ProductHarness]:
    settings = ProductSettings(
        workspace=tmp_path,
        database_path=Path("realtime.sqlite3"),
        model_cache_dir=Path("model-cache"),
        embedding_model_id=DEV_MODEL_ID,
        embedding_model_revision=DEV_MODEL_REVISION,
        threshold=0.1,
        threshold_version="api-contract-evaluation-2026-07-25",
        max_future_observed_seconds=300,
    )
    registry = TenantRegistry.from_env(
        settings,
        {
            "WORDLESS_REALTIME_TENANTS_JSON": _registry_document(),
            "WORDLESS_REALTIME_API_KEY_PEPPER": PEPPER,
        },
    )
    repository = RealtimeRepository(settings.database_path)
    app = create_product_app(
        settings=settings,
        registry=registry,
        repository=repository,
        runtime=runtime,
        clock_seconds=lambda: NOW_SECONDS,
    )
    with TestClient(app) as client:
        yield ProductHarness(client=client, database_path=settings.database_path)


def _body(payload: dict[str, Any]) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()


def test_unexpected_failures_return_a_safe_correlated_error(
    product: ProductHarness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = product.client.app.state.realtime_repository

    def fail_healthcheck() -> bool:
        raise RuntimeError("database-url-with-secret-and-customer-text")

    monkeypatch.setattr(repository, "healthcheck", fail_healthcheck)
    # Starlette deliberately re-raises handled 500s to its default test client;
    # production HTTP clients receive the normalized response.
    with TestClient(product.client.app, raise_server_exceptions=False) as client:
        response = client.get("/health/ready")

    assert response.status_code == 500
    assert response.headers["x-wordless-request-id"].startswith("req_")
    assert response.json() == {
        "error": {
            "code": "internal_error",
            "message": "The request could not be completed.",
            "request_id": response.headers["x-wordless-request-id"],
        }
    }
    assert "database-url" not in response.text


def _headers(
    body: bytes,
    *,
    tenant: str = "alpha",
    key_id: str | None = None,
    idempotency_key: str = "suggestion-key-0001",
    include_signature: bool = True,
    content_type: str = "application/json",
    timestamp: int = NOW_SECONDS,
    method: str = "POST",
    path: str = "/v1/suggestions",
) -> dict[str, str]:
    resolved_key_id = key_id or tenant
    secret_name = "reader_secret" if resolved_key_id == "alpha_reader" else "api_secret"
    api_secret = TENANTS[tenant][secret_name]
    signing_secret = TENANTS[tenant]["signing_secret"]
    headers = {
        "Authorization": f"Bearer wl_live_{resolved_key_id}.{api_secret}",
        "Idempotency-Key": idempotency_key,
        "Content-Type": content_type,
        "X-Wordless-Timestamp": str(timestamp),
    }
    if include_signature:
        signed = canonical_request_signature_bytes(
            timestamp=str(timestamp),
            method=method,
            path=path,
            idempotency_key=idempotency_key,
            body=body,
        )
        digest = hmac.new(signing_secret.encode(), signed, hashlib.sha256).hexdigest()
        headers["X-Wordless-Signature"] = f"v1={digest}"
    return headers


def _auth(*, tenant: str = "alpha", key_id: str | None = None) -> dict[str, str]:
    resolved_key_id = key_id or tenant
    secret_name = "reader_secret" if resolved_key_id == "alpha_reader" else "api_secret"
    return {
        "Authorization": (
            f"Bearer wl_live_{resolved_key_id}.{TENANTS[tenant][secret_name]}"
        )
    }


def _duplicate_payload(*, event_id: str = "evt-duplicate") -> dict[str, Any]:
    return {
        "schema_version": 1,
        "external_event_id": event_id,
        "observed_at": NOW.isoformat().replace("+00:00", "Z"),
        "channel": "chat",
        "customer_external_id": "jane@example.com",
        "utterance": {
            "sent_at": NOW.isoformat().replace("+00:00", "Z"),
            "text": "Email jane@example.com about the duplicate payment.",
        },
        "evidence": [
            {
                "type": "charge",
                "ref": "charge-100",
                "order_ref": "order-44",
                "occurred_at": (NOW - timedelta(minutes=30)).isoformat(),
                "amount": "84.00",
                "currency": "USD",
                "status": "succeeded",
            },
            {
                "type": "charge",
                "ref": "charge-101",
                "order_ref": "order-44",
                "occurred_at": (NOW - timedelta(minutes=25)).isoformat(),
                "amount": "84.00",
                "currency": "USD",
                "status": "succeeded",
            },
        ],
        "source_system": "customer_api",
        "metadata": {"contact": "jane@example.com"},
    }


def _post_suggestion(
    product: ProductHarness,
    payload: dict[str, Any],
    *,
    tenant: str = "alpha",
    idempotency_key: str,
):
    body = _body(payload)
    return product.client.post(
        "/v1/suggestions",
        content=body,
        headers=_headers(
            body,
            tenant=tenant,
            idempotency_key=idempotency_key,
        ),
    )


def _chat_payload(
    case: str,
    *,
    assistance_mode: str = "auto",
    text: str | None = None,
) -> dict[str, Any]:
    messages = {
        "duplicate_charge": "I think my card was charged twice.",
        "late_delivery": "My package has not arrived.",
        "wrong_item": "This is not the item I ordered.",
        "account_lock": "I cannot log in to my account.",
    }
    evidence: dict[str, list[dict[str, Any]]] = {
        "duplicate_charge": [
            {
                "type": "charge",
                "ref": "chat-charge-1",
                "order_ref": "chat-order-1",
                "occurred_at": (NOW - timedelta(minutes=20)).isoformat(),
                "amount": "42.00",
                "currency": "USD",
                "status": "succeeded",
            },
            {
                "type": "charge",
                "ref": "chat-charge-2",
                "order_ref": "chat-order-1",
                "occurred_at": (NOW - timedelta(minutes=10)).isoformat(),
                "amount": "42.00",
                "currency": "USD",
                "status": "succeeded",
            },
        ],
        "late_delivery": [
            {
                "type": "shipment",
                "ref": "chat-shipment-late",
                "order_ref": "chat-order-late",
                "occurred_at": (NOW - timedelta(hours=2)).isoformat(),
                "status": "delayed",
                "expected_delivery_at": (NOW - timedelta(days=1)).isoformat(),
            }
        ],
        "wrong_item": [
            {
                "type": "fulfillment",
                "ref": "chat-fulfillment-wrong",
                "order_ref": "chat-order-wrong",
                "occurred_at": (NOW - timedelta(hours=1)).isoformat(),
                "ordered_sku": "blue-shirt",
                "delivered_sku": "red-mug",
                "status": "wrong_item",
            }
        ],
        "account_lock": [
            {
                "type": "account_access",
                "ref": "chat-login-locked",
                "account_ref": "chat-account-locked",
                "occurred_at": (NOW - timedelta(minutes=5)).isoformat(),
                "status": "locked",
                "failed_attempts": 4,
            }
        ],
    }
    return {
        "schema_version": 1,
        "external_event_id": f"chat-{case}-{assistance_mode}",
        "observed_at": NOW.isoformat().replace("+00:00", "Z"),
        "channel": "chat",
        "customer_external_id": "chat-customer@example.com",
        "message": {
            "sent_at": NOW.isoformat().replace("+00:00", "Z"),
            "text": messages[case] if text is None else text,
        },
        "assistance_mode": assistance_mode,
        "evidence": evidence[case],
        "source_system": "host_chatbot",
        "metadata": {"adapter": "contract-test"},
    }


def _post_chat_assist(
    product: ProductHarness,
    payload: dict[str, Any],
    *,
    idempotency_key: str,
):
    body = _body(payload)
    path = "/v1/chat/assist"
    return product.client.post(
        path,
        content=body,
        headers=_headers(
            body,
            idempotency_key=idempotency_key,
            path=path,
        ),
    )


@pytest.mark.parametrize(
    "case,detector_id,evidence_indices",
    (
        ("duplicate_charge", "duplicate_charge", [0, 1]),
        ("late_delivery", "late_delivery", [0]),
        ("wrong_item", "wrong_item", [0]),
        ("account_lock", "account_lock", [0]),
    ),
)
def test_chat_assist_returns_confirmation_choices_for_real_cases(
    product: ProductHarness,
    case: str,
    detector_id: str,
    evidence_indices: list[int],
) -> None:
    result = _post_chat_assist(
        product,
        _chat_payload(case),
        idempotency_key=f"chat-grounded-{case}-0001",
    )

    assert result.status_code == 201
    value = result.json()
    assert value["outcome"] == "clarification_choices"
    assert value["integration"] == {
        "host_action": "show_wordless",
        "render_mode": "choices",
    }
    assert value["detector_id"] == detector_id
    assert value["selection_basis"] == "evidence_and_message"
    assert value["review_required"] is True
    assert value["read_only"] is True
    assert len(value["choices"]) == 2
    assert value["choices"][0]["detector_id"] == detector_id
    assert value["choices"][1]["id"] == "something_else"
    assert [item["input_index"] for item in value["evidence"]] == evidence_indices
    assert all("chat-" not in item["ref"] for item in value["evidence"])
    assert "chat-customer@example.com" not in result.text


def test_explicit_empty_message_returns_evidence_backed_choices_and_feedback(
    product: ProductHarness,
) -> None:
    payload = _chat_payload(
        "duplicate_charge",
        assistance_mode="show_choices",
        text="",
    )
    result = _post_chat_assist(
        product,
        payload,
        idempotency_key="chat-explicit-choices-0001",
    )

    assert result.status_code == 201
    value = result.json()
    assert value["outcome"] == "clarification_choices"
    assert value["integration"] == {
        "host_action": "show_wordless",
        "render_mode": "choices",
    }
    assert value["selection_basis"] == "explicit_evidence_choices"
    assert [choice["id"] for choice in value["choices"]] == [
        "confirm_duplicate_charge",
        "something_else",
    ]
    supported = value["choices"][0]
    assert supported["detector_id"] == "duplicate_charge"
    assert supported["evidence"] == value["evidence"]
    assert value["choices"][1]["detector_id"] is None
    assert value["choices"][1]["evidence"] == []

    feedback = {
        "schema_version": 1,
        "outcome": "confirmed",
        "selected_detector_id": supported["detector_id"],
        "actor": "customer",
    }
    feedback_body = _body(feedback)
    feedback_path = value["links"]["feedback"]
    recorded = product.client.post(
        feedback_path,
        content=feedback_body,
        headers=_headers(
            feedback_body,
            idempotency_key="chat-choice-feedback-0001",
            path=feedback_path,
        ),
    )
    assert recorded.status_code == 200
    assert recorded.json()["selected_detector_id"] == "duplicate_charge"


@pytest.mark.parametrize(
    "slug,case,text,selection_basis",
    (
        ("money-typo", "duplicate_charge", "mney twcie", "evidence_and_message"),
        ("package-typo", "late_delivery", "pakg no com", "evidence_and_message"),
        ("item-typo", "wrong_item", "thing box difrent", "evidence_and_message"),
        ("account-typo", "account_lock", "cant in acount", "evidence_and_message"),
        ("high-noise", "account_lock", "asdf qqq", "contextual_evidence_choices"),
        (
            "vague-anaphora",
            "duplicate_charge",
            "need it agin",
            "contextual_evidence_choices",
        ),
    ),
)
def test_chat_api_distinguishes_resolved_typos_from_unresolved_context(
    product: ProductHarness,
    slug: str,
    case: str,
    text: str,
    selection_basis: str,
) -> None:
    payload = _chat_payload(case, text=text)
    payload["external_event_id"] = f"chat-contextual-{slug}"

    result = _post_chat_assist(
        product,
        payload,
        idempotency_key=f"chat-contextual-{slug}-0001",
    )

    assert result.status_code == 201
    value = result.json()
    assert value["outcome"] == "clarification_choices"
    assert value["selection_basis"] == selection_basis
    assert value["detector_id"] == case
    assert value["message"].startswith("You don’t need the exact words.")
    assert [choice["id"] for choice in value["choices"]] == [
        f"confirm_{case}",
        "something_else",
    ]


def test_ordinary_message_explicitly_continues_the_existing_host_bot(
    product: ProductHarness,
) -> None:
    payload = _chat_payload("account_lock", text="What are your store opening hours?")
    payload["external_event_id"] = "chat-ordinary-message"
    payload["evidence"] = []
    result = _post_chat_assist(
        product,
        payload,
        idempotency_key="chat-host-continuation-0001",
    )

    assert result.status_code == 201
    value = result.json()
    assert value["outcome"] == "clarifying_fallback"
    assert value["integration"] == {
        "host_action": "continue_host_bot",
        "render_mode": "none",
    }
    assert value["message"] is None
    assert value["reason"] == "insufficient_context"
    assert value["choices"] == []
    assert value["evidence"] == []


def test_chat_assist_returns_only_a_supplied_healthy_state_fact(
    product: ProductHarness,
) -> None:
    payload = _chat_payload("late_delivery", text="Where is my delivery?")
    payload["external_event_id"] = "chat-known-delivered"
    payload["evidence"][0]["status"] = "delivered"
    payload["evidence"][0]["occurred_at"] = (NOW - timedelta(hours=1)).isoformat()
    payload["evidence"][0]["expected_delivery_at"] = None
    result = _post_chat_assist(
        product,
        payload,
        idempotency_key="chat-known-delivered-0001",
    )

    assert result.status_code == 201
    value = result.json()
    assert value["outcome"] == "grounded_reply"
    assert value["selection_basis"] == "grounded_state"
    assert value["detector_id"] is None
    assert value["evidence"][0]["input_index"] == 0
    assert "delivered" in value["message"].lower()


def test_show_choices_without_supporting_state_uses_a_plain_fallback(
    product: ProductHarness,
) -> None:
    payload = _chat_payload(
        "account_lock",
        assistance_mode="show_choices",
        text="",
    )
    payload["external_event_id"] = "chat-choice-fallback"
    payload["evidence"] = []
    result = _post_chat_assist(
        product,
        payload,
        idempotency_key="chat-choice-fallback-0001",
    )

    assert result.status_code == 201
    value = result.json()
    assert value["outcome"] == "clarifying_fallback"
    assert value["integration"] == {
        "host_action": "show_wordless",
        "render_mode": "choices",
    }
    assert value["reason"] == "insufficient_context"
    assert value["message"] == "Choose what you need help with."
    assert [choice["id"] for choice in value["choices"]] == [
        "payment_help",
        "delivery_or_item",
        "account_access",
    ]
    assert all(choice["detector_id"] is None for choice in value["choices"])
    assert all(choice["evidence"] == [] for choice in value["choices"])


def test_chat_assist_is_strict_idempotent_and_documented(
    product: ProductHarness,
) -> None:
    payload = _chat_payload("wrong_item")
    key = "chat-idempotent-contract-0001"
    created = _post_chat_assist(product, payload, idempotency_key=key)
    replayed = _post_chat_assist(product, payload, idempotency_key=key)
    assert created.status_code == 201
    assert replayed.status_code == 200
    assert replayed.headers["Idempotent-Replayed"] == "true"
    assert replayed.json() == created.json()

    invalid = _chat_payload("wrong_item", assistance_mode="auto", text="")
    rejected = _post_chat_assist(
        product,
        invalid,
        idempotency_key="chat-invalid-empty-auto-0001",
    )
    assert rejected.status_code == 422
    assert rejected.json()["error"]["code"] == "invalid_schema"

    extra = _chat_payload("wrong_item")
    extra["unsupported"] = True
    rejected_extra = _post_chat_assist(
        product,
        extra,
        idempotency_key="chat-invalid-extra-field-0001",
    )
    assert rejected_extra.status_code == 422

    schema = product.client.app.openapi()
    operation = schema["paths"]["/v1/chat/assist"]["post"]
    assert operation["security"] == [{"BearerAuth": []}]
    body_schema = operation["requestBody"]["content"]["application/json"]["schema"]
    assert body_schema["title"] == "ChatAssistRequest"
    assert body_schema["additionalProperties"] is False
    assert '"$ref"' not in json.dumps(body_schema)
    assert '"$defs"' not in json.dumps(body_schema)


def test_real_duplicate_candidate_abstention_and_privacy(
    product: ProductHarness,
) -> None:
    candidate = _post_suggestion(
        product,
        _duplicate_payload(),
        idempotency_key="candidate-key-0001",
    )

    assert candidate.status_code == 201
    value = candidate.json()
    assert value["status"] == "completed"
    assert value["outcome"] == "candidates"
    assert value["review_required"] is True
    assert value["candidates"][0]["detector_id"] == "duplicate_charge"
    evidence = value["candidates"][0]["evidence"]
    assert [item["input_index"] for item in evidence] == [0, 1]
    assert all(item["ref"] not in {"charge-100", "charge-101"} for item in evidence)
    assert value["policy"]["score_kind"] == "ranking_not_probability"
    assert "jane@example.com" not in candidate.text
    assert candidate.headers["cache-control"] == "no-store"
    assert candidate.headers["x-content-type-options"] == "nosniff"

    abstention_payload = _duplicate_payload(event_id="evt-abstention")
    abstention_payload["evidence"] = []
    abstention = _post_suggestion(
        product,
        abstention_payload,
        idempotency_key="abstention-key-001",
    )

    assert abstention.status_code == 201
    assert abstention.json()["outcome"] == "abstained"
    assert abstention.json()["abstention_reason"] == "no_evidence_hypotheses"
    assert abstention.json()["candidates"] == []

    database_parts = product.database_path.parent.glob(
        f"{product.database_path.name}*"
    )
    assert all(b"jane@example.com" not in path.read_bytes() for path in database_parts)


def test_openapi_documents_server_auth_signed_headers_and_write_bodies(
    product: ProductHarness,
) -> None:
    schema = product.client.app.openapi()
    security = schema["components"]["securitySchemes"]["BearerAuth"]
    assert security["type"] == "http"
    assert security["scheme"] == "bearer"

    suggestion = schema["paths"]["/v1/suggestions"]["post"]
    assert suggestion["security"] == [{"BearerAuth": []}]
    suggestion_body = suggestion["requestBody"]["content"]["application/json"][
        "schema"
    ]
    assert suggestion_body["title"] == "SuggestionRequest"
    assert suggestion_body["additionalProperties"] is False
    assert '"$ref"' not in json.dumps(suggestion_body)
    assert '"$defs"' not in json.dumps(suggestion_body)
    suggestion_headers = {
        item["name"]: item for item in suggestion["parameters"] if item["in"] == "header"
    }
    assert {
        "Idempotency-Key",
        "X-Wordless-Timestamp",
        "X-Wordless-Signature",
    } <= suggestion_headers.keys()
    assert all(item["required"] is True for item in suggestion_headers.values())

    feedback = schema["paths"][
        "/v1/suggestions/{suggestion_id}/feedback"
    ]["post"]
    feedback_body = feedback["requestBody"]["content"]["application/json"]["schema"]
    assert feedback_body["title"] == "FeedbackRequest"
    assert feedback["security"] == [{"BearerAuth": []}]
    assert schema["paths"]["/v1/suggestions/{suggestion_id}"]["get"][
        "security"
    ] == [{"BearerAuth": []}]


def test_legitimate_under_threshold_lock_state_is_accepted_but_abstains(
    product: ProductHarness,
) -> None:
    payload = _duplicate_payload(event_id="evt-under-threshold-lock")
    payload["utterance"]["text"] = "I cannot sign in to my account."
    payload["evidence"] = [
        {
            "type": "account_access",
            "ref": "login-1",
            "account_ref": "account-1",
            "occurred_at": (NOW - timedelta(minutes=1)).isoformat(),
            "status": "locked",
            "failed_attempts": 2,
        }
    ]

    response = _post_suggestion(
        product,
        payload,
        idempotency_key="under-lock-key-001",
    )

    assert response.status_code == 201
    assert response.json()["outcome"] == "abstained"
    assert response.json()["candidates"] == []


def test_auth_scope_and_signature_fail_closed(product: ProductHarness) -> None:
    body = _body(_duplicate_payload())

    missing_key = product.client.post(
        "/v1/suggestions",
        content=body,
        headers={"Content-Type": "application/json", "Idempotency-Key": "missing-key-00001"},
    )
    assert missing_key.status_code == 401
    assert missing_key.json()["error"]["code"] == "missing_api_key"

    missing_signature = product.client.post(
        "/v1/suggestions",
        content=body,
        headers=_headers(
            body,
            idempotency_key="missing-sign-0001",
            include_signature=False,
        ),
    )
    assert missing_signature.status_code == 401
    assert missing_signature.json()["error"]["code"] == "missing_signature"

    stale = product.client.post(
        "/v1/suggestions",
        content=body,
        headers=_headers(
            body,
            idempotency_key="stale-signature-1",
            timestamp=NOW_SECONDS - 301,
        ),
    )
    assert stale.status_code == 401
    assert stale.json()["error"]["code"] == "stale_signature"

    tampered_headers = _headers(
        body,
        idempotency_key="signed-idem-key-001",
    )
    tampered_headers["Idempotency-Key"] = "signed-idem-key-002"
    tampered_key = product.client.post(
        "/v1/suggestions",
        content=body,
        headers=tampered_headers,
    )
    assert tampered_key.status_code == 401
    assert tampered_key.json()["error"]["code"] == "invalid_signature"

    read_only = product.client.post(
        "/v1/suggestions",
        content=body,
        headers=_headers(
            body,
            key_id="alpha_reader",
            idempotency_key="read-only-key-001",
        ),
    )
    assert read_only.status_code == 403
    assert read_only.json()["error"]["code"] == "insufficient_scope"


def test_idempotency_and_tenant_isolation(product: ProductHarness) -> None:
    payload = _duplicate_payload(event_id="evt-idempotent")
    first = _post_suggestion(
        product,
        payload,
        idempotency_key="idempotent-key-01",
    )
    replay = _post_suggestion(
        product,
        payload,
        idempotency_key="idempotent-key-01",
    )

    assert first.status_code == 201
    assert replay.status_code == 200
    assert replay.headers["idempotent-replayed"] == "true"
    assert replay.json() == first.json()

    changed = _duplicate_payload(event_id="evt-idempotent")
    changed["utterance"]["text"] = "A different request body."
    conflict = _post_suggestion(
        product,
        changed,
        idempotency_key="idempotent-key-01",
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "idempotency_key_reused"

    suggestion_id = first.json()["suggestion_id"]
    assert product.client.get(
        f"/v1/suggestions/{suggestion_id}", headers=_auth(tenant="alpha")
    ).status_code == 200
    hidden = product.client.get(
        f"/v1/suggestions/{suggestion_id}", headers=_auth(tenant="beta")
    )
    assert hidden.status_code == 404
    assert hidden.json()["error"]["code"] == "not_found"


def test_feedback_is_idempotent_and_bound_to_one_suggestion(
    product: ProductHarness,
) -> None:
    first = _post_suggestion(
        product,
        _duplicate_payload(event_id="evt-feedback-1"),
        idempotency_key="feedback-source-01",
    ).json()
    second = _post_suggestion(
        product,
        _duplicate_payload(event_id="evt-feedback-2"),
        idempotency_key="feedback-source-02",
    ).json()
    feedback_payload = {
        "schema_version": 1,
        "outcome": "confirmed",
        "selected_detector_id": "duplicate_charge",
        "actor": "agent",
    }
    body = _body(feedback_payload)
    first_headers = _headers(
        body,
        idempotency_key="feedback-idem-0001",
        path=first["links"]["feedback"],
    )
    second_headers = _headers(
        body,
        idempotency_key="feedback-idem-0001",
        path=second["links"]["feedback"],
    )

    recorded = product.client.post(
        first["links"]["feedback"], content=body, headers=first_headers
    )
    replay = product.client.post(
        first["links"]["feedback"], content=body, headers=first_headers
    )
    cross_suggestion = product.client.post(
        second["links"]["feedback"], content=body, headers=second_headers
    )

    assert recorded.status_code == 200
    assert recorded.json()["recorded"] is True
    assert replay.status_code == 200
    assert replay.json() == recorded.json()
    assert cross_suggestion.status_code == 409
    assert cross_suggestion.json()["error"]["code"] == "idempotency_key_reused"


def test_sse_is_tenant_scoped_resumable_and_contains_no_request_text(
    product: ProductHarness,
) -> None:
    created = _post_suggestion(
        product,
        _duplicate_payload(event_id="evt-sse"),
        idempotency_key="sse-source-key-01",
    ).json()
    events_url = created["links"]["events"]

    stream = product.client.get(events_url, headers=_auth())
    resumed = product.client.get(
        events_url,
        headers={**_auth(), "Last-Event-ID": "2"},
    )
    hidden = product.client.get(events_url, headers=_auth(tenant="beta"))
    oversized_cursor = product.client.get(
        events_url,
        headers={**_auth(), "Last-Event-ID": "9223372036854775808"},
    )

    assert stream.status_code == 200
    assert stream.headers["content-type"].startswith("text/event-stream")
    assert [line for line in stream.text.splitlines() if line.startswith("id: ")] == [
        "id: 1",
        "id: 2",
        "id: 3",
    ]
    assert "event: suggestion.completed" in stream.text
    assert "jane@example.com" not in stream.text
    assert [line for line in resumed.text.splitlines() if line.startswith("id: ")] == [
        "id: 3"
    ]
    assert hidden.status_code == 404
    assert oversized_cursor.status_code == 400
    assert oversized_cursor.json()["error"]["code"] == "invalid_last_event_id"


def test_strict_body_media_depth_size_and_future_time_are_safe(
    product: ProductHarness,
) -> None:
    duplicate = b'{"schema_version":1,"schema_version":1}'
    duplicate_response = product.client.post(
        "/v1/suggestions",
        content=duplicate,
        headers=_headers(duplicate, idempotency_key="duplicate-json-001"),
    )
    assert duplicate_response.status_code == 400
    assert duplicate_response.json()["error"]["code"] == "invalid_json"

    deep_payload = _duplicate_payload(event_id="evt-deep")
    nested: object = "private@example.com"
    for _ in range(20):
        nested = {"nested": nested}
    deep_payload["metadata"] = {"value": nested}
    deep_body = _body(deep_payload)
    deep = product.client.post(
        "/v1/suggestions",
        content=deep_body,
        headers=_headers(deep_body, idempotency_key="deep-json-key-001"),
    )
    assert deep.status_code == 400
    assert deep.json()["error"]["code"] == "invalid_json"
    assert "private@example.com" not in deep.text

    plain_body = _body(_duplicate_payload(event_id="evt-media"))
    media = product.client.post(
        "/v1/suggestions",
        content=plain_body,
        headers=_headers(
            plain_body,
            idempotency_key="media-type-key-01",
            content_type="text/plain",
        ),
    )
    assert media.status_code == 415
    assert media.json()["error"]["code"] == "unsupported_media_type"

    future_payload = _duplicate_payload(event_id="evt-future")
    future = NOW + timedelta(seconds=301)
    future_payload["observed_at"] = future.isoformat()
    future_payload["utterance"]["sent_at"] = future.isoformat()
    future_body = _body(future_payload)
    future_response = product.client.post(
        "/v1/suggestions",
        content=future_body,
        headers=_headers(future_body, idempotency_key="future-time-key-01"),
    )
    assert future_response.status_code == 422
    assert future_response.json()["error"]["code"] == "observed_at_in_future"

    oversized_payload = _duplicate_payload(event_id="evt-oversized")
    oversized_payload["metadata"] = {"value": "x" * 263_000}
    oversized_body = _body(oversized_payload)
    oversized = product.client.post(
        "/v1/suggestions",
        content=oversized_body,
        headers=_headers(oversized_body, idempotency_key="oversized-key-001"),
    )
    assert oversized.status_code == 413
    assert oversized.json()["error"]["code"] == "request_too_large"

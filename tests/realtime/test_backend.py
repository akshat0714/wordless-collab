from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
import hashlib
import hmac
import json
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError

from wordless.realtime.auth import (
    AuthenticationError,
    TenantPrincipal,
    TenantRegistry,
    canonical_request_signature_bytes,
    verify_request_signature,
)
from wordless.realtime.config import (
    DEV_MODEL_ID,
    DEV_MODEL_REVISION,
    ProductSettings,
)
from wordless.realtime.contracts import ChatAssistRequest, SuggestionRequest
from wordless.realtime.service import ProductRuntime


PEPPER = "pepper-0123456789-abcdefghijklmnop"
API_SECRET = "api-secret-0123456789-abcdefghij"
SIGNING_SECRET = "signing-secret-0123456789-abcdef"
CUSTOMER_HMAC_KEY = "customer-hmac-0123456789-abcdefgh"
API_KEY = f"wl_live_alpha.{API_SECRET}"


def settings(tmp_path: Path, **updates: object) -> ProductSettings:
    payload: dict[str, object] = {
        "workspace": tmp_path,
        "database_path": Path("realtime.sqlite3"),
        "model_cache_dir": Path("model-cache"),
        "embedding_model_id": DEV_MODEL_ID,
        "embedding_model_revision": DEV_MODEL_REVISION,
        "threshold": 1.6,
        "threshold_version": "tenant-evaluation-2026-07-25",
    }
    payload.update(updates)
    return ProductSettings.model_validate(payload)


def tenant_document(*, revoked: object = False) -> str:
    return json.dumps(
        {
            "alpha": {
                "api_keys": [
                    {
                        "id": "alpha",
                        "secret": API_SECRET,
                        "scopes": [
                            "suggestions:read",
                            "suggestions:write",
                            "feedback:write",
                        ],
                        "revoked": revoked,
                    }
                ],
                "customer_hmac_key": CUSTOMER_HMAC_KEY,
                "signing_secrets": [SIGNING_SECRET],
            }
        }
    )


def test_tenant_registry_accepts_strict_json_arrays_without_coercion(
    tmp_path: Path,
) -> None:
    active = settings(tmp_path)
    registry = TenantRegistry.from_env(
        active,
        {
            "WORDLESS_REALTIME_TENANTS_JSON": tenant_document(),
            "WORDLESS_REALTIME_API_KEY_PEPPER": PEPPER,
        },
    )

    principal = registry.authenticate(f"Bearer {API_KEY}")

    assert principal.tenant_id == "alpha"
    assert principal.key_id == "alpha"
    assert principal.signing_secrets == (SIGNING_SECRET.encode(),)

    with pytest.raises(ValidationError, match="revoked"):
        TenantRegistry.from_env(
            active,
            {
                "WORDLESS_REALTIME_TENANTS_JSON": tenant_document(revoked="false"),
                "WORDLESS_REALTIME_API_KEY_PEPPER": PEPPER,
            },
        )


def test_tenant_registry_rejects_duplicate_tenant_keys(tmp_path: Path) -> None:
    active = settings(tmp_path)
    config = tenant_document()
    alpha = json.loads(config)["alpha"]
    duplicate = "{" + f'"alpha":{json.dumps(alpha)},"alpha":{json.dumps(alpha)}' + "}"

    with pytest.raises(ValueError, match="invalid"):
        TenantRegistry.from_env(
            active,
            {
                "WORDLESS_REALTIME_TENANTS_JSON": duplicate,
                "WORDLESS_REALTIME_API_KEY_PEPPER": PEPPER,
            },
        )


def test_tenant_registry_reads_mounted_secret_files(tmp_path: Path) -> None:
    active = settings(tmp_path)
    tenants_path = tmp_path / "tenants.json"
    pepper_path = tmp_path / "pepper"
    tenants_path.write_text(tenant_document() + "\n", encoding="utf-8")
    pepper_path.write_text(PEPPER + "\n", encoding="utf-8")

    registry = TenantRegistry.from_env(
        active,
        {
            "WORDLESS_REALTIME_TENANTS_JSON_FILE": str(tenants_path),
            "WORDLESS_REALTIME_API_KEY_PEPPER_FILE": str(pepper_path),
        },
    )

    assert registry.authenticate(f"Bearer {API_KEY}").tenant_id == "alpha"


def test_tenant_registry_rejects_ambiguous_or_relative_secret_files(
    tmp_path: Path,
) -> None:
    active = settings(tmp_path)
    tenants_path = tmp_path / "tenants.json"
    tenants_path.write_text(tenant_document(), encoding="utf-8")

    with pytest.raises(ValueError, match="configure only one"):
        TenantRegistry.from_env(
            active,
            {
                "WORDLESS_REALTIME_TENANTS_JSON": tenant_document(),
                "WORDLESS_REALTIME_TENANTS_JSON_FILE": str(tenants_path),
                "WORDLESS_REALTIME_API_KEY_PEPPER": PEPPER,
            },
        )

    with pytest.raises(ValueError, match="absolute path"):
        TenantRegistry.from_env(
            active,
            {
                "WORDLESS_REALTIME_TENANTS_JSON_FILE": "tenants.json",
                "WORDLESS_REALTIME_API_KEY_PEPPER": PEPPER,
            },
        )


def test_production_settings_cannot_disable_signatures(tmp_path: Path) -> None:
    with pytest.raises(ValidationError, match="exact-body request signatures"):
        settings(tmp_path, require_signatures=False)

    development = settings(tmp_path, dev_mode=True)
    assert development.require_signatures is False


def test_production_settings_require_explicit_non_demo_threshold_policy(
    tmp_path: Path,
) -> None:
    base: dict[str, object] = {
        "workspace": tmp_path,
        "database_path": Path("realtime.sqlite3"),
        "model_cache_dir": Path("model-cache"),
        "embedding_model_id": DEV_MODEL_ID,
        "embedding_model_revision": DEV_MODEL_REVISION,
    }
    with pytest.raises(ValidationError, match="explicitly configured nonzero threshold"):
        ProductSettings.model_validate(base)
    with pytest.raises(ValidationError, match="explicitly configured nonzero threshold"):
        ProductSettings.model_validate({**base, "threshold": 0.0})
    with pytest.raises(ValidationError, match="non-placeholder threshold_version"):
        ProductSettings.model_validate(
            {**base, "threshold": 1.6, "threshold_version": "pilot-v1"}
        )

    development = ProductSettings.model_validate(
        {
            "workspace": tmp_path,
            "database_path": Path("realtime.sqlite3"),
            "model_cache_dir": Path("model-cache"),
            "dev_mode": True,
        }
    )
    assert development.threshold == 1.5
    assert development.threshold_version == "demo-floor-v1"


def test_exact_body_signature_and_timestamp_are_enforced(tmp_path: Path) -> None:
    active = settings(tmp_path)
    registry = TenantRegistry.from_env(
        active,
        {
            "WORDLESS_REALTIME_TENANTS_JSON": tenant_document(),
            "WORDLESS_REALTIME_API_KEY_PEPPER": PEPPER,
        },
    )
    principal = registry.authenticate(f"Bearer {API_KEY}")
    body = b'{"schema_version":1}'
    timestamp = "1785020000"
    method = "POST"
    path = "/v1/suggestions"
    idempotency_key = "suggestion-key-0001"
    signed = canonical_request_signature_bytes(
        timestamp=timestamp,
        method=method.lower(),
        path=path,
        idempotency_key=idempotency_key,
        body=body,
    )
    assert signed == (
        b"v1:1785020000\nPOST\n/v1/suggestions\n"
        b"suggestion-key-0001\n{\"schema_version\":1}"
    )
    digest = hmac.new(
        SIGNING_SECRET.encode(),
        signed,
        hashlib.sha256,
    ).hexdigest()

    verify_request_signature(
        principal,
        body,
        timestamp_header=timestamp,
        signature_header=f"v1={digest}",
        method=method,
        path=path,
        idempotency_key=idempotency_key,
        tolerance_seconds=300,
        now_seconds=int(timestamp),
    )

    # Key rotation accepts either configured secret without weakening the
    # canonical payload binding.
    verify_request_signature(
        replace(principal, signing_secrets=(b"previous-signing-secret-0123456789", SIGNING_SECRET.encode())),
        body,
        timestamp_header=timestamp,
        signature_header=f"v1={digest}",
        method=method,
        path=path,
        idempotency_key=idempotency_key,
        tolerance_seconds=300,
        now_seconds=int(timestamp),
    )

    with pytest.raises(AuthenticationError) as stale:
        verify_request_signature(
            principal,
            body,
            timestamp_header=timestamp,
            signature_header=f"v1={digest}",
            method=method,
            path=path,
            idempotency_key=idempotency_key,
            tolerance_seconds=300,
            now_seconds=int(timestamp) + 301,
        )
    assert stale.value.code == "stale_signature"

    mutations = (
        {"body": body + b" "},
        {"method": "PUT"},
        {"path": "/v1/suggestions/sg_00000000000000000000000000000000/feedback"},
        {"idempotency_key": "suggestion-key-0002"},
    )
    for mutation in mutations:
        with pytest.raises(AuthenticationError) as changed:
            verify_request_signature(
                principal,
                mutation.get("body", body),
                timestamp_header=timestamp,
                signature_header=f"v1={digest}",
                method=mutation.get("method", method),
                path=mutation.get("path", path),
                idempotency_key=mutation.get("idempotency_key", idempotency_key),
                tolerance_seconds=300,
                now_seconds=int(timestamp),
            )
        assert changed.value.code == "invalid_signature"


def test_product_runtime_fails_closed_without_ephemeral_embedding() -> None:
    class PersistentOnlyEmbedder:
        def encode(self, texts: object) -> np.ndarray:
            return np.ones((1, 2), dtype=np.float32)

    with pytest.raises(TypeError, match="encode_ephemeral"):
        ProductRuntime(
            embedder=PersistentOnlyEmbedder(),
            model_id=DEV_MODEL_ID,
            model_revision=DEV_MODEL_REVISION,
            threshold=0.0,
            threshold_version="test-v1",
        )


def test_unrelated_utterance_with_adverse_state_abstains_at_configured_floor() -> None:
    class OrthogonalEmbedder:
        def encode_ephemeral(self, texts: object) -> np.ndarray:
            values = tuple(texts)  # type: ignore[arg-type]
            matrix = np.zeros((len(values), 2), dtype=np.float32)
            matrix[0, 0] = 1.0
            matrix[1:, 1] = 1.0
            return matrix

    now = datetime(2026, 7, 25, 20, 0, tzinfo=UTC)
    # This is an illustrative tenant-configured contract-test floor, not a
    # calibrated operating point or a production accuracy claim.
    runtime = ProductRuntime(
        embedder=OrthogonalEmbedder(),
        model_id=DEV_MODEL_ID,
        model_revision=DEV_MODEL_REVISION,
        threshold=1.6,
        threshold_version="tenant-evaluation-2026-07-25",
        clock=lambda: now,
    )
    request = SuggestionRequest.model_validate_json(
        json.dumps(
            {
                "schema_version": 1,
                "external_event_id": "evt-unrelated-lock",
                "observed_at": now.isoformat(),
                "channel": "chat",
                "customer_external_id": "customer-unrelated-lock",
                "utterance": {
                    "sent_at": now.isoformat(),
                    "text": "Where can I change my newsletter preferences?",
                },
                "evidence": [
                    {
                        "type": "account_access",
                        "ref": "login-adverse-1",
                        "account_ref": "account-adverse-1",
                        "occurred_at": (now - timedelta(minutes=1)).isoformat(),
                        "status": "locked",
                        "failed_attempts": 4,
                    }
                ],
                "source_system": "test",
                "metadata": {},
            }
        ),
        strict=True,
    )

    evaluation = runtime.evaluate(
        principal=TenantPrincipal(
            tenant_id="alpha",
            key_id="alpha",
            scopes=frozenset(),
            customer_hmac_key=CUSTOMER_HMAC_KEY.encode(),
            signing_secrets=(SIGNING_SECRET.encode(),),
        ),
        request=request,
        suggestion_id="sg_11111111111111111111111111111111",
    )

    assert evaluation.response.outcome == "abstained"
    assert evaluation.response.abstention_reason == "below_confidence_floor"
    assert evaluation.response.candidates == ()
    assert evaluation.response.policy.threshold == 1.6
    assert (
        evaluation.response.policy.threshold_version
        == "tenant-evaluation-2026-07-25"
    )


def test_unrelated_chat_message_with_adverse_state_continues_host_bot() -> None:
    class OrthogonalEmbedder:
        def encode_ephemeral(self, texts: object) -> np.ndarray:
            values = tuple(texts)  # type: ignore[arg-type]
            matrix = np.zeros((len(values), 2), dtype=np.float32)
            matrix[0, 0] = 1.0
            matrix[1:, 1] = 1.0
            return matrix

    now = datetime(2026, 7, 25, 20, 0, tzinfo=UTC)
    runtime = ProductRuntime(
        embedder=OrthogonalEmbedder(),
        model_id=DEV_MODEL_ID,
        model_revision=DEV_MODEL_REVISION,
        threshold=1.6,
        threshold_version="tenant-evaluation-2026-07-25",
        clock=lambda: now,
    )
    request = ChatAssistRequest.model_validate_json(
        json.dumps(
            {
                "schema_version": 1,
                "external_event_id": "chat-unrelated-lock",
                "observed_at": now.isoformat(),
                "channel": "chat",
                "customer_external_id": "customer-unrelated-lock",
                "message": {
                    "sent_at": now.isoformat(),
                    "text": "Where can I change my newsletter preferences?",
                },
                "assistance_mode": "auto",
                "evidence": [
                    {
                        "type": "account_access",
                        "ref": "login-adverse-chat-1",
                        "account_ref": "account-adverse-chat-1",
                        "occurred_at": (now - timedelta(minutes=1)).isoformat(),
                        "status": "locked",
                        "failed_attempts": 4,
                    }
                ],
                "source_system": "host_chatbot",
                "metadata": {},
            }
        ),
        strict=True,
    )
    principal = TenantPrincipal(
        tenant_id="alpha",
        key_id="alpha",
        scopes=frozenset(),
        customer_hmac_key=CUSTOMER_HMAC_KEY.encode(),
        signing_secrets=(SIGNING_SECRET.encode(),),
    )

    evaluation = runtime.evaluate_chat(
        principal=principal,
        request=request,
        suggestion_id="sg_22222222222222222222222222222222",
    )

    assert evaluation.runtime.response.outcome == "abstained"
    assert evaluation.response.outcome == "clarifying_fallback"
    assert evaluation.response.integration.host_action == "continue_host_bot"
    assert evaluation.response.integration.render_mode == "none"
    assert evaluation.response.message is None
    assert evaluation.response.reason == "below_confidence_floor"
    assert evaluation.response.evidence == ()


def test_runtime_event_timestamps_bracket_pipeline_inference() -> None:
    class EphemeralEmbedder:
        def encode_ephemeral(self, texts: object) -> np.ndarray:
            values = tuple(texts)  # type: ignore[arg-type]
            return np.ones((len(values), 2), dtype=np.float32)

    moments = (
        datetime(2026, 7, 25, 20, 0, tzinfo=UTC),
        datetime(2026, 7, 25, 20, 0, 1, tzinfo=UTC),
        datetime(2026, 7, 25, 20, 0, 2, tzinfo=UTC),
    )
    moment_iter = iter(enumerate(moments))
    trace: list[str] = []

    def clock() -> datetime:
        index, value = next(moment_iter)
        trace.append(f"clock:{index}")
        return value

    runtime = ProductRuntime(
        embedder=EphemeralEmbedder(),
        model_id=DEV_MODEL_ID,
        model_revision=DEV_MODEL_REVISION,
        threshold=0.0,
        threshold_version="test-v1",
        clock=clock,
    )
    delegate = runtime.pipeline

    class TracingPipeline:
        def run(self, interaction: object):
            trace.append("pipeline")
            return delegate.run(interaction)  # type: ignore[arg-type]

    runtime.pipeline = TracingPipeline()  # type: ignore[assignment]
    observed_at = moments[0] - timedelta(minutes=1)
    request = SuggestionRequest.model_validate_json(
        json.dumps(
            {
                "schema_version": 1,
                "external_event_id": "evt-timing",
                "observed_at": observed_at.isoformat(),
                "channel": "chat",
                "customer_external_id": "customer-timing",
                "utterance": {
                    "sent_at": observed_at.isoformat(),
                    "text": "I need help with my account.",
                },
                "evidence": [],
                "source_system": "test",
                "metadata": {},
            }
        ),
        strict=True,
    )

    evaluation = runtime.evaluate(
        principal=TenantPrincipal(
            tenant_id="alpha",
            key_id="alpha",
            scopes=frozenset(),
            customer_hmac_key=CUSTOMER_HMAC_KEY.encode(),
            signing_secrets=(SIGNING_SECRET.encode(),),
        ),
        request=request,
        suggestion_id="sg_00000000000000000000000000000000",
    )

    assert trace == ["clock:0", "clock:1", "pipeline", "clock:2"]
    assert tuple(event.occurred_at for event in evaluation.events) == moments


class _ConceptEphemeralEmbedder:
    def encode_ephemeral(self, texts: object) -> np.ndarray:
        vectors: list[list[float]] = []
        for value in tuple(texts):  # type: ignore[arg-type]
            text = str(value).casefold()
            if any(
                phrase in text
                for phrase in (
                    "money twice",
                    "charged twice",
                    "money taken twice",
                    "paid two times",
                    "duplicate card charge",
                )
            ):
                vectors.append([1.0, 0.0, 0.0, 0.0, 0.0])
            elif any(
                phrase in text
                for phrase in (
                    "pakg not come",
                    "package never arrived",
                    "delivery is late",
                    "still not come",
                    "order has not arrived",
                    "package overdue",
                )
            ):
                vectors.append([0.0, 1.0, 0.0, 0.0, 0.0])
            elif any(
                phrase in text
                for phrase in (
                    "thing box different",
                    "wrong item",
                    "order wrong thing",
                    "different product",
                    "not what i ordered",
                )
            ):
                vectors.append([0.0, 0.0, 1.0, 0.0, 0.0])
            elif any(
                phrase in text
                for phrase in (
                    "cant in account",
                    "account is locked",
                    "cannot get in",
                    "login blocked",
                    "too many attempts",
                )
            ):
                vectors.append([0.0, 0.0, 0.0, 1.0, 0.0])
            else:
                # Cosine 0.39 against every concept axis: high enough for the
                # old aggregate 1.5 threshold, but intentionally below the
                # independent chat-auto semantic support floor.
                vectors.append([0.39, 0.39, 0.39, 0.39, 0.62578])
        return np.asarray(vectors, dtype=np.float32)


def _concept_runtime(
    now: datetime,
    *,
    threshold: float = 1.6,
) -> ProductRuntime:
    return ProductRuntime(
        embedder=_ConceptEphemeralEmbedder(),
        model_id=DEV_MODEL_ID,
        model_revision=DEV_MODEL_REVISION,
        threshold=threshold,
        threshold_version="context-routing-evaluation-2026-07-30",
        clock=lambda: now,
    )


def _principal() -> TenantPrincipal:
    return TenantPrincipal(
        tenant_id="alpha",
        key_id="alpha",
        scopes=frozenset(),
        customer_hmac_key=CUSTOMER_HMAC_KEY.encode(),
        signing_secrets=(SIGNING_SECRET.encode(),),
    )


def _case_evidence(case: str, now: datetime) -> list[dict[str, object]]:
    if case == "duplicate_charge":
        return [
            {
                "type": "charge",
                "ref": "charge-one",
                "order_ref": "order-one",
                "occurred_at": (now - timedelta(minutes=20)).isoformat(),
                "amount": "42.00",
                "currency": "USD",
                "status": "succeeded",
            },
            {
                "type": "charge",
                "ref": "charge-two",
                "order_ref": "order-one",
                "occurred_at": (now - timedelta(minutes=10)).isoformat(),
                "amount": "42.00",
                "currency": "USD",
                "status": "succeeded",
            },
        ]
    if case == "late_delivery":
        return [
            {
                "type": "shipment",
                "ref": "shipment-late",
                "order_ref": "order-late",
                "occurred_at": (now - timedelta(minutes=30)).isoformat(),
                "status": "delayed",
                "expected_delivery_at": (now - timedelta(days=1)).isoformat(),
            }
        ]
    if case == "wrong_item":
        return [
            {
                "type": "fulfillment",
                "ref": "fulfillment-wrong",
                "order_ref": "order-wrong",
                "occurred_at": (now - timedelta(minutes=30)).isoformat(),
                "ordered_sku": "blue-shirt",
                "delivered_sku": "red-mug",
                "status": "wrong_item",
            }
        ]
    if case == "account_lock":
        return [
            {
                "type": "account_access",
                "ref": "login-locked",
                "account_ref": "account-locked",
                "occurred_at": (now - timedelta(minutes=5)).isoformat(),
                "status": "locked",
                "failed_attempts": 4,
            }
        ]
    raise AssertionError(f"unknown case {case}")


def _chat_request(
    *,
    now: datetime,
    event_id: str,
    text: str,
    evidence: list[dict[str, object]],
    assistance_mode: str = "auto",
    metadata: dict[str, object] | None = None,
) -> ChatAssistRequest:
    return ChatAssistRequest.model_validate_json(
        json.dumps(
            {
                "schema_version": 1,
                "external_event_id": event_id,
                "observed_at": now.isoformat(),
                "channel": "chat",
                "customer_external_id": f"customer-{event_id}",
                "message": {"sent_at": now.isoformat(), "text": text},
                "assistance_mode": assistance_mode,
                "evidence": evidence,
                "source_system": "host_chatbot",
                "metadata": metadata or {},
            }
        ),
        strict=True,
    )


def test_realtime_interaction_id_cannot_false_positive_as_pii() -> None:
    """A former hex HMAC for this event contained a Luhn-valid 13-digit run."""

    now = datetime(2026, 7, 30, 20, 0, tzinfo=UTC)
    evaluation = _concept_runtime(now).evaluate_chat(
        principal=_principal(),
        request=_chat_request(
            now=now,
            event_id="console-chat:pii-false-positive-32",
            text="chaged twcie",
            evidence=_case_evidence("duplicate_charge", now),
        ),
        suggestion_id="sg_33333333333333333333333333333333",
    )

    assert evaluation.runtime.interaction.id.startswith("EVT-")
    assert len(evaluation.runtime.interaction.id) == 64
    assert evaluation.response.outcome == "clarification_choices"


@pytest.mark.parametrize(
    "case,fragment,selection_basis",
    (
        ("duplicate_charge", "mney twcie", "evidence_and_message"),
        ("late_delivery", "pakg no com", "evidence_and_message"),
        ("wrong_item", "thing box difrent", "evidence_and_message"),
        ("account_lock", "cant in acount", "evidence_and_message"),
        ("account_lock", "asdf qqq", "contextual_evidence_choices"),
        ("duplicate_charge", "need it agin", "contextual_evidence_choices"),
    ),
)
def test_incomplete_message_preserves_resolved_concepts_or_uses_context(
    case: str,
    fragment: str,
    selection_basis: str,
) -> None:
    now = datetime(2026, 7, 30, 20, 0, tzinfo=UTC)
    evaluation = _concept_runtime(now).evaluate_chat(
        principal=_principal(),
        request=_chat_request(
            now=now,
            event_id=f"garbled-{case}",
            text=fragment,
            evidence=_case_evidence(case, now),
        ),
        suggestion_id=f"sg_{case.encode().hex():0<32}"[:35],
    )

    assert evaluation.runtime.response.outcome == "candidates"
    assert evaluation.response.outcome == "clarification_choices"
    assert evaluation.response.selection_basis == selection_basis
    assert evaluation.response.detector_id == case
    assert evaluation.response.message is not None
    assert evaluation.response.message.startswith("You don’t need the exact words.")
    assert [choice.id for choice in evaluation.response.choices] == [
        f"confirm_{case}",
        "something_else",
    ]
    assert evaluation.response.integration.host_action == "show_wordless"
    expected_event_basis = (
        "contextual evidence-only ranking"
        if selection_basis == "contextual_evidence_choices"
        else "detector-local repaired message ranking"
    )
    assert expected_event_basis in evaluation.runtime.events[-1].detail


def test_vague_help_uses_current_evidence_but_clear_unrelated_text_does_not() -> None:
    now = datetime(2026, 7, 30, 20, 0, tzinfo=UTC)
    runtime = _concept_runtime(now, threshold=1.5)
    evidence = _case_evidence("account_lock", now)

    vague = runtime.evaluate_chat(
        principal=_principal(),
        request=_chat_request(
            now=now,
            event_id="vague-help",
            text="help",
            evidence=evidence,
        ),
        suggestion_id="sg_33333333333333333333333333333333",
    )
    assert vague.response.selection_basis == "contextual_evidence_choices"
    assert vague.response.detector_id == "account_lock"

    for index, message in enumerate(
        ("hello there", "I need a receipt", "store hours", "mailing address")
    ):
        unrelated = runtime.evaluate_chat(
            principal=_principal(),
            request=_chat_request(
                now=now,
                event_id=f"ordinary-{index}",
                text=message,
                evidence=evidence,
            ),
            suggestion_id=f"sg_{index + 4:032x}",
        )
        assert unrelated.runtime.response.outcome == "abstained"
        assert unrelated.response.integration.host_action == "continue_host_bot"
        assert unrelated.response.message is None


def test_explicit_composition_can_offer_two_supported_intents_plus_safe_exit() -> None:
    now = datetime(2026, 7, 30, 20, 0, tzinfo=UTC)
    evidence = [
        *_case_evidence("duplicate_charge", now),
        *_case_evidence("account_lock", now),
    ]

    evaluation = _concept_runtime(now).evaluate_chat(
        principal=_principal(),
        request=_chat_request(
            now=now,
            event_id="two-supported-choices",
            text="",
            evidence=evidence,
            assistance_mode="show_choices",
        ),
        suggestion_id="sg_88888888888888888888888888888888",
    )

    assert evaluation.response.selection_basis == "explicit_evidence_choices"
    assert evaluation.response.message == (
        "You don’t need the exact words. Choose what fits best."
    )
    supported = [
        choice for choice in evaluation.response.choices if choice.detector_id
    ]
    assert len(supported) == 2
    assert {choice.detector_id for choice in supported} == {
        "account_lock",
        "duplicate_charge",
    }
    assert evaluation.response.choices[-1].id == "something_else"
    assert evaluation.response.choices[-1].detector_id is None
    assert evaluation.response.choices[-1].evidence == ()


def test_recent_customer_context_can_rank_an_incomplete_pronoun() -> None:
    now = datetime(2026, 7, 30, 20, 0, tzinfo=UTC)
    request = _chat_request(
        now=now,
        event_id="recent-context",
        text="it",
        evidence=_case_evidence("late_delivery", now),
        metadata={
            "wordless_recent_customer_messages": [
                "my package never arrived",
            ]
        },
    )

    evaluation = _concept_runtime(now).evaluate_chat(
        principal=_principal(),
        request=request,
        suggestion_id="sg_99999999999999999999999999999999",
    )

    assert evaluation.response.detector_id == "late_delivery"
    assert evaluation.response.selection_basis == "evidence_and_message"


def test_all_evidence_families_preserve_resolved_typo_intent_and_bound_fallback() -> None:
    now = datetime(2026, 7, 30, 20, 0, tzinfo=UTC)
    runtime = _concept_runtime(now, threshold=1.5)
    evidence = [
        *_case_evidence("duplicate_charge", now),
        *_case_evidence("late_delivery", now),
        *_case_evidence("wrong_item", now),
        *_case_evidence("account_lock", now),
    ]

    resolved = (
        ("mney twcie", "duplicate_charge"),
        ("pakg no com", "late_delivery"),
        ("thing box difrent", "wrong_item"),
        ("cant in acount", "account_lock"),
    )
    for index, (message, expected_detector) in enumerate(resolved, start=20):
        evaluation = runtime.evaluate_chat(
            principal=_principal(),
            request=_chat_request(
                now=now,
                event_id=f"all-evidence-resolved-{index}",
                text=message,
                evidence=evidence,
            ),
            suggestion_id=f"sg_{index:032x}",
        )
        assert evaluation.response.selection_basis == "evidence_and_message"
        assert evaluation.response.detector_id == expected_detector
        assert evaluation.response.choices[0].detector_id == expected_detector

    for index, message in enumerate(("asdf qqq", "need it agin"), start=30):
        evaluation = runtime.evaluate_chat(
            principal=_principal(),
            request=_chat_request(
                now=now,
                event_id=f"all-evidence-context-{index}",
                text=message,
                evidence=evidence,
            ),
            suggestion_id=f"sg_{index:032x}",
        )
        assert evaluation.response.selection_basis == "contextual_evidence_choices"
        assert evaluation.response.detector_id == "account_lock"
        assert evaluation.response.choices[0].detector_id == "account_lock"

    clear_messages = (
        "hello there",
        "I need a receipt",
        "store hours",
        "mailing address",
        "Can I order two blue shirts?",
    )
    for index, message in enumerate(clear_messages, start=40):
        evaluation = runtime.evaluate_chat(
            principal=_principal(),
            request=_chat_request(
                now=now,
                event_id=f"all-evidence-clear-{index}",
                text=message,
                evidence=evidence,
            ),
            suggestion_id=f"sg_{index:032x}",
        )
        assert evaluation.runtime.response.outcome == "abstained"
        assert evaluation.response.integration.host_action == "continue_host_bot"

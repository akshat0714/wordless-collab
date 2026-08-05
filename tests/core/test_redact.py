from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import pytest

from wordless.core.models import (
    Interaction,
    Message,
    Resolution,
    StateFact,
    hash_customer_key,
)
from wordless.core.redact import RedactionReport, Redactor


@dataclass
class PresidioFinding:
    entity_type: str
    start: int
    end: int


class FakeAnalyzer:
    def __init__(self, findings: list[PresidioFinding]) -> None:
        self.findings = findings
        self.calls = 0

    def analyze(self, **kwargs: object) -> list[PresidioFinding]:
        self.calls += 1
        return self.findings


class CurrencyFalsePositiveAnalyzer:
    def analyze(self, **kwargs: object) -> list[PresidioFinding]:
        text = str(kwargs.get("text", ""))
        if text == "USD":
            return [PresidioFinding("LOCATION", 0, 3)]
        return []


class StructuredSignalAnalyzer:
    def analyze(self, **kwargs: object) -> list[PresidioFinding]:
        text = str(kwargs.get("text", ""))
        if text == "USD":
            return [PresidioFinding("LOCATION", 0, 3)]
        if text in {"Amy", "Amy 123", "Jane Doe"}:
            return [PresidioFinding("PERSON", 0, len(text))]
        return []


class ExplodingAnalyzer:
    def analyze(self, **_kwargs: object) -> list[PresidioFinding]:
        raise RuntimeError("NLP input rejected")


def test_regex_fallback_redacts_required_pii_entity_types() -> None:
    text = (
        "My name is Jane Doe. Email jane@example.com or call 415-555-1212. "
        "Card 4111 1111 1111 1111, SSN 123-45-6789, DOB: 01/02/1980. "
        "Send it to 123 Main Street Apt 4B."
    )

    result = Redactor(use_presidio=False).redact(text)

    assert "Jane Doe" not in result.text
    assert "jane@example.com" not in result.text
    assert "415-555-1212" not in result.text
    assert "4111 1111 1111 1111" not in result.text
    assert "123-45-6789" not in result.text
    assert "01/02/1980" not in result.text
    assert "123 Main Street" not in result.text
    assert result.report.entity_counts == {
        "ADDRESS": 1,
        "CREDIT_CARD": 1,
        "DATE_OF_BIRTH": 1,
        "EMAIL_ADDRESS": 1,
        "NATIONAL_ID": 1,
        "PERSON": 1,
        "PHONE_NUMBER": 1,
    }
    assert result.report.detectors == ("regex",)


def test_isolated_product_allowlist_is_preserved_but_not_boundary_safe() -> None:
    text = (
        "Turbo Kettle order ORD-12345 SKU: KT-900 was charged $84.00 and USD 12.50. "
        "Email jane@example.com."
    )
    product_start = text.index("Turbo Kettle")
    analyzer = FakeAnalyzer(
        [PresidioFinding("PERSON", product_start, product_start + len("Turbo Kettle"))]
    )

    redactor = Redactor(product_names=("Turbo Kettle",), analyzer=analyzer)
    result = redactor.redact(text)

    assert "Turbo Kettle" in result.text
    assert "ORD-12345" in result.text
    assert "KT-900" in result.text
    assert "$84.00" in result.text
    assert "USD 12.50" in result.text
    assert "jane@example.com" not in result.text
    assert analyzer.calls == 1
    assert result.report.detectors == ("presidio", "regex")
    assert redactor.boundary_safe is False


@pytest.mark.parametrize(
    "term",
    (
        "alice@example.com",
        "415-555-1212",
        "4111 1111 1111 1111",
        "123-45-6789",
        "DOB: 01/02/1980",
        "123 Main Street",
    ),
)
def test_preservation_configuration_rejects_high_confidence_pii(term: str) -> None:
    with pytest.raises(ValueError, match="high-confidence PII"):
        Redactor(product_names=(term,), use_presidio=False)


@pytest.mark.parametrize(
    "text, private_value",
    (
        ("ticket 4111111111111111", "4111111111111111"),
        ("order 123-45-6789", "123-45-6789"),
        ("SKU: 4111111111111111", "4111111111111111"),
        ("order 415-555-1212", "415-555-1212"),
    ),
)
def test_structured_identifier_patterns_never_override_pii(
    text: str,
    private_value: str,
) -> None:
    result = Redactor(use_presidio=False).redact(text)

    assert private_value not in result.text
    assert result.findings


def test_address_detector_does_not_start_inside_order_identifier() -> None:
    text = "ORD-7280 has a tablet still on the way. Send it to 123 Main Street."

    result = Redactor(use_presidio=False).redact(text)

    assert result.text.startswith("ORD-7280 has a tablet still on the way.")
    assert "123 Main Street" not in result.text
    assert result.report.entity_counts == {"ADDRESS": 1}


def test_regex_is_mandatory_even_when_presidio_returns_no_findings() -> None:
    analyzer = FakeAnalyzer([])

    result = Redactor(analyzer=analyzer).redact("Email private@example.com")

    assert result.text == "Email <EMAIL_ADDRESS>"
    assert result.report.entity_counts == {"EMAIL_ADDRESS": 1}


def test_report_merge_sums_counts_without_containing_original_pii() -> None:
    redactor = Redactor(use_presidio=False)
    first = redactor.redact("a@example.com").report
    second = redactor.redact("b@example.com and 415-555-1212").report

    merged = first.merge(second)

    assert merged.entity_counts == {"EMAIL_ADDRESS": 2, "PHONE_NUMBER": 1}
    assert merged.text_values_processed == 2
    assert "example.com" not in merged.model_dump_json()


def test_message_is_marked_redacted_even_when_no_entity_was_found() -> None:
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    message = Message(author="system", sent_at=now, text="No private data here")

    redacted, report = Redactor(use_presidio=False).redact_message(message)

    assert redacted.redacted is True
    assert redacted.text == message.text
    assert report.messages_processed == 1
    assert report.messages_changed == 0


def test_interaction_redaction_covers_every_persisted_free_text_value() -> None:
    opened = datetime(2026, 1, 1, tzinfo=timezone.utc)
    interaction = Interaction(
        id="TICKET-1",
        customer_key=hash_customer_key("jane@example.com", "corpus salt"),
        opened_at=opened,
        channel="email",
        messages=[
            Message(
                author="customer",
                sent_at=opened,
                text="My name is Jane Doe; email jane@example.com. Order ORD-77 was $84.00.",
            ),
            Message(
                author="agent",
                sent_at=opened + timedelta(minutes=1),
                text="I will call 415-555-1212.",
            ),
        ],
        state_snapshot=[
            StateFact(
                source="orders",
                kind="order",
                occurred_at=opened,
                fields={
                    "order_id": "ORD-77",
                    "amount": "$84.00",
                    "notes": {"email": "jane@example.com"},
                    "date_of_birth": "01/02/1980",
                    "passport": "A12345678",
                    "alice@example.com": "mapping key",
                    "unordered": {"beta", "alpha"},
                },
                provenance="exported",
            )
        ],
        resolution=Resolution(
            resolved_at=opened + timedelta(hours=1),
            original_label="Jane Doe refund",
            actions=["Emailed jane@example.com", "Kept order ORD-77"],
            closing_text="Jane Doe received $84.00.",
        ),
        source_system="fixture",
        metadata={"contact": ["jane@example.com", {"phone": "415-555-1212"}]},
    )

    redacted, report = Redactor(use_presidio=False).redact_interaction(interaction)

    serialized = redacted.model_dump_json()
    assert "jane@example.com" not in serialized.lower()
    assert "Jane Doe" not in serialized
    assert "415-555-1212" not in serialized
    assert "01/02/1980" not in serialized
    assert "A12345678" not in serialized
    assert '"unordered":["alpha","beta"]' in serialized
    assert "ORD-77" in serialized
    assert "$84.00" in serialized
    assert all(message.redacted for message in redacted.messages)
    assert report.messages_processed == 2
    assert report.messages_changed == 2
    assert report.entity_counts["EMAIL_ADDRESS"] >= 3
    assert report.entity_counts["PHONE_NUMBER"] >= 2


def test_structured_currency_survives_contextual_presidio_false_positive() -> None:
    opened = datetime(2026, 1, 1, tzinfo=timezone.utc)
    interaction = Interaction(
        id="TICKET-1",
        customer_key=hash_customer_key("customer", "corpus salt"),
        opened_at=opened,
        channel="email",
        messages=[Message(author="customer", sent_at=opened, text="money twice")],
        state_snapshot=[
            StateFact(
                source="billing",
                kind="charge",
                occurred_at=opened,
                fields={
                    "amount": "84.00",
                    "currency": "USD",
                    "order_id": "ORD-77",
                    "sku": "KETTLE_BLUE",
                },
                provenance="exported",
            )
        ],
        resolution=None,
        source_system="fixture",
    )

    redacted, report = Redactor(analyzer=CurrencyFalsePositiveAnalyzer()).redact_interaction(
        interaction
    )

    assert redacted.state_snapshot[0].fields == {
        "amount": "84.00",
        "currency": "USD",
        "order_id": "ORD-77",
        "sku": "KETTLE_BLUE",
    }
    assert "ADDRESS" not in report.entity_counts
    assert "structured-signal" in report.detectors


def test_structured_currency_is_a_closed_set_not_a_person_bypass() -> None:
    opened = datetime(2026, 1, 1, tzinfo=timezone.utc)
    interaction = Interaction(
        id="TICKET-1",
        customer_key=hash_customer_key("customer", "corpus salt"),
        opened_at=opened,
        channel="email",
        messages=[Message(author="customer", sent_at=opened, text="safe")],
        state_snapshot=[
            StateFact(
                source="billing",
                kind="charge",
                occurred_at=opened,
                fields={"currency": "Amy", "amount": "84.00"},
                provenance="exported",
            )
        ],
        resolution=None,
        source_system="fixture",
    )

    redacted, _report = Redactor(analyzer=StructuredSignalAnalyzer()).redact_interaction(
        interaction
    )

    assert redacted.state_snapshot[0].fields["currency"] == "<PERSON>"
    assert redacted.state_snapshot[0].fields["amount"] == "84.00"


def test_schema_provenanced_product_fields_survive_person_false_positives() -> None:
    redactor = Redactor()
    opened = datetime(2026, 1, 1, tzinfo=timezone.utc)
    interaction = Interaction(
        id="TICKET-1",
        customer_key=hash_customer_key("customer", "corpus salt"),
        opened_at=opened,
        channel="email",
        messages=[Message(author="customer", sent_at=opened, text="safe")],
        state_snapshot=[
            StateFact(
                source="orders",
                kind="fulfillment",
                occurred_at=opened,
                fields={
                    "ordered_product": "Turbo Kettle",
                    "ordered_sku": "KETTLE-100",
                    "received_product": "Travel Sleeve",
                    "received_sku": "SLEEVE-200",
                    "product_name": "alice@example.com",
                    "product_id": "PROD-300",
                },
                provenance="exported",
            )
        ],
        resolution=None,
        source_system="fixture",
    )

    redacted, report = redactor.redact_interaction(interaction)

    assert redacted.state_snapshot[0].fields == {
        "ordered_product": "product-ref:KETTLE-100",
        "ordered_sku": "KETTLE-100",
        "received_product": "product-ref:SLEEVE-200",
        "received_sku": "SLEEVE-200",
        "product_name": "product-ref:PROD-300",
        "product_id": "PROD-300",
    }
    assert "structured-product-reference" in report.detectors
    assert report.entity_counts["EMAIL_ADDRESS"] == 1


def test_production_catalog_preserves_only_exact_name_beside_validated_sku() -> None:
    redactor = Redactor(product_catalog={"KETTLE-100": "Turbo Kettle"})
    opened = datetime(2026, 1, 1, tzinfo=timezone.utc)
    interaction = Interaction(
        id="TICKET-1",
        customer_key=hash_customer_key("customer", "corpus salt"),
        opened_at=opened,
        channel="email",
        messages=[Message(author="customer", sent_at=opened, text="wrong thing")],
        state_snapshot=[
            StateFact(
                source="orders",
                kind="fulfillment",
                occurred_at=opened,
                fields={
                    "ordered_product": "turbo kettle",
                    "ordered_sku": "KETTLE-100",
                    "received_product": "Jane Doe",
                    "received_sku": "SLEEVE-200",
                },
                provenance="exported",
            )
        ],
        resolution=None,
        source_system="fixture",
    )

    redacted, report = redactor.redact_interaction(interaction)

    assert redactor.boundary_safe
    assert redacted.state_snapshot[0].fields == {
        "ordered_product": "Turbo Kettle",
        "ordered_sku": "KETTLE-100",
        "received_product": "product-ref:SLEEVE-200",
        "received_sku": "SLEEVE-200",
    }
    assert "structured-product-catalog" in report.detectors


def test_product_catalog_rejects_high_confidence_pii() -> None:
    with pytest.raises(ValueError, match="high-confidence PII"):
        Redactor(product_catalog={"KETTLE-100": "alice@example.com"})


def test_product_and_amount_keys_do_not_bypass_pii_outside_valid_signal() -> None:
    redactor = Redactor()
    opened = datetime(2026, 1, 1, tzinfo=timezone.utc)
    interaction = Interaction(
        id="TICKET-1",
        customer_key=hash_customer_key("customer", "corpus salt"),
        opened_at=opened,
        channel="email",
        messages=[Message(author="customer", sent_at=opened, text="safe")],
        state_snapshot=[
            StateFact(
                source="orders",
                kind="order",
                occurred_at=opened,
                fields={
                    "product_name": "Jane Doe",
                    "product_id": "Jane-Doe-1",
                    "amount": "Amy 123",
                },
                provenance="exported",
            )
        ],
        resolution=None,
        source_system="fixture",
        metadata={"product_name": "Turbo Kettle"},
    )

    redacted, _report = redactor.redact_interaction(interaction)

    assert redacted.state_snapshot[0].fields == {
        "product_name": "<PERSON>",
        "product_id": "<PERSON>",
        "amount": "<PERSON> 123",
    }
    assert redacted.metadata["product_name"] == "<PERSON>"


@pytest.mark.parametrize(
    "value",
    ("ORD-Jane-1", "SKU-Jane-1", "order Jane-Doe-1"),
)
def test_identifier_syntax_cannot_hide_a_person_name(value: str) -> None:
    redactor = Redactor()

    assert "Jane" not in redactor.redact(value).text
    assert "Doe" not in redactor.redact(value).text
    assert redactor.redact_external_identifier(value).text == "<PERSON>"


@pytest.mark.parametrize(
    "value",
    (
        "cust_005",
        "user_123",
        "acct_123",
        "account_789",
        "account-789",
        "CUST-005",
    ),
)
def test_customer_identifiers_are_removed_from_free_text(value: str) -> None:
    result = Redactor().redact(f"currently helping customer {value}")

    assert value not in result.text
    assert "<CUSTOMER_ID>" in result.text


def test_pseudonymous_hmac_identifier_is_not_reinterpreted_by_prose_ner() -> None:
    identifier = hash_customer_key("synthetic-interaction", "fixture-only-salt")

    result = Redactor().redact_external_identifier(identifier)

    assert result.text == identifier
    assert not result.changed


@pytest.mark.parametrize("identifier", ("demo-013", "demo-019", "ORD-12345", "ch_1"))
def test_strict_opaque_identifier_allowlist_overrides_contextual_ner_only(
    identifier: str,
) -> None:
    result = Redactor().redact_external_identifier(identifier)

    assert result.text == identifier
    assert not result.changed


def test_mandatory_boundary_fails_closed_on_per_record_analyzer_error(
    monkeypatch,
) -> None:
    import wordless.core.redact as redact_module

    analyzer = ExplodingAnalyzer()
    monkeypatch.setattr(redact_module, "_production_analyzer", lambda: analyzer)
    redactor = Redactor()
    assert redactor.boundary_safe

    with pytest.raises(RuntimeError, match="refusing unsafe fallback"):
        redactor.redact("Jordan")


def test_production_redactor_can_disable_result_cache_for_live_text(
    monkeypatch,
) -> None:
    import wordless.core.redact as redact_module

    analyzer = FakeAnalyzer([])
    monkeypatch.setattr(redact_module, "_production_analyzer", lambda: analyzer)
    redactor = Redactor(cache_results=False)

    assert redactor.boundary_safe
    redactor.redact("same customer request")
    redactor.redact("same customer request")

    assert analyzer.calls == 2
    assert redactor._result_cache == {}


def test_mutating_production_policy_invalidates_boundary_and_fails_closed() -> None:
    redactor = Redactor()
    assert redactor.boundary_safe

    redactor.preserve_terms = ("Jane Doe",)

    assert not redactor.boundary_safe
    with pytest.raises(RuntimeError, match="policy changed"):
        redactor.redact("My name is Jane Doe")


def test_structured_signal_key_never_preserves_high_confidence_pii() -> None:
    opened = datetime(2026, 1, 1, tzinfo=timezone.utc)
    interaction = Interaction(
        id="TICKET-1",
        customer_key=hash_customer_key("customer", "corpus salt"),
        opened_at=opened,
        channel="email",
        messages=[Message(author="customer", sent_at=opened, text="safe")],
        state_snapshot=[
            StateFact(
                source="orders",
                kind="order",
                occurred_at=opened,
                fields={"order_id": "jane@example.com"},
                provenance="exported",
            )
        ],
        resolution=None,
        source_system="fixture",
    )

    redacted, _report = Redactor(use_presidio=False).redact_interaction(interaction)

    assert redacted.state_snapshot[0].fields["order_id"] == "<EMAIL_ADDRESS>"

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import duckdb
import pytest
from pydantic import ValidationError

from wordless.core.models import Interaction, Message, StateFact, hash_customer_key
from wordless.core.redact import RedactionReport, Redactor
from wordless.ingest.generic import GenericAdapter
from wordless.state.store import CorpusStore, StoreError, UnredactedInteractionError


def canonical(*, redacted: bool = True, text: str = "Already safe") -> Interaction:
    return Interaction(
        id="ticket-1",
        customer_key=hash_customer_key("raw-customer", "secret-corpus-salt"),
        opened_at=datetime(2026, 1, 1, tzinfo=UTC),
        channel="email",
        messages=[
            Message(
                author="customer",
                sent_at=datetime(2026, 1, 1, tzinfo=UTC),
                text=text,
                redacted=redacted,
            )
        ],
        state_snapshot=[],
        resolution=None,
        source_system="fixture",
        metadata={},
    )


def test_store_round_trip_and_redaction_report(tmp_path: Path) -> None:
    store = CorpusStore.for_corpus(tmp_path, "public-corpus")
    report = RedactionReport(
        entity_counts={"EMAIL_ADDRESS": 3},
        messages_processed=10,
        messages_changed=3,
        text_values_processed=10,
        text_values_changed=3,
    )
    assert store.write([canonical()], redaction_report=report) == 1
    assert store.count() == 1
    assert list(store.iter_interactions()) == [canonical()]
    assert store.get("ticket-1") == canonical()
    assert store.redaction_counts() == {"EMAIL_ADDRESS": 3}
    assert store.redaction_summary() == {
        "messages_changed": 3,
        "messages_processed": 10,
        "text_values_changed": 3,
        "text_values_processed": 10,
    }
    loaded_report = store.read_redaction_report()
    assert loaded_report.entity_counts == {"EMAIL_ADDRESS": 3}
    assert loaded_report.messages_processed == 10

    with duckdb.connect(str(store.path), read_only=True) as connection:
        tables = {row[0] for row in connection.execute("SHOW TABLES").fetchall()}
    assert tables == {"corpus_metadata", "interactions", "redaction_report"}


def test_store_rejects_unredacted_message_transactionally(tmp_path: Path) -> None:
    store = CorpusStore(tmp_path / "corpus.duckdb")
    with pytest.raises(UnredactedInteractionError):
        store.write([canonical(redacted=False)])
    assert store.count() == 0


def test_store_revalidates_mutated_future_state_before_persistence(tmp_path: Path) -> None:
    store = CorpusStore(tmp_path / "corpus.duckdb")
    value = canonical()
    value.state_snapshot.append(
        StateFact(
            source="billing",
            kind="charge",
            occurred_at=value.opened_at + timedelta(seconds=1),
            fields={"amount": "84.00"},
            provenance="exported",
        )
    )

    with pytest.raises(ValidationError, match="temporal leakage"):
        store.write([value])
    assert store.count() == 0


def test_store_revalidates_mutated_customer_key_before_persistence(tmp_path: Path) -> None:
    store = CorpusStore(tmp_path / "corpus.duckdb")
    value = canonical()
    value.__dict__["customer_key"] = f"sha256:{'a' * 64}"

    with pytest.raises(ValidationError, match="hmac-sha256"):
        store.write([value])
    assert store.count() == 0


def test_store_defensively_redacts_flagged_but_raw_text(tmp_path: Path) -> None:
    store = CorpusStore(tmp_path / "corpus.duckdb")
    store.write([canonical(text="Email person@example.com")])
    stored = store.get("ticket-1")
    assert stored is not None
    assert stored.messages[0].text == "Email <EMAIL_ADDRESS>"
    assert store.redaction_counts() == {"EMAIL_ADDRESS": 1}


def test_store_rejects_redactor_subclasses_before_creating_database(
    tmp_path: Path,
) -> None:
    class NoopRedactor(Redactor):
        pass

    path = tmp_path / "corpus.duckdb"
    with pytest.raises(TypeError, match="concrete Redactor"):
        CorpusStore(path, redactor=NoopRedactor())
    assert not path.exists()


def test_store_rejects_concrete_redactor_with_disabled_presidio_policy(
    tmp_path: Path,
) -> None:
    path = tmp_path / "corpus.duckdb"
    with pytest.raises(ValueError, match="mandatory Presidio"):
        CorpusStore(path, redactor=Redactor(use_presidio=False))
    assert not path.exists()


def test_store_redacts_pii_in_mapping_keys_and_key_context_values(
    tmp_path: Path,
) -> None:
    store = CorpusStore(tmp_path / "corpus.duckdb")
    value = canonical()
    value.metadata.update(
        {
            "alice@example.com": "safe",
            "date_of_birth": "01/02/1980",
            "passport": "A12345678",
        }
    )

    store.write([value])
    stored = store.get("ticket-1")
    assert stored is not None
    serialized = stored.model_dump_json()
    assert "alice@example.com" not in serialized
    assert "01/02/1980" not in serialized
    assert "A12345678" not in serialized
    assert stored.metadata["date_of_birth"] == "<DATE_OF_BIRTH>"
    assert stored.metadata["passport"] == "<NATIONAL_ID>"
    assert all(item not in store.path.read_bytes() for item in (
        b"alice@example.com",
        b"01/02/1980",
        b"A12345678",
    ))


def test_store_scans_binary_and_numeric_any_values_before_persistence(
    tmp_path: Path,
) -> None:
    store = CorpusStore(tmp_path / "corpus.duckdb")
    value = canonical()
    value.metadata.update(
        {
            "binary_contact": b"jane@example.com",
            "numeric_card": 4111111111111111,
        }
    )

    store.write([value])
    stored = store.get("ticket-1")

    assert stored is not None
    serialized = stored.model_dump_json()
    assert "jane@example.com" not in serialized
    assert "4111111111111111" not in serialized
    assert stored.metadata["binary_contact"] == "<EMAIL_ADDRESS>"
    assert stored.metadata["numeric_card"] == "<CREDIT_CARD>"
    database_bytes = store.path.read_bytes()
    assert b"jane@example.com" not in database_bytes
    assert b"4111111111111111" not in database_bytes


def test_store_rejects_pii_structural_identifier_without_ingest_salt(
    tmp_path: Path,
) -> None:
    store = CorpusStore(tmp_path / "corpus.duckdb")
    value = canonical()
    value.id = "jane@example.com"

    with pytest.raises(ValueError, match="pseudonymize it at ingest"):
        store.write([value])
    assert store.count() == 0


def test_store_rejects_person_like_structural_identifier(tmp_path: Path) -> None:
    store = CorpusStore(tmp_path / "corpus.duckdb")
    value = canonical()
    value.id = "Jordan"

    with pytest.raises(ValueError, match="pseudonymize it at ingest"):
        store.write([value])
    assert store.count() == 0


def test_store_fails_closed_if_redactor_policy_is_mutated_after_wiring(
    tmp_path: Path,
) -> None:
    redactor = Redactor()
    store = CorpusStore(tmp_path / "corpus.duckdb", redactor=redactor)
    redactor.preserve_terms = ("Jane Doe",)

    value = canonical()
    value.messages[0].text = "My name is Jane Doe"
    with pytest.raises(ValueError, match="mandatory Presidio"):
        store.write([value])
    assert store.count() == 0


def test_store_never_persists_corpus_salt(tmp_path: Path) -> None:
    store = CorpusStore(tmp_path / "corpus.duckdb")
    store.write([canonical()])
    assert b"secret-corpus-salt" not in store.path.read_bytes()


def test_ingest_rejects_caller_controlled_prose_allowlist(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="preserve_terms"):
        GenericAdapter(
            {"format": "jsonl"},
            corpus_salt="salt",
            preserve_terms=("Jane Doe",),
        )


def test_generic_schema_cannot_smuggle_names_through_product_or_id_fields(
    tmp_path: Path,
) -> None:
    export = tmp_path / "tickets.jsonl"
    export.write_text(
        '{"id":"1","customer_id":"c1","created_at":"2026-01-01T00:00:00Z",'
        '"author":"customer","text":"safe request","facts":[{'
        '"at":"2026-01-01T00:00:00Z","customer_name":"Jane Doe",'
        '"customer_ref":"Jane-Doe-1"}]}\n',
        encoding="utf-8",
    )
    mapping = {
        "format": "jsonl",
        "state": {
            "path": "facts",
            "fields": {
                "source": {"value": "orders"},
                "kind": {"value": "order"},
                "occurred_at": "at",
                "fields": {
                    "product_name": "customer_name",
                    "product_id": "customer_ref",
                    "order_id": "customer_ref",
                    "sku": "customer_ref",
                },
            },
        },
    }
    adapter = GenericAdapter(mapping, corpus_salt="salt")
    store = CorpusStore(tmp_path / "corpus.duckdb")

    assert store.ingest(adapter, export) == 1
    stored = store.get("1")
    assert stored is not None
    serialized = stored.model_dump_json()
    assert "Jane Doe" not in serialized
    assert "Jane-Doe-1" not in serialized
    database_bytes = store.path.read_bytes()
    assert b"Jane Doe" not in database_bytes
    assert b"Jane-Doe-1" not in database_bytes


def test_corpus_id_cannot_escape_workspace(tmp_path: Path) -> None:
    with pytest.raises(StoreError, match="corpus_id"):
        CorpusStore.for_corpus(tmp_path, "../outside")

from __future__ import annotations

from pathlib import Path

import pytest

from wordless.ingest.base import AdapterError
from wordless.ingest.generic import GenericAdapter, MappingError
from wordless.core.redact import Redactor


FIXTURES = Path(__file__).parents[1] / "fixtures" / "ingest"


def test_generic_csv_mapping_redacts_and_filters_future_state() -> None:
    adapter = GenericAdapter(
        FIXTURES / "generic_mapping.yaml",
        corpus_salt="per-corpus-test-salt",
    )

    stream = adapter.load(FIXTURES / "generic.csv")
    assert iter(stream) is stream
    interaction = next(stream)
    with pytest.raises(StopIteration):
        next(stream)

    assert interaction.id == "T-100"
    assert interaction.source_system == "mapped_helpdesk"
    assert interaction.customer_key.startswith("hmac-sha256:")
    assert "ava@example.com" not in interaction.model_dump_json()
    assert "Ava Stone" not in interaction.model_dump_json()
    assert interaction.messages[0].redacted is True
    assert "<PERSON>" in interaction.messages[0].text
    assert "ORD-77" in interaction.messages[0].text
    assert "$84.00" in interaction.messages[0].text

    # A charge exported after opened_at is deliberately excluded.
    assert len(interaction.state_snapshot) == 1
    assert interaction.state_snapshot[0].provenance == "exported"
    assert interaction.state_snapshot[0].fields["amount"] == "$84.00"
    assert interaction.state_snapshot[0].fields["order_id"] == "ORD-77"

    report = adapter.redaction_report
    assert report.entity_counts["EMAIL_ADDRESS"] >= 2
    assert report.entity_counts["PERSON"] >= 1
    assert report.messages_processed == 1


def test_customer_hash_is_deterministic_within_corpus_and_scoped_between_corpora() -> None:
    path = FIXTURES / "generic.csv"
    mapping = FIXTURES / "generic_mapping.yaml"
    first = next(GenericAdapter(mapping, corpus_salt="alpha").load(path))
    again = next(GenericAdapter(mapping, corpus_salt="alpha").load(path))
    other = next(GenericAdapter(mapping, corpus_salt="beta").load(path))
    assert first.customer_key == again.customer_key
    assert first.customer_key != other.customer_key


def test_load_requires_explicit_nonempty_corpus_salt() -> None:
    adapter = GenericAdapter(FIXTURES / "generic_mapping.yaml")
    with pytest.raises(AdapterError, match="per-corpus salt"):
        next(adapter.load(FIXTURES / "generic.csv"))


def test_generic_jsonl_defaults_stream_records(tmp_path: Path) -> None:
    export = tmp_path / "tickets.jsonl"
    export.write_text(
        "\n".join(
            [
                '{"id":"1","customer_id":"c1","created_at":"2026-01-01T00:00:00Z",'
                '"author":"customer","text":"one"}',
                '{"id":"2","customer_id":"c2","created_at":"2026-01-02T00:00:00Z",'
                '"author":"customer","text":"two"}',
            ]
        ),
        encoding="utf-8",
    )
    adapter = GenericAdapter({"format": "jsonl"}, corpus_salt="salt")
    assert [item.id for item in adapter.load(export)] == ["1", "2"]
    assert adapter.summary.interactions == 2


def test_generic_pseudonymizes_pii_interaction_id_before_yield(tmp_path: Path) -> None:
    export = tmp_path / "tickets.jsonl"
    export.write_text(
        '{"id":"jane@example.com","customer_id":"c1",'
        '"created_at":"2026-01-01T00:00:00Z",'
        '"author":"customer","text":"safe request"}\n',
        encoding="utf-8",
    )
    adapter = GenericAdapter({"format": "jsonl"}, corpus_salt="salt")

    interaction = next(adapter.load(export))

    assert interaction.id.startswith("redacted-hmac-sha256:")
    assert "jane@example.com" not in interaction.model_dump_json()
    assert adapter.redaction_report.entity_counts["EMAIL_ADDRESS"] >= 1


def test_generic_pseudonymizes_person_like_interaction_id_before_yield(
    tmp_path: Path,
) -> None:
    export = tmp_path / "tickets.jsonl"
    export.write_text(
        '{"id":"Jordan","customer_id":"c1",'
        '"created_at":"2026-01-01T00:00:00Z",'
        '"author":"customer","text":"safe request"}\n',
        encoding="utf-8",
    )

    interaction = next(
        GenericAdapter({"format": "jsonl"}, corpus_salt="salt").load(export)
    )

    assert interaction.id.startswith("redacted-hmac-sha256:")
    assert "Jordan" not in interaction.model_dump_json()


def test_generic_excludes_state_without_an_explicit_source_timestamp(
    tmp_path: Path,
) -> None:
    export = tmp_path / "tickets.jsonl"
    export.write_text(
        '{"id":"1","customer_id":"c1","created_at":"2026-01-01T00:00:00Z",'
        '"author":"customer","text":"money one twice",'
        '"charges":[{"amount":"84.00","status":"succeeded"},'
        '{"amount":"84.00","status":"succeeded"}]}\n',
        encoding="utf-8",
    )
    mapping = {
        "format": "jsonl",
        "state": {
            "path": "charges",
            "fields": {
                "source": {"value": "billing"},
                "kind": {"value": "charge"},
                "fields": {"amount": "amount", "status": "status"},
            },
        },
    }

    interaction = next(GenericAdapter(mapping, corpus_salt="salt").load(export))

    assert interaction.state_snapshot == []


def test_mapping_rejects_unknown_format() -> None:
    with pytest.raises(MappingError, match="Unsupported format"):
        GenericAdapter({"format": "xlsx"}, corpus_salt="salt")


def test_adapter_rejects_redactor_with_disabled_presidio_policy() -> None:
    with pytest.raises(ValueError, match="mandatory Presidio"):
        GenericAdapter(
            {"format": "jsonl"},
            corpus_salt="salt",
            redactor=Redactor(use_presidio=False),
        )


@pytest.mark.parametrize(
    "kwargs",
    (
        {"mapping_path": {"format": "jsonl", "preserve_terms": ["Jane Doe"]}},
        {"mapping_path": {"format": "jsonl"}, "preserve_terms": ("Jane Doe",)},
    ),
)
def test_generic_rejects_caller_controlled_prose_allowlists(kwargs: dict) -> None:
    with pytest.raises(MappingError, match="preserve_terms is not allowed"):
        GenericAdapter(corpus_salt="salt", **kwargs)

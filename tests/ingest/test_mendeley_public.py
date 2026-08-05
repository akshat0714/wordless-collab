from __future__ import annotations

from pathlib import Path

import pytest

from wordless.ingest import ADAPTER_TYPES, MendeleyPublicAdapter
from wordless.ingest.base import AdapterError


FIXTURE = Path(__file__).parents[1] / "fixtures" / "ingest" / "mendeley_public"
PINNED = Path(".wordless/public/mendeley-helpdesk-v2")


def adapter() -> MendeleyPublicAdapter:
    return MendeleyPublicAdapter(corpus_salt="public-fixture-test-salt")


def test_detect_requires_the_two_pinned_filenames(tmp_path: Path) -> None:
    value = adapter()
    assert value.detect(FIXTURE)
    assert value.detect(FIXTURE / "issues.csv")
    (tmp_path / "issues.csv").write_text("id\n", encoding="utf-8")
    assert not value.detect(tmp_path)


def test_groups_utterances_orders_comments_and_redacts_before_yield() -> None:
    value = adapter()
    interactions = list(value.load(FIXTURE))

    assert [item.id for item in interactions] == ["42.0", "43.0"]
    first = interactions[0]
    assert first.source_system == "mendeley_helpdesk_v2"
    assert first.opened_at.isoformat() == "2026-01-02T10:00:00+00:00"
    assert first.channel == "web"
    assert first.state_snapshot == []
    assert first.customer_key.startswith("hmac-sha256:")
    assert "masked-reporter" not in first.model_dump_json()

    assert [message.author for message in first.messages] == ["customer", "system", "agent"]
    assert all(message.redacted for message in first.messages)
    assert first.messages[0].text == "My name is <PERSON>. please help"
    assert first.messages[0].sent_at.isoformat() == "2026-01-02T10:00:00+00:00"
    assert first.messages[-1].text == "We resolved this. Contact <EMAIL_ADDRESS>"

    assert first.resolution is not None
    assert first.resolution.original_label == "done"
    assert first.resolution.actions == ["closed"]
    assert first.resolution.closing_text == first.messages[-1].text
    assert first.metadata["issue_resolution"] == "done"
    assert value.redaction_report.entity_counts["EMAIL_ADDRESS"] == 2


def test_final_agent_text_is_empty_when_sample_has_no_assignee() -> None:
    second = list(adapter().load(FIXTURE))[1]
    assert second.resolution is not None
    assert second.resolution.closing_text == ""
    assert second.resolution.original_label == "cannot_reproduce"


def test_public_fixture_is_not_in_sellable_adapter_registry() -> None:
    assert MendeleyPublicAdapter not in ADAPTER_TYPES


def test_load_reports_missing_join_file(tmp_path: Path) -> None:
    with pytest.raises(AdapterError, match="requires issues.csv"):
        next(adapter().load(tmp_path))


@pytest.mark.skipif(
    not (PINNED / "issues.csv").is_file()
    or not (PINNED / "sample_utterances.csv").is_file(),
    reason="pinned public corpus has not been downloaded",
)
def test_pinned_public_fixture_streams_360_grouped_interactions() -> None:
    value = adapter()
    stream = value.load(PINNED)
    assert iter(stream) is stream
    interactions = list(stream)
    assert len(interactions) == 360
    assert sum(len(item.messages) for item in interactions) == 7_286
    assert all(item.source_system == "mendeley_helpdesk_v2" for item in interactions)
    assert all(not item.state_snapshot for item in interactions)
    assert all(all(message.redacted for message in item.messages) for item in interactions)
    assert all(
        item.messages == sorted(item.messages, key=lambda message: message.sent_at)
        for item in interactions
    )

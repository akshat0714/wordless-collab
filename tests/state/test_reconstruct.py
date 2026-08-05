from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from wordless.core.models import Interaction, Message, StateFact, hash_customer_key
from wordless.state.reconstruct import (
    StateReconstructor,
    provenance_distribution,
    reconstruct_state,
)


OPENED = datetime(2026, 7, 25, 10, tzinfo=UTC)


def interaction(
    *messages: tuple[str, str],
    facts: list[StateFact] | None = None,
    interaction_id: str = "T-1",
) -> Interaction:
    return Interaction(
        id=interaction_id,
        customer_key=hash_customer_key("customer", "salt"),
        opened_at=OPENED,
        channel="chat",
        messages=[
            Message(
                author=author,
                sent_at=OPENED + timedelta(minutes=index),
                text=text,
                redacted=True,
            )
            for index, (author, text) in enumerate(messages)
        ],
        state_snapshot=facts or [],
        resolution=None,
        source_system="fixture",
    )


def test_rung_one_preserves_exported_state() -> None:
    fact = StateFact(
        source="orders",
        kind="order",
        occurred_at=OPENED - timedelta(hours=1),
        fields={"status": "delayed"},
        provenance="exported",
    )
    result = StateReconstructor().reconstruct(interaction(("customer", "late"), facts=[fact]))
    assert result.rung == "exported"
    assert result.facts_added == 0
    assert result.degraded is False
    assert result.interaction.state_snapshot == [fact]


def test_rung_two_extracts_explicit_agent_observation_only() -> None:
    result = StateReconstructor().reconstruct(
        interaction(
            ("customer", "money one twice"),
            ("agent", "I can see two charges of $84.00 on the 3rd."),
        )
    )
    assert result.rung == "reconstructed"
    fact = result.interaction.state_snapshot[0]
    assert fact.provenance == "reconstructed"
    assert fact.occurred_at == OPENED
    assert fact.fields == {
        "amount": "84.00",
        "currency": "USD",
        "count": 2,
        "extractor": "deterministic_agent_v1",
        "stated_day": "3rd",
    }


def test_customer_claim_never_produces_reconstructed_fact() -> None:
    result = StateReconstructor().reconstruct(
        interaction(("customer", "I can see two charges of $84.00."))
    )
    assert result.rung == "inferred"
    assert result.degraded is True
    assert result.interaction.state_snapshot[0].fields["basis"] == "customer_text_only"


def test_llm_rung_two_uses_only_redacted_agent_turns(tmp_path) -> None:
    from wordless.core.llm import LLMClient

    class CapturingProvider:
        def __init__(self):
            self.prompts = []

        def complete(self, request, *, model_id, timeout_seconds):
            self.prompts.append(request.prompt)
            return (
                '[{"source":"fulfillment","kind":"shipment",'
                '"fields":{"status":"dispatched"}}]'
            )

    provider = CapturingProvider()
    client = LLMClient(
        provider=provider,
        provider_id="fixture",
        model_id="fixture/model",
        cache_dir=tmp_path,
        timeout_seconds=1,
        max_retries=0,
    )
    result = StateReconstructor(llm=client).reconstruct(
        interaction(
            ("customer", "TOP-SECRET-CUSTOMER-TURN"),
            ("agent", "Warehouse dispatch confirmed for alice@example.com."),
        )
    )

    assert len(provider.prompts) == 1
    assert "TOP-SECRET-CUSTOMER-TURN" not in provider.prompts[0]
    assert "alice@example.com" not in provider.prompts[0]
    assert "<EMAIL_ADDRESS>" in provider.prompts[0]
    assert result.rung == "reconstructed"
    assert result.interaction.state_snapshot[0].fields == {
        "status": "dispatched",
        "extractor": "llm_agent_v1",
    }
    assert result.method == "bounded LLM extraction from redacted agent turns only"


def test_malformed_llm_fact_uses_deterministic_regex_fallback(tmp_path) -> None:
    from wordless.core.llm import LLMClient

    class ExtraKeyProvider:
        def complete(self, request, *, model_id, timeout_seconds):
            return (
                '[{"source":"billing","kind":"charge",'
                '"fields":{"amount":"999"},"unsupported":true}]'
            )

    client = LLMClient(
        provider=ExtraKeyProvider(),
        provider_id="fixture",
        model_id="fixture/model",
        cache_dir=tmp_path,
        timeout_seconds=1,
        max_retries=0,
    )
    result = StateReconstructor(llm=client).reconstruct(
        interaction(
            ("customer", "billing question"),
            ("agent", "I can see two charges of $84.00 on the 3rd."),
        )
    )

    assert result.rung == "reconstructed"
    assert result.interaction.state_snapshot[0].fields["amount"] == "84.00"
    assert (
        result.interaction.state_snapshot[0].fields["extractor"]
        == "deterministic_agent_v1"
    )


def test_state_llm_boundary_rejects_raw_clients() -> None:
    class RawLLM:
        def generate(self, _request):
            return None

    with pytest.raises(TypeError, match="LLMClient"):
        StateReconstructor(llm=RawLLM())  # type: ignore[arg-type]


def test_rung_three_is_explicitly_degraded_even_with_empty_text() -> None:
    rebuilt = reconstruct_state(interaction(("customer", "")), include_agent_extraction=False)
    fact = rebuilt.state_snapshot[0]
    assert fact.provenance == "inferred"
    assert fact.occurred_at == OPENED
    assert rebuilt.metadata["state_reconstruction"]["degraded"] is True


def test_reconstruction_rejects_unredacted_input() -> None:
    value = interaction(("customer", "hello"))
    value.messages[0].redacted = False
    with pytest.raises(ValueError, match="redacted"):
        StateReconstructor().reconstruct(value)


def test_distribution_includes_denominator_and_zero_count_rungs() -> None:
    exported_fact = StateFact(
        source="account",
        kind="account",
        occurred_at=OPENED,
        fields={},
        provenance="exported",
    )
    values = [
        StateReconstructor().reconstruct(
            interaction(("customer", "one"), facts=[exported_fact], interaction_id="1")
        ),
        StateReconstructor().reconstruct(
            interaction(("customer", "two"), interaction_id="2")
        ),
    ]
    distribution = provenance_distribution(values)
    assert distribution.total_interactions == 2
    assert distribution.counts == {"exported": 1, "reconstructed": 0, "inferred": 1}
    assert distribution.rates["exported"] == 0.5
    assert distribution.degraded_interactions == 1

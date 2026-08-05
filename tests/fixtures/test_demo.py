from __future__ import annotations

from collections import Counter

from wordless.fixtures.demo import DEMO_CORPUS_NAME, demo_interactions
from wordless.pipeline.candidates import generate_hypotheses
from wordless.replay.engine import fragment_length_bucket


def test_demo_fixture_is_redacted_synthetic_balanced_and_canonical() -> None:
    interactions = demo_interactions()

    assert len(interactions) == 30
    assert len({interaction.id for interaction in interactions}) == 30
    assert Counter(
        fragment_length_bucket(interaction.messages[0].text)
        for interaction in interactions
    ) == {"<=5": 10, "6-15": 10, "16+": 10}
    assert all(interaction.metadata["synthetic"] is True for interaction in interactions)
    assert all(
        interaction.metadata["data_classification"] == "synthetic_fixture"
        and interaction.metadata["fixture_name"] == DEMO_CORPUS_NAME
        for interaction in interactions
    )
    assert all(message.redacted for interaction in interactions for message in interaction.messages)
    assert all(
        fact.provenance == "exported"
        for interaction in interactions
        for fact in interaction.state_snapshot
    )


def test_every_detector_has_matching_and_contradictory_examples() -> None:
    interactions = demo_interactions()
    pairs = Counter(
        (
            interaction.metadata["expected_detector"],
            interaction.metadata["expected_resolution_relation"],
        )
        for interaction in interactions
        if interaction.metadata["expected_detector"] is not None
    )

    for detector_id in (
        "duplicate_charge",
        "late_delivery",
        "wrong_item",
        "account_lock",
    ):
        assert pairs[(detector_id, "matching")] == 3
        assert pairs[(detector_id, "contradictory")] == 3


def test_every_clean_account_produces_zero_hypotheses() -> None:
    clean = [
        interaction
        for interaction in demo_interactions()
        if interaction.metadata["expected_resolution_relation"] == "clean_account"
    ]

    assert len(clean) == 6
    assert all(generate_hypotheses(interaction) == () for interaction in clean)

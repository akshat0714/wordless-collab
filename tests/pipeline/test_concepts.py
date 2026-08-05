from __future__ import annotations

import pytest

from wordless.pipeline.candidates import DEFAULT_DETECTORS
from wordless.pipeline.concepts import (
    CONTEXT_METADATA_KEY,
    contextual_query,
    has_low_composition_cue,
    is_low_legibility_fragment,
    repair_fragment_for_concept,
    should_use_contextual_evidence_choices,
)


DETECTORS = {detector.id: detector for detector in DEFAULT_DETECTORS}


@pytest.mark.parametrize(
    "detector_id,fragment,expected",
    (
        ("duplicate_charge", "mney twcie", "money twice"),
        ("late_delivery", "pakg no com", "pakg not come"),
        ("wrong_item", "thing box difrent", "thing box different"),
        ("account_lock", "cant in acount", "cant in account"),
    ),
)
def test_detector_local_repairs_cover_severe_support_typos(
    detector_id: str,
    fragment: str,
    expected: str,
) -> None:
    repair = repair_fragment_for_concept(fragment, DETECTORS[detector_id])

    assert repair.text == expected
    assert repair.changed_tokens >= 1
    assert has_low_composition_cue(fragment, DETECTORS[detector_id]) is False
    assert should_use_contextual_evidence_choices(
        fragment,
        DETECTORS[detector_id],
        concept_similarity=0.40,
    ) is False


@pytest.mark.parametrize(
    "message",
    (
        "hello there",
        "I need a receipt",
        "store hours",
        "mailing address",
        "Can I order two blue shirts?",
        "Where can I change my newsletter preferences?",
    ),
)
def test_clear_or_unrelated_text_has_no_automatic_contextual_cue(
    message: str,
) -> None:
    assert all(
        not has_low_composition_cue(message, detector)
        for detector in DEFAULT_DETECTORS
    )


@pytest.mark.parametrize("message", ("asdf qqq", "blrk trpn", "%%%"))
def test_high_noise_text_uses_the_non_diagnostic_low_legibility_gate(
    message: str,
) -> None:
    assert is_low_legibility_fragment(message) is True
    assert has_low_composition_cue(
        message,
        DETECTORS["account_lock"],
    ) is True


def test_vague_anaphora_can_request_context_without_exact_words() -> None:
    detector = DETECTORS["duplicate_charge"]

    assert is_low_legibility_fragment("need it agin") is False
    assert has_low_composition_cue("need it agin", detector) is True
    assert should_use_contextual_evidence_choices(
        "need it agin",
        detector,
        concept_similarity=0.0,
    ) is True


def test_vague_help_cue_is_non_diagnostic_and_requires_a_hypothesis_later() -> None:
    detector = DETECTORS["late_delivery"]

    assert has_low_composition_cue("help", detector) is True
    assert should_use_contextual_evidence_choices(
        "help",
        detector,
        concept_similarity=0.0,
    ) is True


def test_context_query_is_bounded_and_uses_recent_customer_turns() -> None:
    metadata = {
        CONTEXT_METADATA_KEY: [
            "oldest",
            "my package never arrived",
            "the tracking stopped",
            "please help",
            42,
        ]
    }

    assert contextual_query("it", metadata) == (
        "my package never arrived Context: the tracking stopped "
        "Context: please help Context: it"
    )
    assert contextual_query("it", {CONTEXT_METADATA_KEY: "not-a-list"}) == "it"

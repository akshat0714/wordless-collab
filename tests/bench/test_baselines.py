from __future__ import annotations

import pytest

from bench.baselines import BM25Ranker, DEFAULT_MODEL_SPECS, TokenOverlapRanker
from bench.pairs import Target


def _ordinary_pool() -> tuple[Target, ...]:
    return (
        Target("late_fee", "A fee was charged because a payment arrived late."),
        Target("duplicate_charge", "The same payment appears twice."),
        Target("invoice_request", "The customer needs an itemized invoice."),
        Target("address_change", "The delivery address needs to change."),
    )


@pytest.mark.parametrize("ranker_type", [TokenOverlapRanker, BM25Ranker])
def test_lexical_rankers_put_the_unique_exact_match_first(ranker_type: type) -> None:
    ranker = ranker_type()
    rankings = ranker.rank("same payment appears twice", _ordinary_pool())

    assert rankings[0].rank == 1
    assert rankings[0].target == "duplicate_charge"
    assert rankings[0].score > rankings[1].score
    assert tuple(result.rank for result in rankings) == (1, 2, 3, 4)


@pytest.mark.parametrize("ranker_type", [TokenOverlapRanker, BM25Ranker])
def test_lexical_ties_use_target_id_not_input_order(ranker_type: type) -> None:
    candidates = _ordinary_pool()
    ranker = ranker_type()

    forward = ranker.rank("tokens absent from every description", candidates)
    backward = ranker.rank(
        "tokens absent from every description", tuple(reversed(candidates))
    )

    expected = tuple(sorted(target.target for target in candidates))
    assert tuple(result.target for result in forward) == expected
    assert tuple(result.target for result in backward) == expected
    assert forward == backward


@pytest.mark.parametrize("ranker_type", [TokenOverlapRanker, BM25Ranker])
def test_ranker_indexes_repeated_labels_per_domain_without_collision(
    ranker_type: type,
) -> None:
    left = (
        Target("shared_label", "alpha beacon"),
        Target("left_other", "delta marker"),
        Target("left_filler", "epsilon token"),
    )
    right = (
        Target("shared_label", "gamma marker"),
        Target("right_match", "alpha beacon"),
        Target("right_filler", "epsilon token"),
    )
    pools = {"left": left, "right": right}
    ranker = ranker_type()
    ranker.prepare(pools)

    assert ranker.rank("alpha beacon", left)[0].target == "shared_label"
    assert ranker.rank("alpha beacon", right)[0].target == "right_match"


def test_default_embedding_models_are_pinned_to_immutable_revisions() -> None:
    assert len(DEFAULT_MODEL_SPECS) == 3
    assert all(
        spec.revision is not None
        and len(spec.revision) == 40
        and set(spec.revision) <= set("0123456789abcdef")
        for spec in DEFAULT_MODEL_SPECS
    )

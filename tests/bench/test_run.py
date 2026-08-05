from dataclasses import dataclass
from pathlib import Path

from bench.baselines import Ranking, Target
from bench.pairs import BenchmarkDataset, BenchmarkPair, TargetCatalog
from bench.run import compute_metrics, decide_gate, evaluate_ranker


def test_compute_metrics_uses_declared_denominator_and_formal_top3_name() -> None:
    pairs = [
        BenchmarkPair(id=f"c{i}", fragment="x", target="a", category="telegraphic", domain="d")
        for i in range(1, 5)
    ]
    result = compute_metrics(zip(pairs, (1, 2, 3, 4)))
    assert result["n"] == result["denominator"] == 4
    assert result["top_1_accuracy"] == 0.25
    assert result["top_3_accuracy"] == result["precision_at_3_spec_alias"] == 0.75
    assert result["mean_reciprocal_rank"] == 0.520833


def test_gate_thresholds_are_absolute() -> None:
    methods = [
        {"method_id": "bm25", "kind": "lexical", "status": "completed", "overall": {"top_3_accuracy": 0.49}},
        {"method_id": "embedding_small", "kind": "semantic", "status": "completed", "overall": {"top_3_accuracy": 0.75}},
    ]
    gate = decide_gate(methods)
    assert gate["decision"] == "PASS"
    assert gate["absolute_delta"] == 0.26


@dataclass
class _PerfectRanker:
    method_id: str = "perfect"
    kind: str = "test"

    def prepare(self, pools, *, text_mode):
        return None

    def rank(self, query, candidates, *, text_mode):
        ordered = sorted(candidates, key=lambda item: item.target != query)
        return tuple(Ranking(rank=i, target=item.target, score=float(-i)) for i, item in enumerate(ordered, 1))

    def metadata(self):
        return {"fixture": True}


def test_evaluator_keeps_same_label_in_two_domains_separate() -> None:
    catalog = TargetCatalog(
        version=1,
        authorship="fixture",
        domains={
            "a": (Target("shared", "one"), Target("other", "two")),
            "b": (Target("shared", "three"), Target("other", "four")),
        },
    )
    pairs = (
        BenchmarkPair("a1", "shared", "shared", "telegraphic", "a"),
        BenchmarkPair("b1", "shared", "shared", "telegraphic", "b"),
    )
    dataset = BenchmarkDataset(pairs, catalog, Path("pairs"), Path("targets"), "fixture")
    result, timing = evaluate_ranker(dataset, _PerfectRanker())
    assert result["overall"]["hits_at_1"] == 2
    assert result["target_macro"]["n_domain_targets"] == 2
    assert timing["n_queries"] == 2
    assert [row["pair_id"] for row in timing["per_query"]] == ["a1", "b1"]
    assert all(row["seconds"] >= 0 for row in timing["per_query"])

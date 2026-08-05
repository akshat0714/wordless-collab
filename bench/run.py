"""Run the Wordless Module 0 gate.

The specification calls its product metric ``precision@3``. With one relevant
candidate per query, that quantity is formally top-3 accuracy (hit rate@3), so
the result retains a clearly named compatibility alias and reports the formal
name first.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import json
from pathlib import Path
from statistics import fmean
from time import perf_counter
from typing import Any, Iterable, Mapping, Protocol, Sequence

from .baselines import (
    BM25Ranker,
    EmbeddingRanker,
    RankerUnavailable,
    TokenOverlapRanker,
    configured_model_specs,
)
from .pairs import BenchmarkDataset, BenchmarkPair, CATEGORIES, load_benchmark


SEED = 17
GATE_MIN_TOP_3 = 0.75
GATE_MIN_DELTA = 0.25


class Ranker(Protocol):
    method_id: str
    kind: str

    def prepare(self, pools: Mapping[str, Sequence[Any]], *, text_mode: str) -> None: ...

    def rank(self, query: str, candidates: Sequence[Any], *, text_mode: str) -> Sequence[Any]: ...

    def metadata(self) -> dict[str, Any]: ...


def _rounded(value: float) -> float:
    return round(value, 6)


def compute_metrics(
    rows: Iterable[tuple[BenchmarkPair, int]],
) -> dict[str, Any]:
    """Compute retrieval metrics from ``(pair, one-based gold rank)`` rows."""

    materialized = tuple(rows)
    if not materialized:
        raise ValueError("at least one scored row is required")
    ranks = [rank for _, rank in materialized]
    if any(rank < 1 for rank in ranks):
        raise ValueError("ranks must be one-based positive integers")
    n = len(ranks)
    hits_1 = sum(rank <= 1 for rank in ranks)
    hits_3 = sum(rank <= 3 for rank in ranks)
    return {
        "n": n,
        "denominator": n,
        "top_1_accuracy": _rounded(hits_1 / n),
        "precision_at_1": _rounded(hits_1 / n),
        "top_3_accuracy": _rounded(hits_3 / n),
        "hit_rate_at_3": _rounded(hits_3 / n),
        "precision_at_3_spec_alias": _rounded(hits_3 / n),
        "mean_reciprocal_rank": _rounded(fmean(1 / rank for rank in ranks)),
        "hits_at_1": hits_1,
        "hits_at_3": hits_3,
        "method": "single-gold closed-set rank; hit when the gold target is within k",
    }


def _target_macro(rows: Sequence[tuple[BenchmarkPair, int]]) -> dict[str, Any]:
    grouped: dict[tuple[str, str], list[int]] = defaultdict(list)
    for pair, rank in rows:
        grouped[(pair.domain, pair.target)].append(rank)
    values = [sum(rank <= 3 for rank in ranks) / len(ranks) for ranks in grouped.values()]
    return {
        "n_domain_targets": len(values),
        "top_3_accuracy": _rounded(fmean(values)),
        "method": "unweighted mean of top-3 accuracy for each (domain, target)",
    }


def evaluate_ranker(
    dataset: BenchmarkDataset,
    ranker: Ranker,
    *,
    text_mode: str = "description",
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Evaluate one method and return canonical metrics plus timing telemetry."""

    ranker.prepare(dataset.candidate_pools, text_mode=text_mode)
    scored: list[tuple[BenchmarkPair, int]] = []
    query_seconds: list[float] = []
    per_query: list[dict[str, Any]] = []
    for pair in dataset.pairs:
        candidates = dataset.catalog.for_domain(pair.domain)
        started = perf_counter()
        ranking = tuple(ranker.rank(pair.fragment, candidates, text_mode=text_mode))
        elapsed = perf_counter() - started
        query_seconds.append(elapsed)
        per_query.append(
            {"pair_id": pair.id, "domain": pair.domain, "seconds": elapsed}
        )
        if len(ranking) != len(candidates):
            raise RuntimeError(f"{ranker.method_id} returned an incomplete ranking")
        matches = [row.rank for row in ranking if row.target == pair.target]
        if len(matches) != 1:
            raise RuntimeError(
                f"{ranker.method_id} did not rank gold target {(pair.domain, pair.target)!r} exactly once"
            )
        scored.append((pair, matches[0]))

    categories: dict[str, Any] = {}
    for category in dataset.categories:
        subset = [(pair, rank) for pair, rank in scored if pair.category == category]
        categories[category] = compute_metrics(subset)
    domains: dict[str, Any] = {}
    for domain in dataset.domains:
        subset = [(pair, rank) for pair, rank in scored if pair.domain == domain]
        domains[domain] = compute_metrics(subset)

    canonical = {
        "method_id": ranker.method_id,
        "kind": ranker.kind,
        "status": "completed",
        "candidate_text_mode": text_mode,
        "metadata": ranker.metadata(),
        "overall": compute_metrics(scored),
        "target_macro": _target_macro(scored),
        "per_category": categories,
        "per_domain": domains,
    }
    telemetry = {
        "method_id": ranker.method_id,
        "n_queries": len(query_seconds),
        "total_seconds": sum(query_seconds),
        "mean_seconds_per_query": fmean(query_seconds),
        "min_seconds_per_query": min(query_seconds),
        "max_seconds_per_query": max(query_seconds),
        "per_query": per_query,
        "observational_only": True,
    }
    return canonical, telemetry


def decide_gate(methods: Sequence[dict[str, Any]]) -> dict[str, Any]:
    bm25 = next(
        (method for method in methods if method["method_id"] == "bm25" and method["status"] == "completed"),
        None,
    )
    semantic = [
        method for method in methods if method["kind"] == "semantic" and method["status"] == "completed"
    ]
    if bm25 is None or not semantic:
        return {
            "decision": "FAIL",
            "reason": "BM25 or every configured semantic model was unavailable.",
            "thresholds": {"semantic_top_3_min": GATE_MIN_TOP_3, "absolute_delta_min": GATE_MIN_DELTA},
        }
    best = sorted(
        semantic,
        key=lambda item: (-item["overall"]["top_3_accuracy"], item["method_id"]),
    )[0]
    semantic_score = best["overall"]["top_3_accuracy"]
    baseline_score = bm25["overall"]["top_3_accuracy"]
    delta = _rounded(semantic_score - baseline_score)
    if semantic_score >= GATE_MIN_TOP_3 and delta >= GATE_MIN_DELTA:
        decision = "PASS"
    elif semantic_score > baseline_score:
        decision = "PARTIAL"
    else:
        decision = "FAIL"
    return {
        "decision": decision,
        "best_semantic_method": best["method_id"],
        "semantic_top_3_accuracy": semantic_score,
        "bm25_top_3_accuracy": baseline_score,
        "absolute_delta": delta,
        "thresholds": {"semantic_top_3_min": GATE_MIN_TOP_3, "absolute_delta_min": GATE_MIN_DELTA},
    }


def _write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _markdown(result: dict[str, Any]) -> str:
    lines = [
        "# Circumlocution benchmark",
        "",
        f"**Gate: {result['gate']['decision']}**",
        "",
        "This is a synthetic, hand-authored, closed-set retrieval benchmark conditioned on the known support domain. It is not clinical evidence or a fairness estimate.",
        "",
        f"Candidate text: `{result['candidate_text_mode']}` only. Sample: n={result['dataset']['n_pairs']} pairs; 20 candidates per domain.",
        "",
        "The build specification names the product metric precision@3. With one gold target per query, the reported quantity is formally top-3 accuracy (hit rate@3).",
        "",
        "| Method | Type | Top 1 | Top 3 | MRR | n |",
        "|---|---|---:|---:|---:|---:|",
    ]
    for method in result["methods"]:
        if method["status"] != "completed":
            lines.append(f"| {method['method_id']} | {method['kind']} | unavailable | unavailable | unavailable | 0 |")
            continue
        metrics = method["overall"]
        lines.append(
            f"| {method['method_id']} | {method['kind']} | {metrics['top_1_accuracy']:.3f} | "
            f"{metrics['top_3_accuracy']:.3f} | {metrics['mean_reciprocal_rank']:.3f} | {metrics['n']} |"
        )
    gate = result["gate"]
    if gate.get("best_semantic_method"):
        lines.extend(
            [
                "",
                "## Gate calculation",
                "",
                f"Best semantic: `{gate['best_semantic_method']}` = {gate['semantic_top_3_accuracy']:.3f}; "
                f"BM25 = {gate['bm25_top_3_accuracy']:.3f}; absolute gain = {gate['absolute_delta']:.3f}.",
            ]
        )
    lines.extend(
        [
            "",
            "## Limits",
            "",
            "The dataset contains no demographics, real-user provenance, none-of-the-above cases, or multi-intent labels. Category slices are target-confounded. Model choice was evaluated on this same development set. Hardware-dependent query latency is logged separately in `latency.json` and is excluded from the canonical, byte-stable result.",
            "",
        ]
    )
    return "\n".join(lines)


def run_benchmark(
    *,
    pairs_path: Path,
    targets_path: Path,
    output_dir: Path,
    text_mode: str = "description",
    offline: bool = False,
) -> dict[str, Any]:
    dataset = load_benchmark(pairs_path, targets_path)
    rankers: list[Ranker] = [TokenOverlapRanker(), BM25Ranker()]
    rankers.extend(
        EmbeddingRanker(spec, seed=SEED, local_files_only=offline, device="cpu")
        for spec in configured_model_specs()
    )
    methods: list[dict[str, Any]] = []
    telemetry: list[dict[str, Any]] = []
    for ranker in rankers:
        try:
            method, timing = evaluate_ranker(dataset, ranker, text_mode=text_mode)
        except RankerUnavailable as exc:
            method = {
                "method_id": ranker.method_id,
                "kind": ranker.kind,
                "status": "unavailable",
                "candidate_text_mode": text_mode,
                "error": str(exc),
                "metadata": ranker.metadata(),
            }
            timing = {"method_id": ranker.method_id, "status": "unavailable", "observational_only": True}
        methods.append(method)
        telemetry.append(timing)

    result = {
        "schema_version": 1,
        "seed": SEED,
        "dataset": {
            "fingerprint_sha256": dataset.fingerprint,
            "n_pairs": dataset.sample_size,
            "n_domains": len(dataset.domains),
            "n_categories": len(dataset.categories),
            "authorship": dataset.catalog.authorship,
            "evaluation": "closed-set, single-gold, oracle-domain-conditioned retrieval",
        },
        "candidate_text_mode": text_mode,
        "methods": methods,
        "gate": decide_gate(methods),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    _write_json(output_dir / "benchmark.json", result)
    (output_dir / "summary.md").write_text(_markdown(result), encoding="utf-8")
    _write_json(
        output_dir / "latency.json",
        {
            "observational_only": True,
            "excluded_from_reproducibility_claim": True,
            "methods": telemetry,
        },
    )
    return result


def build_parser() -> argparse.ArgumentParser:
    base = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Run the Wordless Module 0 retrieval gate")
    parser.add_argument("--pairs", type=Path, default=base / "data" / "circumlocution.jsonl")
    parser.add_argument("--targets", type=Path, default=base / "data" / "targets.json")
    parser.add_argument("--output", type=Path, default=base / "results")
    parser.add_argument("--text-mode", choices=("description", "enriched"), default="description")
    parser.add_argument("--offline", action="store_true", help="load embedding weights from the local cache only")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result = run_benchmark(
        pairs_path=args.pairs,
        targets_path=args.targets,
        output_dir=args.output,
        text_mode=args.text_mode,
        offline=args.offline,
    )
    print(
        f"{result['gate']['decision']}: wrote deterministic results to "
        f"{args.output / 'benchmark.json'}"
    )
    return 0 if result["gate"]["decision"] != "FAIL" else 2


if __name__ == "__main__":
    raise SystemExit(main())

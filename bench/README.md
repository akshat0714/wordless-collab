# Module 0: circumlocution benchmark

This benchmark is the gate for Wordless. It compares semantic retrieval with
BM25 and token-overlap baselines over fixed, domain-specific candidate pools.

## Reproduce the run

From the repository root, use the locked environment and packaged data:

```sh
uv sync --frozen --extra test
uv run --frozen python -m pytest tests/bench
uv run --frozen python -m bench.run
```

The benchmark reads `bench/data/circumlocution.jsonl` and the adjacent
`targets.json`, then writes machine-readable JSON and a Markdown summary under
`bench/results/`. Run `uv run --frozen python -m bench.run --help` before using
non-default paths, model configuration, or output locations.

The first semantic run may download model weights. Cache those weights before
an offline run and keep the dependency lockfile, input files, seed, and model
configuration unchanged. Rankings and metrics are deterministic for those
inputs; wall-clock latency is diagnostic and will vary by machine.

## Semantic-model failures are failures

A missing or unloadable embedding model is reported as unavailable. The
harness does **not** replace it with token overlap, BM25, random vectors, hash
vectors, or another fake semantic implementation. A gate result therefore
cannot pass unless a real configured semantic model completed successfully.

## Dataset limitation

The pairs and target descriptions are hand-authored. They are balanced test
cases, not AphasiaBank data, a clinical sample, or evidence about prevalence
or production accuracy. Report results as retrieval performance on this named
benchmark only. Evaluation on consented, representative data remains separate
work.

This is also a closed-set, oracle-domain task: each query is ranked only
against the known candidate pool for its labeled domain. With exactly one gold
target, the spec's “precision@3” is formally top-3 hit rate (top-3 accuracy),
not the fraction of three returned items that are relevant. Reports retain the
spec's name while stating that method explicitly.

The canonical gate uses target descriptions only. A variants-enriched rerun is
exploratory because its hand-authored phrasings can overlap the benchmark's
construction. Do not use enriched results for the gate without an independent
held-out query set.

## Gate

Let the semantic score be the best successfully completed configured semantic
model and compare it with BM25 on the same pairs and candidate pools.

- **PASS:** semantic precision@3 is at least `0.75` and exceeds BM25
  precision@3 by at least `0.25` absolute.
- **PARTIAL:** semantic retrieval beats BM25 but misses either PASS threshold.
- **FAIL:** semantic retrieval does not beat BM25, or no semantic model
  completed. Stop downstream work and revisit the thesis or benchmark design.

Every reported metric must retain its method, denominator, and sample size.

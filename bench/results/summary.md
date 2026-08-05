# Circumlocution benchmark

**Gate: PASS**

This is a synthetic, hand-authored, closed-set retrieval benchmark conditioned on the known support domain. It is not clinical evidence or a fairness estimate.

Candidate text: `description` only. Sample: n=128 pairs; 20 candidates per domain.

The build specification names the product metric precision@3. With one gold target per query, the reported quantity is formally top-3 accuracy (hit rate@3).

| Method | Type | Top 1 | Top 3 | MRR | n |
|---|---|---:|---:|---:|---:|
| token_overlap | lexical | 0.281 | 0.469 | 0.427 | 128 |
| bm25 | lexical | 0.344 | 0.477 | 0.468 | 128 |
| embedding_small | semantic | 0.633 | 0.852 | 0.758 | 128 |
| embedding_strong_general | semantic | 0.617 | 0.852 | 0.749 | 128 |
| embedding_instruction_tuned | semantic | 0.664 | 0.797 | 0.756 | 128 |

## Gate calculation

Best semantic: `embedding_small` = 0.852; BM25 = 0.477; absolute gain = 0.375.

## Limits

The dataset contains no demographics, real-user provenance, none-of-the-above cases, or multi-intent labels. Category slices are target-confounded. Model choice was evaluated on this same development set. Hardware-dependent query latency is logged separately in `latency.json` and is excluded from the canonical, byte-stable result.

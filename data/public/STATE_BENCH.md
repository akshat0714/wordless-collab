# STATE-Bench public replay fixture

Wordless uses the **customer-support Agent Learning Track** from Microsoft
STATE-Bench v0.8.1 as a synthetic, exported-state replay fixture.

- Repository: <https://github.com/microsoft/STATE-Bench>
- Version: `v0.8.1`
- Commit: `4efcbf2d4fe60df04878859b692d9391f3d5b33a`
- License: [MIT](https://github.com/microsoft/STATE-Bench/blob/4efcbf2d4fe60df04878859b692d9391f3d5b33a/LICENSE)
- Archive SHA-256: `5fd2a2d403d7345e82f1fc1aada8d8dfa0a07ee5abb7fa742910a3c7d01c5879`

The fixture joins the 100 published customer-support train trajectories to
their task definitions and initial task environments by task ID. The extracted
IDs must exactly match the authoritative `splits.train` manifest. Wordless
reads the JSON directly and never imports or executes the STATE-Bench runtime.

## Mapping and limitations

STATE-Bench is a synthetic agent benchmark, not a sample of production support
traffic. Findings from it can exercise replay mechanics, but cannot estimate
real-world failure prevalence or customer impact.

The source provides one logical `task.now` timestamp and no per-turn wall-clock
times. Wordless assigns that time to the interaction, messages, initial
shipment facts, and resolution, and records
`temporal_granularity=task_now`. Terminal `[TASK_DONE]` simulator markers are
removed; an otherwise empty marker turn is omitted.

Each task user's environment record becomes a minimal, non-identifying
account-presence fact so privacy-edge tasks retain honest exported provenance.
Initial orders belonging to the task user become exported shipment facts.
Closed order lifecycle states override stale shipping fields; for example,
`fully_returned` is normalized to `returned`. Lateness is not inferred by the
adapter. Successful mutation calls with `confirm: true` become resolution
actions only when their result has no error. The latest assistant response is
the closing text, and `original_label` remains null. Product names are read
from the structured environments and protected from PERSON false positives at
both ingest and replay redaction boundaries.

Benchmark-only oracle material is excluded from runtime interactions. Task
summaries, simulator context and rules, task and state requirements, scores,
and state diffs are neither copied into metadata nor used as resolution labels.

Raw files are not committed. `scripts/download_state_bench.py` stores the
commit-pinned archive and extracted corpus beneath
`.wordless/public/state-bench-v0.8.1/`, verifies the exact archive size and
SHA-256 before extraction, rejects unsafe ZIP entries, extracts only the 302
required files, and can byte-compare the extracted corpus to the verified
archive before replay. Microsoft does not endorse Wordless or its findings.

`scripts/run_state_bench_public_audit.py` keeps a byte-pinned ten-task oracle
manifest outside runtime inputs, freezes a stratified 20 development / 40
calibration / 40 held-out split, and builds risk–coverage only from the
held-out labels. Its output under `outputs/statebench-public-audit/` is a
synthetic feasibility report, never a production estimate or human review.

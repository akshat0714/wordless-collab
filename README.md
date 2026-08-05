# Wordless

> Collaborating on this copy? Read [COLLABORATING.md](COLLABORATING.md) before
> creating a branch. This repository is not connected to the current public
> deployment.

Wordless is a normal customer-support chatbot layer with an evidence-first
communication aid built in. In the current English-only version, a company's
backend can pass every English-language customer message through Wordless with
current account evidence. Wordless either adds a small, evidence-backed
clarification or explicitly tells the company's existing chatbot to continue
normally.

The interaction is designed around aphasia-aware, low-composition principles:
a customer can use fragments, confirm a short concrete choice, or press
**I don’t know what to say** without writing a sentence. The option is available to
everyone; Wordless never diagnoses, infers, or stores a disability label. The
company keeps its existing knowledge base, workflows, interface, and human
handoff. See the [support chatbot product brief](docs/support-chatbot-product.md)
and [chat assistance contract](docs/chat-assistance-contract.md).

The same evidence-first engine can replay resolved support history to find
interactions where point-in-time account state disagreed with the recorded
resolution. The audit path remains export-only and never writes to a customer
system. The live Zendesk sidecar can send customer-visible messages and change
Switchboard routing; it cannot refund, cancel, unlock, edit an account, or take
another business action. The current commercial scope is a controlled,
single-tenant paid pilot; see the [pilot product brief](docs/evidence-sidecar-pilot.md).

## What is implemented

- A reproducible 128-pair circumlocution gate with token overlap, BM25, and
  three verified embedding models.
- Strict canonical models, per-corpus HMAC customer keys, future-state leakage
  rejection, provider-neutral LLM timeouts/fallbacks, offline embeddings, and
  eager startup verification of every configured model ID and revision.
- Mandatory ingest-time PII redaction with pinned Presidio/spaCy weights,
  redaction reports, five streaming export adapters, a YAML-mapped generic
  adapter, and one-file DuckDB corpus stores. Typed amounts and opaque IDs
  survive a closed grammar; product names require an exact trusted
  SKU-to-canonical-name catalog match and otherwise become `product-ref:<ID>`.
- Three-rung state reconstruction with explicit degraded-mode reporting, plus
  deterministic summarize/taxonomy/distill orchestration and immutable weak-
  label audit records. Stage 4 records an outcome for every full-corpus label;
  each safe condition reports both label and full-corpus match counts. Only an
  explicitly human-approved, canonically revalidated proposal can compile into
  a confirmed runtime detector. Compiled detectors retain their proposal ID,
  and proposal YAML round-trips through the same strict schema.
- Confirmed evidence detectors, semantic reranking, calibrated abstention,
  risk–coverage curves, two-stage replay judging, and denominator-bearing
  metrics. Human-editable detector text is rescanned during review, compilation,
  persistence, and again immediately before any embedding call.
- Deterministic HTML/JSON audit reports, a familiar live customer-support chat,
  one open conversation across four simultaneous evidence-backed use cases, a universal low-composition choice
  action, normal-bot passthrough, a minimal integration page, separate audit
  and detector-review tools, a zero-runtime-dependency accessible SDK with a
  VPAT, and a Sunshine Conversations v2 Zendesk Messaging adapter. The four
  shipped evidence families are duplicate charges, late deliveries, wrong items,
  and locked accounts.
- A versioned, tenant-bound server-to-server suggestion API with scoped bearer
  keys, exact-body HMAC signatures, SQLite idempotency, persisted event replay,
  and human feedback. It is intentionally a single-process, single-node pilot.
- A durable Zendesk Messaging gateway with authenticated v2 webhooks, strict
  installation and Switchboard ownership checks, verified-user evidence lookup,
  native composition-help choices, PostgreSQL event/outbox state, one-time
  signed selections, normal-bot and human handoff, and bounded control release.
  The hardened deployment keeps the gateway, evidence API, and database private
  behind one public HTTPS edge.
- A pinned CC BY 4.0 public help-desk corpus downloader and a clearly labeled
  synthetic end-to-end fixture, plus a separate commit-pinned MIT-licensed
  STATE-Bench exported-state feasibility audit.

## Module 0 gate

The canonical benchmark uses target descriptions only, fixed 20-way
domain-local candidate pools, and one gold intent per query.

| Method | Top 1 | Top 3 hit rate | MRR | n |
|---|---:|---:|---:|---:|
| Token overlap | 28.1% | 46.9% | 0.427 | 128 |
| BM25 | 34.4% | 47.7% | 0.468 | 128 |
| MiniLM-L6-v2 | 63.3% | 85.2% | 0.758 | 128 |
| MPNet-base-v2 | 61.7% | 85.2% | 0.749 | 128 |
| E5-base-v2 | 66.4% | 79.7% | 0.756 | 128 |

The best semantic result beats BM25 by 37.5 percentage points and clears the
specified gate. The spec calls the product metric “precision@3”; with one gold
item it is formally top-3 accuracy or hit rate@3. This is a synthetic,
closed-set, known-domain feasibility result—not clinical evidence, a fairness
estimate, or a production accuracy claim. See `bench/results/summary.md` for
the canonical result and limits.

## Run locally

Requirements: Python 3.11+, `uv`, and Node.js 20+.

For the complete local support-chat product, install once and then use one
command:

```sh
uv sync --frozen --extra test
npm --prefix console ci
uv run python scripts/run_wordless.py
```

The launcher starts the real-time API and support-chat console, waits for both
to be ready, and opens `http://127.0.0.1:3000/live`. Press Ctrl-C in that terminal to
stop both services. It is a loopback-only development demo; do not expose it on
a public or shared network.

In the chat, type any English complete, incomplete, misspelled, or jumbled
message into one synthetic account with all four evidence families, or press
**I don’t know what to say**. Greetings, receipt questions, return questions,
and human requests demonstrate the ordinary host-bot path; unsupported
questions continue safely instead of being forced into a fabricated intent.

For a copy-ready Zendesk Messaging integration, see the
[Sunshine Conversations v2 guide](sdk/integrations/zendesk/README.md).

## Run a real Zendesk Sandbox pilot

The public, synthetic product demo is live at
[wordless-support.magarwal-iit.chatgpt.site](https://wordless-support.magarwal-iit.chatgpt.site).
It stores no visitor messages and is not connected to a customer account.

For authenticated Zendesk users, use the dedicated paid-pilot deployment in
[`deploy/zendesk`](deploy/zendesk/README.md). It packages the public HTTPS
webhook, durable gateway, private Wordless API, PostgreSQL, mounted secrets,
migrations, health checks, retention, and backup/rollback procedure. Start in a
Zendesk Sandbox. This Switchboard package is a front door: it evaluates messages
only while Wordless is the active integration. Embedding the server SDK in the
company's active bot is the mode that can evaluate every English-language turn.
After the interactive bootstrap creates the customer-specific configuration,
the stack starts with:

```sh
cd deploy/zendesk
docker compose --env-file .env.production -f compose.yaml up --build -d
python3 smoke.py --confirm-sandbox
```

The bootstrap needs a real Zendesk custom-integration key, webhook secret, app
and Switchboard identifiers, a public DNS name, a customer evidence-resolver
URL, and a threshold approved on that customer's labeled Sandbox evaluation.
Those values cannot be safely invented. The deploy guide gives the exact
prompt, five webhook subscriptions, evidence-resolver contract, acceptance
tests, and stop/rollback commands.

This is a deployable single-company pilot, not yet a self-service Marketplace
listing. Marketplace distribution additionally requires Zendesk partner
approval, Zendesk-issued OAuth credentials, legal/support URLs, and the
customer-facing installation service described in the
[Zendesk live-product boundary](docs/zendesk-live-product.md).

To run the engineering verification separately:

```sh
uv sync --frozen --extra test
uv run python -m bench.run --offline
uv run pytest
```

The first online benchmark run downloads the three verified embedding models.
After that, `--offline` completes from the local cache. Canonical benchmark JSON
and Markdown exclude timing telemetry and are byte-identical across repeated
runs; hardware-dependent latency is logged separately.

Run the deterministic fixture audit:

```sh
uv run python scripts/run_fixture_audit.py
```

Its risk–coverage curve is evaluated only on the complementary held-out half of
the synthetic fixture. Correctness means the top detector ID matches fixture
metadata; intentionally contradictory resolutions are not counted as prediction
errors. Clean records and records with no candidate are handled conservatively.

Download the public corpus. The script pins version 2, verifies every published
SHA-256 digest, and stores raw files under the ignored `.wordless/` workspace:

```sh
uv run python scripts/download_public_corpus.py
uv run python scripts/run_public_audit.py
```

The source is Mohammad Abdellatif’s *Help Desk Tickets*, DOI
[`10.17632/btm76zndnt.2`](https://doi.org/10.17632/btm76zndnt.2), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Its export lacks
linked account state, so public replay results are reported separately as
degraded evidence. On the pinned 360-interaction sample, all 360 records are
rung-3 inferred and the evidence-eligible denominator is zero; the public
report therefore marks agreement, disagreement precision, judge agreement,
and risk–coverage as not estimable instead of fabricating values.

Run the separate evidence-backed synthetic STATE-Bench path:

```sh
uv run python scripts/download_state_bench.py
uv run python scripts/run_state_bench_public_audit.py
```

This pins Microsoft STATE-Bench v0.8.1 to commit
`4efcbf2d4fe60df04878859b692d9391f3d5b33a`, verifies the archive SHA-256 and
byte-compares every extracted input before replay, then writes
`outputs/statebench-public-audit/report.json` and `index.html`. Its 100
customer-support trajectories and account/order records are synthetic. Task
oracles remain outside runtime interactions and are used only for the frozen
20/40/40 feasibility evaluation; the report labels replay disagreements as
unverified synthetic flags and reports zero human-reviewed judgments. This
path is not registered as a sellable export adapter and does not import the
STATE-Bench runtime package.

Start the loopback-only real-time pilot on port 8001:

```sh
uv run python scripts/run_realtime_api.py
```

Then start the console in another terminal and open `/live`:

```sh
cd console
npm install
npm run dev
```

The live page is at `http://127.0.0.1:3000/live`.

The console is a loopback-only development instrument. It is not deployed and
has no human/session authentication, so do not expose it on a public or shared
network. The browser calls same-origin Next handlers. The `/live` handler keeps
the real-time bearer key and signing secret in the server process; neither
credential is sent to browser JavaScript. The existing fixture audit pages also
use same-origin Next handlers, including `/api/audits/fixture`, and do not
require a separate API process on port 8000.

The standalone integration client exercises request-bound exact-body signing,
idempotent retries, and event replay without the console. It does not write
feedback by default:

```sh
uv run python scripts/realtime_example_client.py
```

For a disposable local demo only, explicitly opt in to synthetic feedback. The
example automatically confirms its first candidate (or records none), so this
is not a substitute for a human review flow:

```sh
uv run python scripts/realtime_example_client.py --record-feedback
```

The standalone real-time API above implements application-layer authentication
and tenant isolation, but uses SQLite and process-local rate/concurrency
controls. Do not expose it by itself. The Zendesk pilot stack keeps this API on
its private network and puts durable webhook/delivery state in PostgreSQL. See the
[real-time integration guide](docs/realtime-integration.md) for credentials,
request signing, console proxy configuration, idempotency, feedback, and
production requirements.

## Export adapters

`ZendeskAdapter`, `IntercomAdapter`, `ChatwootAdapter`, and `ZammadAdapter`
recognize their native export shapes. `GenericAdapter` accepts CSV, JSONL,
JSON, YAML, gzip, or zip data plus a YAML column mapping. Every adapter streams
through the same redaction boundary before an `Interaction` can be yielded or
persisted.

Only facts at or before `opened_at` are accepted. State fidelity is reported
as exported, reconstructed from explicit agent statements, or inferred
customer-text-only. Inferred results are degraded and never blended into an
exported-state headline.

## SDK

```sh
cd sdk
npm install
npm test
npm run build
```

`@wordless/sdk/server` is the Node.js backend client: it validates payloads,
creates exact-body HMAC signatures, preserves idempotency across one safe retry,
and validates bounded API responses. Its `createSupportChatbotAdapter()` API
turns each request into a framework-neutral host instruction: render choices,
render a grounded message, or continue the existing bot. `@wordless/sdk` is the
credential-free browser surface and renders at most three accessible
confirmation choices. Credentials never enter browser JavaScript. See the
[SDK integration guide](sdk/README.md) and [real-time API
guide](docs/realtime-integration.md).

## Measurement rules

- Every rate includes its numerator, denominator, sample size, and method.
- All randomness is seeded; report dates come from explicit run inputs.
- Every model call crosses a timeout/cache/fallback boundary.
- Proposed detectors do not run until a human approves them.
- A clean account produces zero hypotheses.
- A report lists its state provenance, judge validation, sample sizes, and
  limits next to the findings.

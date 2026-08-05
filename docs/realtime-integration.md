# Real-time server-to-server integration

The Wordless real-time API is a **single-node pilot** for backend integrations.
It accepts point-in-time interaction evidence, returns at most three ranked
suggestions, and requires a human to confirm or reject every result. It never
writes to a customer system.

This pilot is not an internet-ready production service. It uses SQLite plus
process-local rate limiting and inference concurrency, and it has no distributed
queue or cross-node coordination. See [Production requirements](#production-requirements)
before exposing an integration beyond a controlled pilot.

## Local quick start

Install the Python environment, then start the loopback-only API:

```sh
uv sync --frozen --extra test
uv run python scripts/run_realtime_api.py
```

The server listens on `http://127.0.0.1:8001`; its development-only OpenAPI UI
is at `http://127.0.0.1:8001/docs`. The first online start downloads and verifies
the pinned embedding model. Once it is cached, use `--offline` to prohibit model
downloads.

In another terminal, run the signed reference client:

```sh
uv run python scripts/realtime_example_client.py
```

The example submits a deterministic duplicate-charge request and reads its
persisted server-sent events. It does not write feedback by default. Run it
again with the same body and key to see `Idempotent-Replayed: true` on the
suggestion response.

For a disposable local demo, feedback is an explicit opt-in:

```sh
uv run python scripts/realtime_example_client.py --record-feedback
```

That flag records synthetic agent feedback by automatically confirming the
first candidate, or recording none after an abstention. Do not use it as a
pattern for production outcomes; a real integration must present the result to
an authenticated human reviewer and record that person's actual decision.

Development mode auto-provisions these public, local-only fixtures:

```text
Bearer key:     wl_live_demo.local_only_wordless_key_2026_07_25
Signing secret: local-only-signing-secret-2026-07-25
```

Development mode is loopback-only and does not enforce signatures. The example
client still applies the complete request-bound signature that a production
caller must use. Never reuse the built-in credentials outside local
development. Its `1.5` / `demo-floor-v1` decision floor is illustrative: it
separated the four shipped short-message fixtures (lowest observed score 1.537)
from a small local set of ordinary negative messages (highest observed score
1.494). Those are development fixtures, not a representative labeled sample;
the floor is not calibrated customer evidence or a production accuracy claim.

## API surface

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/health/live` | none | Process liveness |
| `GET` | `/health/ready` | none | SQLite and warmed-model readiness |
| `POST` | `/v1/chat/assist` | `suggestions:write` | Return choices, a grounded current-state reply, or `continue_host_bot` |
| `POST` | `/v1/suggestions` | `suggestions:write` | Evaluate one interaction |
| `GET` | `/v1/suggestions/{id}` | `suggestions:read` | Read a completed suggestion |
| `GET` | `/v1/suggestions/{id}/events` | `suggestions:read` | Replay persisted SSE events |
| `POST` | `/v1/suggestions/{id}/feedback` | `feedback:write` | Record the human outcome |

All `/v1` calls require `Authorization: Bearer <api-key>`. Every POST also
requires `Content-Type: application/json` and a 16–128 character
`Idempotency-Key` made from letters, numbers, `.`, `_`, `:`, or `-`.

## Server-to-server credentials

Keep the bearer key and signing secret in the integrating backend. Do not put
them in a browser, mobile application, console bundle, log, or analytics event.
The bearer key selects the tenant; callers cannot submit a tenant ID in the
request body. Scopes independently authorize suggestion reads, suggestion
writes, and feedback writes.

A production tenant registry is supplied through
`WORDLESS_REALTIME_TENANTS_JSON`, with a separate
`WORDLESS_REALTIME_API_KEY_PEPPER`. The API key presented by a caller is
`wl_live_<id>.<secret>`:

```json
{
  "acme": {
    "api_keys": [
      {
        "id": "acme01",
        "secret": "replace_with_24_or_more_URLsafe_chars",
        "scopes": [
          "suggestions:read",
          "suggestions:write",
          "feedback:write"
        ],
        "revoked": false
      }
    ],
    "customer_hmac_key": "replace-with-at-least-32-random-characters",
    "signing_secrets": ["replace-with-at-least-32-random-characters"]
  }
}
```

Key IDs must be globally unique. A tenant can carry two signing secrets during
a rotation. The JSON environment variable is a pilot configuration boundary,
not a substitute for a production secret manager, audited issuance, rotation,
and revocation process.

## Exact-body request signing

Production mode requires both headers on every POST:

```text
X-Wordless-Timestamp: <Unix timestamp in whole seconds>
X-Wordless-Signature: v1=<lowercase hex HMAC-SHA256>
```

Compute the digest over a versioned prefix containing the timestamp, uppercase
HTTP method, exact origin-form path, and exact `Idempotency-Key`, followed
immediately by the exact HTTP body bytes:

```python
body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
timestamp = str(int(time.time()))
path = "/v1/suggestions"
idempotency_key = "suggestion-key-018f4f"
message = (
    f"v1:{timestamp}\n"
    "POST\n"
    f"{path}\n"
    f"{idempotency_key}\n"
).encode("utf-8") + body
digest = hmac.new(signing_secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
signature_header = f"v1={digest}"
```

For feedback, `path` is the exact returned route such as
`/v1/suggestions/<suggestion-id>/feedback`. Serialize once, sign those bytes,
and send the same method, path, idempotency header, and body. Changing any of
them after signing invalidates the signature. The API has no signed POST route
with a query string. The default timestamp tolerance is 300 seconds, so
integration hosts need reliable clocks. GET requests use the bearer key but
are not body-signed.

The Python reference client accepts only origin base URLs, requires HTTPS for
every non-loopback origin, and rejects embedded credentials, paths, queries,
and fragments. It also refuses every redirect instead of risking a bearer key
being forwarded to another origin.

## Normal support-chat integration

`POST /v1/chat/assist` is the preferred endpoint for an ordinary
customer-support chatbot. A company can place it before any existing intent,
retrieval, escalation, or agent-assist workflow. Wordless returns an explicit
host instruction, so an unsupported ordinary message continues to the
company's normal bot instead of receiving an invented answer.

```json
{
  "schema_version": 1,
  "external_event_id": "message-441",
  "observed_at": "2026-07-25T12:00:00Z",
  "channel": "chat",
  "customer_external_id": "customer-17",
  "message": {
    "sent_at": "2026-07-25T12:00:00Z",
    "text": "money one twice"
  },
  "assistance_mode": "auto",
  "evidence": [
    {
      "type": "charge",
      "ref": "charge-1",
      "occurred_at": "2026-07-25T11:00:00Z",
      "order_ref": "order-441",
      "amount": "84.00",
      "currency": "USD",
      "status": "succeeded"
    },
    {
      "type": "charge",
      "ref": "charge-2",
      "occurred_at": "2026-07-25T11:06:00Z",
      "order_ref": "order-441",
      "amount": "84.00",
      "currency": "USD",
      "status": "succeeded"
    }
  ],
  "source_system": "company-support-bot",
  "metadata": {}
}
```

The strict response has one of three outcomes:

| Outcome | Integration directive | Host behavior |
|---|---|---|
| `clarification_choices` | `show_wordless` / `choices` | Show 2–3 choices and wait for the customer or agent. Adverse detector matches always use this confirmation path. |
| `grounded_reply` | `show_wordless` / `message` | Show one read-only answer only when current healthy state directly entails it. |
| `clarifying_fallback` | `continue_host_bot` / `none`, or a visible message/choice fallback | Continue the existing bot for an ordinary unsupported message, or provide structured navigation after an explicit request. |

Every response sets `review_required: true` and `read_only: true`. It also
returns `suggestion_id`, complete policy metadata, redaction counts, and
evidence summaries with zero-based `input_index` values. The `integration`
object is authoritative; host middleware does not have to infer whether it
should render Wordless or continue its existing bot.

### Universal “I don’t know what to say” action

Set `assistance_mode` to `show_choices` when the customer presses a visible
**I don’t know what to say** control. This is an interaction preference available to
every customer, not an aphasia diagnosis or disability signal. It is the only
mode that accepts an empty `message.text`.

When supported evidence exists, the response contains up to two
evidence-backed choices plus a safe alternative. When no supported hypothesis exists, the
response contains neutral, unbacked navigation choices for payment help,
delivery/item help, and account access. Those choices have `detector_id: null`
and cite no evidence, so they do not imply that an account problem is true.

After a person selects an evidence-backed choice, call the existing feedback
link with its `detector_id`. If a detector-backed offer included “Something
else,” that selection records `none`. A fully unbacked navigation menu belongs
to the host bot and does not create detector feedback. Rendering a choice is
not itself feedback.

### Incomplete, garbled, and continuing messages

`auto` mode uses concept-level retrieval: each evidence-supported detector is
represented by several short prototype vectors rather than one concatenated
sentence. A detector-local spelling repair may add one more query vector for a
short severe-typo message. A narrow character-noise gate catches non-alphabetic
input, keyboard runs, repeated characters, and multiple short consonant
clusters without evaluating grammar or labeling a person. Neither mechanism
changes the stored customer turn or creates evidence. If that low-composition
repair is strong and unambiguous, its message-ranked detector stays first and
the result reports `selection_basis: "evidence_and_message"`. Only unresolved
character noise or deliberately vague wording is recomputed without semantic
text; that route reports
`selection_basis: "contextual_evidence_choices"`.

Non-contextual `auto` candidates must clear a separate 0.40 concept-cosine
support floor before they can be shown. This guard is applied in addition to
the configured aggregate threshold because evidence and recency can otherwise
make an unrelated concept's total score look selectable. The value is a
selection guard, not a calibrated probability.

This route can return the two strongest evidence-backed options plus
`something_else`. The primary response `detector_id` and `evidence` still refer
to the first choice, while each supported choice carries its own evidence. A
clear unrelated message still returns `continue_host_bot`.

For ticket or messaging systems that already have conversation history, add a
bounded context hint without changing the v1 schema:

```json
{
  "metadata": {
    "wordless_recent_customer_messages": [
      "my package never arrived",
      "the tracking stopped"
    ]
  }
}
```

Wordless uses at most the last three string values and at most 500 characters
from each. They pass through mandatory redaction before embedding. Send only
customer-visible turns that the integration is authorized to process; do not
copy Zendesk internal notes into this field.

For Zendesk Messaging, the deployable pattern is a server-side webhook or bot
orchestrator that (1) receives the new public customer message, (2) reads the
necessary ticket/user fields, (3) maps those fields to the typed Wordless
evidence array, (4) calls `/v1/chat/assist`, and (5) renders choices or continues
the existing Zendesk bot according to `integration.host_action`. Keep the
Wordless bearer and signing secrets in that backend, never in Sunshine
Conversations or Web Widget client code.

The private `@wordless/sdk/server` package exposes the strict low-level
`client.assist()` method and `createSupportChatbotAdapter()`, which accepts a
vendor-neutral host message and returns a framework-neutral host turn. See the
[SDK integration guide](../sdk/README.md) and its copy-ready examples.

## Suggestions and evidence

Requests are schema-versioned and accept typed, point-in-time evidence only:

```json
{
  "schema_version": 1,
  "external_event_id": "evt_018f4f",
  "observed_at": "2026-07-25T12:00:00Z",
  "channel": "chat",
  "customer_external_id": "customer-42",
  "utterance": {
    "sent_at": "2026-07-25T11:59:00Z",
    "text": "I think I paid twice for the same order."
  },
  "evidence": [
    {
      "type": "charge",
      "ref": "charge-1",
      "occurred_at": "2026-07-25T11:10:00Z",
      "order_ref": "order-7",
      "amount": "84.00",
      "currency": "USD",
      "status": "succeeded"
    },
    {
      "type": "charge",
      "ref": "charge-2",
      "occurred_at": "2026-07-25T11:40:00Z",
      "order_ref": "order-7",
      "amount": "84.00",
      "currency": "USD",
      "status": "succeeded"
    }
  ],
  "source_system": "support-backend",
  "metadata": {}
}
```

Supported evidence types are `charge`, `shipment`, `fulfillment`, and
`account_access`. The utterance and every evidence item must be at or before
`observed_at`; future-state evidence is rejected. Amounts are decimal strings,
not floating-point JSON numbers. The response either contains up to three
candidates or explicitly abstains, and always sets `review_required` to `true`.
Ranking scores are not probabilities. Each returned evidence summary includes
`input_index`, the zero-based position of the cited item in the request's
`evidence` array. Use that index to connect a candidate to the integrating
product's in-memory record. Wordless returns only an opaque HMAC-derived `ref`;
it does not echo the caller's raw evidence reference.

## Retry and idempotency behavior

Choose one idempotency key for one logical POST operation and persist it before
sending. Keep that key and the exact body across timeouts, connection failures,
and safe retries. Use a separate key for feedback.

- A first suggestion returns `201 Created`.
- Retrying the same suggestion key with the same body returns the stored result
  with `200 OK` and `Idempotent-Replayed: true`.
- Reusing a key with different body bytes returns `409 Conflict`.
- A matching request still in progress returns `409 Conflict` with
  `Retry-After: 1`.
- A repeated feedback key and identical body returns the recorded feedback;
  conflicting feedback returns `409 Conflict`.

`external_event_id` is traceable source identity, not a replacement for the
idempotency key. Generate keys in the integration backend, not in a retry loop.

## Human feedback

For a confirmed candidate, send its `detector_id` exactly as returned:

```json
{
  "schema_version": 1,
  "outcome": "confirmed",
  "selected_detector_id": "duplicate_charge",
  "actor": "agent"
}
```

For an abstention or a human selecting none, send:

```json
{
  "schema_version": 1,
  "outcome": "none",
  "selected_detector_id": null,
  "actor": "agent"
}
```

The selected detector must have been offered on that suggestion. A suggestion
accepts one durable human outcome; use idempotent retries rather than sending a
second decision.

The reference client leaves this endpoint untouched unless
`--record-feedback` is supplied. Its generated outcome is synthetic and is
intended only to demonstrate the wire contract against disposable local data.

## Event replay

`GET /v1/suggestions/{id}/events` returns `text/event-stream` records persisted
for that suggestion. Send `Last-Event-ID: <sequence>` to resume after an event.
The current synchronous pilot completes inference before the suggestion POST
returns, so this endpoint is a replayable audit stream rather than a durable
asynchronous job channel.

## Local-only console live view and audit pages

Start the real-time API on port 8001 first, then start the console:

```sh
uv run python scripts/run_realtime_api.py

# In another terminal:
cd console
npm install
npm run dev
```

Open `http://127.0.0.1:3000/live`. The browser sends one editable, bounded demo
utterance and feedback to same-origin Next routes. The Next server proxy adds
two current succeeded USD 84.00 charge facts, builds the versioned upstream
payload, attaches the service bearer key, signs POSTs when configured, and
applies idempotency keys. It strictly validates the response and renders zero to
three review-required candidates or an abstention. Service credentials remain
in the server process and are never returned to browser JavaScript, and the
flow never writes to a customer system.

This console is a local development instrument: it is not deployed and has no
human/session authentication. Its development command binds to `127.0.0.1`.
Do not change that binding or expose the console on a public or shared network.

Local development uses the built-in demo bearer key and the API at
`http://127.0.0.1:8001`. To configure the Next server explicitly, set these in
its runtime environment (never with a `NEXT_PUBLIC_` prefix):

```sh
WORDLESS_REALTIME_API_BASE_URL=http://127.0.0.1:8001 \
WORDLESS_REALTIME_API_KEY=wl_live_demo.local_only_wordless_key_2026_07_25 \
WORDLESS_REALTIME_SIGNING_SECRET=local-only-signing-secret-2026-07-25 \
npm run dev
```

The existing audit and detector-review pages also use same-origin Next
handlers. In particular, `/api/audits/fixture` launches the fixed local fixture
script, so those pages do not require a separate API process on port 8000.

The `/live` page is only a convenient local pilot surface, not a deployable
human review console. A production review surface would need its own
authenticated human sessions, authorization and audit controls, HTTPS, and
deployment-specific security review. Use `scripts/realtime_example_client.py`
as the direct backend integration reference.

## Controlled-pilot ASGI entrypoint

For a private, single-node company pilot, configure the complete environment
through the process manager and run the production-mode ASGI factory behind a
TLS-terminating gateway:

```sh
uv run uvicorn --factory wordless.api.product_asgi:create_app \
  --host 127.0.0.1 --port 8001
```

The factory refuses development mode and does not provision demo credentials.
It also refuses to start unless the embedding model and revision are pinned,
request signatures are enabled, and both `WORDLESS_REALTIME_THRESHOLD` and
`WORDLESS_REALTIME_THRESHOLD_VERSION` are explicitly configured. The threshold
must be nonzero and the version cannot be a demo placeholder. Choose and
version that operating point from the prospective customer's own evaluation;
the repository does not provide or claim a calibrated production threshold.

This entrypoint makes the current application deployable as a controlled
single-node pilot; it does not change the SQLite, process-local, operational,
and human-authentication limitations listed below.

## Configuration reference

`.env.example` lists safe local values, but this repository does not
automatically load `.env` files. Export variables through the process manager or
shell before constructing the app.

| Variable | Default / requirement |
|---|---|
| `WORDLESS_REALTIME_WORKSPACE` | Current directory; DB and cache must remain inside it |
| `WORDLESS_REALTIME_DATABASE_PATH` | `.wordless/realtime.sqlite3` |
| `WORDLESS_REALTIME_MODEL_CACHE_DIR` | `.wordless/cache/embeddings` |
| `WORDLESS_REALTIME_DEV_MODE` | `false`; the local launcher forces `true` |
| `WORDLESS_REALTIME_OFFLINE` | `false` |
| `WORDLESS_REALTIME_EMBED_MODEL_ID` | Explicitly pinned outside dev mode |
| `WORDLESS_REALTIME_EMBED_MODEL_REVISION` | Explicitly pinned outside dev mode |
| `WORDLESS_REALTIME_THRESHOLD` | Local demo: illustrative `1.5`; outside dev mode an explicit nonzero customer-evaluated value is required |
| `WORDLESS_REALTIME_THRESHOLD_VERSION` | Local demo: `demo-floor-v1`; outside dev mode an explicit non-placeholder version is required |
| `WORDLESS_REALTIME_MAX_BODY_BYTES` | `262144`; enforced before contract parsing |
| `WORDLESS_REALTIME_MAX_JSON_DEPTH` | `12` |
| `WORDLESS_REALTIME_RATE_LIMIT_PER_MINUTE` | `120`, process-local |
| `WORDLESS_REALTIME_MAX_INFERENCE_CONCURRENCY` | `4`, process-local |
| `WORDLESS_REALTIME_SIGNATURE_TOLERANCE_SECONDS` | `300` |
| `WORDLESS_REALTIME_MAX_FUTURE_OBSERVED_SECONDS` | `300` |
| `WORDLESS_REALTIME_TENANTS_JSON` | Required by the API outside dev mode |
| `WORDLESS_REALTIME_API_KEY_PEPPER` | Required by the API outside dev mode; at least 32 characters |
| `WORDLESS_REALTIME_TENANTS_JSON_FILE` | Absolute path to a mounted UTF-8 tenant registry secret; use instead of `WORDLESS_REALTIME_TENANTS_JSON` |
| `WORDLESS_REALTIME_API_KEY_PEPPER_FILE` | Absolute path to a mounted UTF-8 pepper secret; use instead of `WORDLESS_REALTIME_API_KEY_PEPPER` |
| `WORDLESS_REALTIME_API_BASE_URL` | Local Next server proxy origin; default is `http://127.0.0.1:8001` |
| `WORDLESS_REALTIME_API_KEY` | Local Next server proxy or example-client bearer key |
| `WORDLESS_REALTIME_SIGNING_SECRET` | Local Next server proxy or example-client POST signing secret |
| `WORDLESS_REALTIME_BASE_URL` | Example-client origin; default is `http://127.0.0.1:8001` |

## Production requirements

The application-layer contracts are useful for a controlled single-node pilot,
but production requires additional engineering and security review, including:

- TLS termination, private network controls or an API gateway, request-size
  enforcement, abuse protection, and managed denial-of-service controls.
- A managed transactional database with migrations, tenant isolation controls,
  backups, restore testing, retention, and deletion workflows.
- Distributed idempotency, rate limiting, concurrency control, and a durable job
  queue if multiple API or worker nodes are introduced.
- A secret manager, per-environment credentials, audited issuance, short
  rotation windows, revocation, and log scrubbing.
- Centralized structured logs, metrics, traces, SLOs, alerts, incident response,
  and correlation using the returned `X-Wordless-Request-Id`.
- Capacity and failure-mode testing for model startup, inference saturation,
  database contention, deploys, retries, and partial outages.
- A privacy and security review covering data minimization, regional storage,
  access auditing, customer deletion, model artifacts, and subprocessors.
- A separately authenticated human review surface. Server-to-server API keys
  must never become browser session credentials.

Do not obtain production credentials or expose the pilot publicly until these
controls, an operational owner, and a deployment-specific threat model exist.

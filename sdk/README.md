# `@wordless/sdk`

Private, zero-runtime-dependency integration package for adding Wordless to an
ordinary customer-support chatbot. It does not replace the company's bot:

- ordinary messages that Wordless cannot support continue to the existing bot;
- evidence-backed uncertainty becomes two or three short clarification choices;
- directly entailed current state may become a read-only grounded reply;
- every customer can press **I don’t know what to say**, even without typing a message.

No disability profile or diagnosis is required or inferred. Structured help is
a universal interaction preference available to everyone.

The package has two security boundaries:

- `@wordless/sdk/server` is Node.js 20+ only. It holds credentials, signs exact
  request bytes, retries one logical operation safely, validates complete
  responses, and provides the framework-neutral chatbot adapter.
- `@wordless/sdk` is credential-free browser code for the existing accessible
  confirmation-card surface. It never makes an authenticated Wordless request.

Version 0.3.0 remains `private`, `UNLICENSED`, and `restricted`. This repository
does not publish it automatically.

For a copy-ready Sunshine Conversations v2 integration, see the
[Zendesk Messaging guide](integrations/zendesk/README.md) and
[`@wordless/sdk/zendesk`](src/zendesk.ts). Distributed installation, webhook,
uninstall, and Switchboard lifecycle helpers are exported from
[`@wordless/sdk/zendesk-marketplace`](src/zendesk-marketplace.ts).

## Integration in one picture

```text
customer message or “I don’t know what to say”
                 |
                 v
company backend / bot middleware ---- ordinary unsupported turn ----> existing bot
                 |
                 | message + read-only account evidence
                 v
          Wordless chat assist
                 |
                 +--> clarification choices
                 +--> grounded read-only reply
                 +--> clarifying fallback
```

Wordless never refunds a charge, changes an order, unlocks an account, or sends
through a vendor integration. The host application decides how to render the
returned turn and owns every downstream action.

## Install from an approved private registry

```sh
npm install @wordless/sdk --registry=https://npm.your-company.example
```

Keep the API key and signing secret in the backend. Never copy them into browser
JavaScript, a mobile app, a chatbot builder's public configuration, logs, or
analytics.

## Add it to an existing support bot

Create one adapter in your backend process:

```ts
import {
  createSupportChatbotAdapter,
  createWordlessClient,
} from "@wordless/sdk/server";

const wordless = createSupportChatbotAdapter({
  client: createWordlessClient({
    baseUrl: process.env.WORDLESS_BASE_URL!,
    apiKey: process.env.WORDLESS_API_KEY!,
    signingSecret: process.env.WORDLESS_SIGNING_SECRET!,
  }),
  sourceSystem: "company-support-bot",
});
```

Pass every incoming message through `processMessage`. The data shape is plain
TypeScript and is not tied to React, Next.js, Express, a bot vendor, or a
particular transport:

```ts
const turn = await wordless.processMessage({
  messageId: incoming.id,          // durable ID from your system
  customerId: incoming.customerId,
  text: incoming.text,
  sentAt: incoming.receivedAt,
  channel: "chat",
  evidence: await loadCurrentEvidence(incoming.customerId),
  metadata: { conversation_id: incoming.conversationId },
});

if (turn.hostAction === "continue_host_bot") {
  return existingBot.respond(incoming);
}

if (turn.renderMode === "choices") {
  return host.sendChoices(turn.message, turn.choices);
}

return host.sendMessage(turn.message);
```

The adapter hashes `sourceSystem + customerId + messageId` into API-valid event
and idempotency identifiers. Customer scoping prevents two tenants/customers
that reuse the same message ID from colliding, while retrying the same customer
message preserves one logical operation. Integrations upgrading from an older
message-only derivation must drain or retry in-flight operations with the old
adapter before switching: both the derived event ID and default idempotency key
change, so an old key must not be reused with the newly derived request body.
After the switch, an explicit override remains available for systems that
persist their own operation keys for new requests.

## The three host-turn outcomes

`processMessage` returns a discriminated union. Switch on `hostAction`,
`renderMode`, or `kind`:

| `kind` | Host behavior | Meaning |
|---|---|---|
| `clarification_choices` | Show a prompt and 2–3 buttons | Evidence supports a problem, but the customer confirms what they meant before the host proceeds. |
| `grounded_reply` | Show one plain message | Current healthy state directly entails a read-only answer. This is not used for adverse detector matches. |
| `clarifying_fallback` | Continue the normal bot, or show a simple fallback/choice menu | Wordless will not invent an unsupported answer. |

Every turn includes `reviewRequired: true` and `readOnly: true`. Evidence-backed
turns expose zero-based `evidenceIndexes`, which map to the exact array supplied
in the request. Wordless does not echo the host's raw evidence references.

An ordinary unsupported message returns:

```ts
{
  kind: "clarifying_fallback",
  hostAction: "continue_host_bot",
  renderMode: "none",
  message: null
}
```

That explicit instruction is what makes Wordless middleware rather than a
replacement chatbot.

## Universal low-composition path

Put an **I don’t know what to say** button beside the normal text box. It is available to
everyone and must not be gated by, or described as evidence of, aphasia or any
other condition.

The customer can press it before entering text:

```ts
const turn = await wordless.processMessage({
  messageId: incoming.id,
  customerId: incoming.customerId,
  text: "",
  sentAt: incoming.receivedAt,
  evidence: await loadCurrentEvidence(incoming.customerId),
  showChoices: true,
});
```

With supported account evidence, Wordless presents an evidence-backed option
and a safe alternative. Without supported evidence, it presents three unbacked
navigation choices—payment help, delivery/item help, and account access—without
claiming that any problem is true. Empty text is rejected in normal automatic
mode.

## Record the human selection

Each returned choice has an `id`, visible `label`, plain-language `reply`, a
nullable `detectorId`, and `evidenceIndexes`.

After the customer or agent actually selects a choice, record that decision:

```ts
await wordless.recordConfirmation({
  suggestionId: turn.suggestionId,
  selectedDetectorId: selectedChoice.detectorId,
  actor: "customer",
  decisionId: click.id, // durable host ID, reused if this call is retried
});
```

A detector-backed choice records `confirmed`. “Something else” carries
`detectorId: null` and records `none`. Unbacked navigation choices also carry a
null detector, but belong to the host chatbot: feed their `reply` into the
existing intent/RAG workflow instead of recording detector feedback. Do not
record feedback merely because a card was rendered.

The feedback endpoint rejects a detector that was not offered for that
suggestion and accepts one durable human outcome per suggestion.

## Actual support use cases

Wordless v1 understands four normalized, read-only evidence families. A host
can send any trimmed message up to 4,000 characters; unsupported topics simply
continue to the existing bot.

| Customer wording | Evidence loaded by the company | Possible Wordless turn |
|---|---|---|
| “money one twice” | Two succeeded charges for the same order and amount | Confirm “I was charged twice” or choose “Something else.” |
| “still not come” | Shipment is delayed, late, missing, or overdue | Confirm delivery help before the host starts a resolution flow. |
| “order wrong thing” | Ordered SKU differs from delivered SKU | Confirm the wrong-item interpretation with the cited evidence indexes. |
| “can't get in” | Account is locked/blocked with failed attempts | Confirm account-access help; no automatic unlock occurs. |
| “where is package?” | Current shipment state directly entails a safe status | Show a grounded, read-only reply when the contract's evidence rules allow it. |
| “How do I change notifications?” | No relevant supported evidence | Continue the company's normal support bot untouched. |
| No typed words; customer asks for composition help | Any state, including no evidence | Show evidence-backed choices when available, otherwise neutral navigation choices. |

Normalize only state the company actually observed. The supported request union
is exported as `WordlessEvidence`:

```ts
import type { WordlessEvidence } from "@wordless/sdk/server";

const evidence: readonly WordlessEvidence[] = [
  {
    type: "charge",
    ref: "charge-1",
    occurred_at: "2026-07-25T11:00:00Z",
    order_ref: "order-441",
    amount: "84.00",
    currency: "USD",
    status: "succeeded",
  },
  {
    type: "shipment",
    ref: "shipment-1",
    occurred_at: "2026-07-25T11:30:00Z",
    order_ref: "order-441",
    status: "delayed",
    expected_delivery_at: "2026-07-24T20:00:00Z",
  },
];
```

Other supported discriminators are `fulfillment` and `account_access`. Evidence
must have occurred at or before `observedAt`, references must be unique, charge
amounts are decimal strings, and at most 100 records may be sent. The client
validates those rules before making a credentialed request.

## Common integration shapes

The adapter returns plain host instructions, so the same flow works as:

- middleware before an existing bot's normal intent/RAG handler;
- a standard HTTP or serverless route called by a web or mobile chat UI;
- a backend resolver used by a React, Vue, Svelte, native, or custom interface;
- an agent-assist hook that renders choices beside a normal reply composer;
- a voice or email backend that maps the prompt and choices into its own UI.

Copy-ready, vendor-neutral examples are included:

- [`examples/generic-support-bot.ts`](examples/generic-support-bot.ts) wraps an
  abstract existing bot without assuming its framework.
- [`examples/standard-http-handler.ts`](examples/standard-http-handler.ts)
  exposes standard `Request`/`Response` handlers for a message and confirmation.

The HTTP example is intentionally missing company-specific evidence loading and
session authorization. Those are host responsibilities, not safe defaults the
SDK can guess.

## Low-level chat-assist call

Applications that already have their own middleware abstraction can call the
strict low-level method directly:

```ts
import {
  createIdempotencyKey,
  createWordlessClient,
} from "@wordless/sdk/server";

const client = createWordlessClient({
  baseUrl: process.env.WORDLESS_BASE_URL!,
  apiKey: process.env.WORDLESS_API_KEY!,
  signingSecret: process.env.WORDLESS_SIGNING_SECRET!,
});

const response = await client.assist({
  schema_version: 1,
  external_event_id: "message-441",
  observed_at: "2026-07-25T12:00:00Z",
  channel: "chat",
  customer_external_id: "customer-17",
  message: {
    sent_at: "2026-07-25T12:00:00Z",
    text: "still not come",
  },
  assistance_mode: "auto",
  evidence,
  source_system: "company-support-bot",
  metadata: {},
}, {
  idempotencyKey: createIdempotencyKey("chat-assist", "message-441"),
});
```

`parseChatAssistResponse(unknown)` and `mapChatAssistToHostTurn(unknown)` are
also exported for applications crossing an additional untrusted JSON boundary.
Both fail closed on extra fields, invalid discriminants, inconsistent host
directives, unsupported detector/evidence combinations, malformed links,
out-of-range evidence citations, or unsafe policy metadata.

The original `suggest()` and `recordFeedback()` methods remain available for
the lower-level evidence-sidecar flow and are backward compatible.

## Transport and credential safety

The Node client:

- accepts an origin-only base URL;
- requires HTTPS except for loopback development;
- rejects embedded credentials, paths, queries, fragments, and redirects;
- validates live-key and signing-secret formats before retaining them;
- canonicalizes and signs the exact method, path, idempotency key, and JSON body;
- bounds request and response bodies;
- applies a per-attempt timeout;
- makes at most one safe retry with the same body and idempotency key;
- validates the complete success or safe error envelope.

`createIdempotencyKey(namespace, ...stableParts)` is deterministic. Build keys
from durable host identifiers, never random values created inside a retry loop.

## Browser confirmation cards

The package root still exports `mountConfirmCards`, `parseSuggestionResponse`,
and `suggestionCandidates` for the credential-free confirmation-card surface.
The chat adapter does not require this renderer: most companies should map its
plain `message` and `choices` values into their existing chat components.

For a script tag, the built artifact remains
`dist/wordless-confirm-cards.js` under `WordlessConfirmCards`.

## Clinical and product boundary

Wordless assists with hard-to-compose or ambiguous support messages. It does
not detect, diagnose, score, or verify aphasia. A production deployment should
offer the structured path universally, test it with the buyer's own support
data and users, calibrate thresholds on a held-out sample, and retain a normal
human support escape route.

The current service is appropriate for a controlled, single-tenant pilot. It
is not a claim of clinical effectiveness, universal intent coverage, or broad
multi-tenant production readiness.

## Verify and inspect the private artifact

```sh
cd sdk
npm ci
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

`npm pack --dry-run` only inspects the artifact. Publishing still requires an
explicit package-policy decision, approved private registry configuration, and
intentional handling of the `private` safeguard.

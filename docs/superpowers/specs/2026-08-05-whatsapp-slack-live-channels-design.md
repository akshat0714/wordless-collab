# WhatsApp & Slack evidence-first live channels — design

Date: 2026-08-05
Status: proposed (awaiting review)
Branch: `feature/whatsapp-slack-live-channels`

## 1. Context

Wordless already ships one live customer-facing channel: the Sunshine
Conversations v2 Zendesk Messaging adapter in `sdk/src/zendesk.ts`. It turns a
validated Wordless chat-assist response into native Zendesk actions using a
strict, read-only, signed-payload discipline. The framework-neutral core is
`createSupportChatbotAdapter()` in `sdk/src/server.ts`, which produces one of
three host turns per message:

- `clarification_choices` — a grounded message plus 2–3 evidence-backed
  confirmation choices, one of which is always the detector-free
  "I don't know what to say" choice.
- `grounded_reply` — a single evidence-backed message, no choices.
- `clarifying_fallback` — either continue the host's own bot
  (`continue_host_bot`) or show a neutral clarifying message.

This project adds two new live channels on the same core and the same rigor:
**WhatsApp Cloud API** first, then **Slack** second. Both are delivered as
zero-runtime-dependency SDK modules mirroring the Zendesk module, with a small
shared helper module extracted so the two channels do not duplicate the signing,
choice-store, and intent-detection logic.

## 2. Goals

- Let a company run Wordless's evidence-first, low-composition assist on WhatsApp
  and on Slack, reusing the existing suggestion API, SDK client, and support
  adapter unchanged.
- Preserve every Wordless invariant on the new channels: read-only, at most three
  accessible choices, a universal "not sure what to say" choice, normal-bot
  passthrough, explicit human handoff, seeded/idempotent behavior, and safe
  degradation on any error.
- Match the Zendesk module's security posture: timing-safe webhook verification,
  signed and expiring one-time choice payloads bound to the conversation, and a
  durable host-provided choice store.
- Ship fully offline-testable code under the SDK's existing vitest suite. No new
  service, no database, no Docker, no credentials, nothing deployed.

## 3. Non-goals

- No new gateway service (nothing like `services/zendesk-gateway`). These are
  pure mapping modules; the host owns webhook receipt, persistence, and the
  outbound API call, exactly as with the Zendesk SDK module.
- No account-mutating behavior. The adapters can only produce "send a message",
  "continue the host bot", or "hand off to a human" outcomes. They cannot refund,
  cancel, unlock, or edit anything.
- No export/audit adapter for WhatsApp or Slack (`wordless/ingest/*`). Scope is
  the live channel only.
- English-only, matching the current product. Locale gating is the host's
  responsibility before it calls the adapter, identical to Zendesk.
- No changes to the Wordless Python service, the suggestion API contract, or the
  `createSupportChatbotAdapter()` core.

## 4. Architecture overview

Three new source modules plus examples, tests, and integration READMEs:

```
sdk/src/channel-support.ts     # shared, channel-neutral primitives (internal)
sdk/src/whatsapp.ts            # WhatsApp Cloud API live channel  (PR 1)
sdk/src/slack.ts               # Slack live channel                (PR 2)
sdk/examples/whatsapp-cloud-handler.ts
sdk/examples/slack-events-handler.ts
sdk/tests/channel-support.test.ts
sdk/tests/whatsapp.test.ts
sdk/tests/slack.test.ts
sdk/integrations/whatsapp/README.md
sdk/integrations/slack/README.md
```

Package wiring (`sdk/package.json` `exports`): add `./whatsapp` and `./slack`
subpath exports pointing at `dist/esm/whatsapp.js` and `dist/esm/slack.js`, in
the same `node`-only shape as `./zendesk`. `channel-support.ts` stays internal
(imported by the two channel modules via a relative path and by tests); it is not
a public subpath export. `tsconfig.build.json` already includes all of `src`, so
no build-list change is needed beyond the exports map.

Each channel module depends only on `./server.js` types
(`WordlessSupportChatbot`, `WordlessSupportChatTurn`, `WordlessSupportChoice`,
`WordlessEvidence`, `WordlessJsonValue`, `WordlessSdkError`) and on
`./channel-support.js`. No third-party runtime dependencies; Node `crypto` only.

## 5. Shared module: `sdk/src/channel-support.ts`

Houses the logic both channels need identically, parameterized so it stays
channel-neutral:

- **Signed choice payloads.** `createSignedChoicePayload(...)` and
  `verifySignedChoicePayload(...)` producing the compact
  `wl2.<suggestionId>.<choiceId>.<code>.<issuedB36>.<expiresB36>.<nonce>.<sig>`
  form, where `<sig>` is a truncated HMAC-SHA256 over the core plus a
  **binding context** — an ordered list of identifiers that scopes the payload to
  one conversation. Zendesk binds `(appId, conversationId, userId)`; WhatsApp
  binds `(phoneNumberId, waId)`; Slack binds `(teamId, channelId, userId)`. The
  signer accepts `bindingParts: readonly string[]` so each channel supplies its
  own scope. Verification is timing-safe and re-derives `<code>` consistency
  (`c_<detectorId>` / `none` / `skip`) exactly as Zendesk does today.
- **Feedback classification.** `classifyChoiceFeedback(turn, choice)` returning
  `"confirmed" | "none" | "skip"` (detector choice → confirmed; null choice in a
  `clarification_choices` turn → none; otherwise skip). This is the current
  private `choiceFeedback` behavior, promoted to shared code.
- **Choice-store contract.** A generic `PendingChoiceSet` / `ResolvedChoice`
  shape and a `ChoiceStore` interface with `save(set)` and `resolve(input)` that
  atomically consumes a fresh payload once, returns the same result for an
  idempotent retry of the same selection event id, returns `null` when a
  different event id replays a consumed payload, and rejects an unconsumed
  payload after `expiresAt`. Channels re-export narrowed, channel-typed aliases.
- **Show-choices detection.** `SHOW_CHOICES_TEXT_PATTERN` and
  `isShowChoicesRequest(text, payloadMatched)`.
- **Human-handoff detection.** `detectHumanRequest(text): boolean`, the intent
  battery that today lives inside `sdk/src/zendesk.ts`. See §11 for the
  extract-vs-duplicate decision. Default plan: **extract** the battery into this
  module and have `zendesk.ts` import it, guarded by the existing
  `sdk/tests/zendesk.test.ts` coverage, so all three channels share one source of
  truth.

Everything here is pure and deterministic. All time comes from an injected
`now()` for tests; no `Date.now()` in module scope.

## 6. WhatsApp Cloud API channel (PR 1)

### 6.1 Public surface

```ts
createWhatsAppCloudAdapter(options): WhatsAppCloudAdapter
verifyWhatsAppSignature(rawBody, signatureHeader, appSecret): boolean
verifyWhatsAppSubscription(query, verifyToken): string   // GET hub.challenge echo
// plus exported types and error classes mirroring the Zendesk module
```

`WhatsAppCloudAdapterOptions`:

- `chatbot: WordlessSupportChatbot`
- `appSecret: string` — Meta app secret for `X-Hub-Signature-256`
- `phoneNumberId: string` — the business number this installation owns
- `choiceSigningSecret: string` — separate 32+ byte secret for button payloads
- `resolveAuthenticatedAccount(inbound) => Promise<WhatsAppAuthenticatedAccount | null>`
- `choiceStore: WhatsAppChoiceStore`
- `humanHandoff?: { enabled: boolean }` — when enabled, an explicit human request
  yields a `handoff` result the host routes to its human inbox
- `accountResolutionFailureMode?: "throw" | "continue"` (default `throw`)
- `choiceTtlMs?: number` (default 30 min, max 24 h)
- `now?: () => Date`
- `onWordlessError?`, `onAccountResolutionError?`, `onFeedbackError?`

`WhatsAppAuthenticatedAccount` mirrors `ZendeskAuthenticatedAccount`:
`{ authenticated: true, customerId, observedAt, evidence, metadata? }`. The
customer's `wa_id` is never used as `customerId`; the host must map an
authenticated WhatsApp identity to a company account before returning evidence.

### 6.2 Inbound flow (`processWebhook(rawBody, signatureHeader)`)

1. `verifyWhatsAppSignature` (timing-safe HMAC-SHA256, `sha256=` prefix) over the
   exact raw body → reject on mismatch (`WhatsAppWebhookValidationError`).
2. Parse the envelope: `entry[].changes[]` where `change.field === "messages"`;
   confirm `value.metadata.phone_number_id === phoneNumberId`; read
   `value.contacts[].wa_id` and `value.messages[]`. `value.statuses[]` (delivery
   receipts) and unsupported message types are returned as `ignored` results.
   Bounded: at most N entries/changes/messages per webhook.
3. Message typing:
   - `type === "text"` → `text.body` is the customer utterance.
   - `type === "interactive"` with `interactive.type === "button_reply"` →
     `button_reply.id` is a signed choice payload (see 6.4).
   - other types (image, audio, location, …) → `ignored` (`unsupported_content`);
     host lets its own bot continue.
4. `resolveAuthenticatedAccount(inbound)`; unauthenticated/`null` → `continue`
   result (`account_not_authenticated`). Resolver throw honors
   `accountResolutionFailureMode`.
5. `chatbot.processMessage({ messageId, customerId, text, sentAt, observedAt,
   channel: "chat", evidence, showChoices })`. `showChoices` is true when the
   inbound is empty text, matches `SHOW_CHOICES_TEXT_PATTERN`, or is the
   show-choices quick action.
6. Map the returned turn (see 6.3). Any `WordlessSdkError` →
   `onWordlessError` + `continue` result (`wordless_unavailable`).

### 6.3 Turn → WhatsApp send request

The adapter returns request objects (method/path/body for the Graph API
`/{phoneNumberId}/messages` endpoint); the host executes them with its own token,
exactly as Zendesk returns `ZendeskApiRequest` objects. Body shapes use
`messaging_product: "whatsapp"`.

- `grounded_reply` → `type: "text"`, `text.body = turn.message`.
- `clarification_choices` (and any `show_wordless` turn with `renderMode:
  "choices"`) → `type: "interactive"`, `interactive.type: "button"`, body text =
  `turn.message`, and up to **3** `action.buttons[]` reply buttons. Each button:
  `{ type: "reply", reply: { id: <signed payload>, title: <label> } }`.
- `clarifying_fallback → continue_host_bot` → `continue` result (no send).
- human request detected (via `detectHumanRequest`, when `humanHandoff.enabled`)
  → `handoff` result the host routes to a human.

### 6.4 WhatsApp-specific constraints (the interesting design)

- **Reply-button title ≤ 20 characters, ≤ 3 buttons.** The universal choice label
  `"I don't know what to say"` (24 chars) is replaced on this channel by
  `WHATSAPP_SHOW_CHOICES_LABEL = "Not sure what to say"` (20 chars), preserving
  meaning. If any detector choice label exceeds 20 chars, the adapter raises a
  `WhatsAppIntegrationError` rather than silently truncating (labels come from
  compiled detectors and should be authored to fit; this surfaces the constraint
  at integration time, not to the customer).
- **Button `id` ≤ 256 characters.** The signed payload is verified to fit; the
  `wl2.` core plus a 22-char signature is well under 256.
- Emojis and rich text are avoided; plain accessible text only.

### 6.5 Button-reply resolution

On a `button_reply.id` inbound: `verifySignedChoicePayload` with binding
`(phoneNumberId, waId)`; then `choiceStore.resolve(...)` one-time-consuming it
bound to the same phone number and wa_id, keyed by the inbound message id for
idempotency and rejecting after expiry. On success: return a `text` send request
carrying the choice's `reply`, and best-effort `chatbot.recordConfirmation({
suggestionId, selectedDetectorId, actor: "customer", decisionId })`. Feedback
errors go to `onFeedbackError` and never block the reply. A replayed or expired
payload resolves to `null` → `ignored`/`continue`, never a double action.

### 6.6 Result union

`WhatsAppResult = post_message | continue | handoff | ignored`, each carrying the
parsed `inbound`, a `deduplicationKey` (the inbound message id) for the host to
claim before executing, and for `post_message` the `pendingChoices` set to persist.

## 7. Slack channel (PR 2)

Same architecture; Slack-specific bindings and transport.

### 7.1 Verification & transport

- **Request signing:** `X-Slack-Signature = v0=` HMAC-SHA256 of
  `v0:{X-Slack-Request-Timestamp}:{rawBody}` with the app signing secret,
  timing-safe, with a ±5-minute timestamp window. Exposed as
  `verifySlackSignature(rawBody, headers, signingSecret, now?)`.
- **Events API URL verification:** `verifySlackUrlVerification(body)` echoes the
  `challenge` for the one-time handshake.
- **Two inbound transports**, like Zendesk's message vs. quick-reply split:
  - Events API `event_callback` with `event.type === "message"` (ignoring
    `bot_message`/edited/deleted subtypes and the app's own messages) → the
    customer utterance; `event.channel`, `event.user`, `event.ts`.
  - Interactivity `block_actions` payload (form-encoded `payload=<json>`) where a
    button was tapped → `actions[].value` is the signed choice payload.

### 7.2 Turn → Slack request

Adapter returns `chat.postMessage`-shaped request objects (channel + text +
`blocks`); the host posts them with its bot token (or via `response_url` for the
interactive reply — the example shows `response_url`). Choices render as a Block
Kit `actions` block of up to **3** `button` elements; each button
`{ text, action_id, value: <signed payload> }`. Slack button text allows ~75
chars and `value` allows ~2000, so the universal
`SLACK_SHOW_CHOICES_LABEL = "I don't know what to say"` fits unchanged and no
title-length constraint applies — the deliberate contrast with WhatsApp §6.4.
Binding context is `(teamId, channelId, userId)`. `channel` param to
`processMessage` is `"chat"`.

### 7.3 Results & handoff

`SlackResult = post_message | continue | handoff | ignored`. Human requests
(when enabled) produce a `handoff` result; passthrough produces `continue` (the
host's own bot/agent handles the message). Choice resolution and
`recordConfirmation` mirror WhatsApp §6.5 with the Slack binding and store.

## 8. Safety invariants (both channels)

- Read-only: the result unions contain no account-mutating request shape.
- At most three choices; the null-detector "not sure" choice is always present in
  a `clarification_choices` turn and is the only zero-evidence choice.
- Signed, expiring, nonce-bound, one-time choice payloads; replay and cross-
  conversation reuse are rejected by signature binding + store consumption.
- Timeouts/fallbacks: a `WordlessSdkError` from `chatbot.processMessage` always
  degrades to a safe `continue`. A `resolveAuthenticatedAccount` (resolver)
  outage propagates by default (`accountResolutionFailureMode` defaults to
  `"throw"` — fail-closed: the host webhook returns non-2xx and the platform
  retries), and only degrades to a safe `continue` when the host opts in with
  `accountResolutionFailureMode: "continue"`. Neither case is ever turned into
  a fabricated intent.
- Determinism: all time injected via `now()`; no module-scope `Date.now()`.
- Secrets (`appSecret`, signing secrets, Wordless API key) stay in the host
  process; nothing is placed in customer-visible payloads. Choice payloads carry
  only ids, a feedback code, timestamps, a nonce, and a signature.

## 9. Testing plan

`sdk/tests/channel-support.test.ts`:
- payload sign/verify round-trip; tamper rejection; wrong-binding rejection;
  expiry rejection; feedback-code consistency; `detectHumanRequest` parity cases;
  `isShowChoicesRequest` cases.

`sdk/tests/whatsapp.test.ts`:
- signature verify + reject; subscription challenge echo.
- envelope parse: text message, button_reply, delivery `statuses` ignored,
  wrong `phone_number_id` rejected, unsupported type ignored, over-limit bounds.
- each turn → correct request body (text vs interactive buttons); ≤3 buttons.
- 20-char label enforcement: show-choices uses the short label; an over-long
  detector label raises `WhatsAppIntegrationError`.
- 256-char button-id bound holds for a realistic payload.
- button-reply: valid resolve → reply + `recordConfirmation`; replay → null/ignored;
  expired → rejected; feedback error surfaced but non-blocking.
- unauthenticated → continue; Wordless error → continue + `onWordlessError`.

`sdk/tests/slack.test.ts`:
- v0 signature verify + reject; stale-timestamp rejection; URL-verification echo.
- message event parse; bot/self/edited/deleted subtype ignored.
- block_actions parse from form-encoded payload.
- turn → `chat.postMessage` blocks; ≤3 buttons; full-length show-choices label.
- choice resolution + `recordConfirmation`; replay/expiry; safe-continue paths.

All tests run under the existing `vitest run` config with no network and injected
clocks. Target: cover every result branch of both adapters.

## 10. Deliverables & verification

PR 1 (WhatsApp): `channel-support.ts`, `whatsapp.ts`, example, both new tests,
`integrations/whatsapp/README.md`, `package.json` `./whatsapp` export, and (if the
extract path in §11 is taken) the `zendesk.ts` import change.

PR 2 (Slack): `slack.ts`, example, `slack.test.ts`,
`integrations/slack/README.md`, `package.json` `./slack` export.

Verify each PR:

```sh
cd sdk
npm install
npm run typecheck
npm test
npm run build
```

Both PRs target `main` via pull request; never commit to `main` directly, never
deploy, never add real credentials or customer data (`COLLABORATING.md`).

## 11. Decision: human-request detection — extract vs duplicate

The human-handoff intent battery (~150 lines of regexes + token logic) currently
lives inside `sdk/src/zendesk.ts`. Both new channels need the same behavior.

- **Chosen: extract** into `channel-support.ts` as `detectHumanRequest(text)` and
  have `zendesk.ts` import it. One source of truth; no divergence. Risk is bounded
  because `sdk/tests/zendesk.test.ts` already exercises the battery and will catch
  any regression from the move. This is the one place we touch the existing
  audited module, and only by relocating unchanged logic behind the same tests.
- Rejected: duplicate the battery into the shared module and leave Zendesk's copy.
  Lower blast radius, but two copies drift over time — a worse long-term smell for
  audited safety logic.

If, during implementation, the extraction proves to disturb Zendesk-specific
coupling (e.g. clause-splitting that references Zendesk payload text), fall back to
exposing the detector from `zendesk.ts` via a single additive named export and
importing that from the new channels — still one source of truth, no behavior
change.

## 12. Open questions for review

1. Human handoff on these channels has no Switchboard equivalent; the adapter
   emits a `handoff` result and leaves routing to the host. Is a `handoff` result
   (vs. folding it into `continue`) the shape you want?
2. WhatsApp over-long detector labels: raise at integration time (chosen) vs.
   deterministic safe-shortening. Chosen strict-raise surfaces authoring issues
   early; confirm that is preferred over silent shortening.
3. Slack outbound: return `chat.postMessage` request objects for the host's token
   (chosen, matches Zendesk) — the interactive reply example uses `response_url`.
   Confirm we should not also ship a built-in Slack Web API client.

# Wordless for Slack

Wordless is a small, evidence-first step inside an ordinary Slack support
conversation. A customer can type any English-language message while Wordless
is active. A fragmented but supportable message is matched to current company
evidence and shown as up to three short Block Kit button choices. A customer
can also select **"I don't know what to say"** without typing. An unrelated
message continues to the host's existing bot.

This is a universal interaction preference, not a diagnosis. Do not infer
aphasia or build a disability profile from how a customer writes. Wordless
never refunds, cancels, unlocks, edits an order, or performs any other company
action — it only confirms what the customer likely means and hands that
confirmed intent back to the host. Every choice payload is a signed, one-time
token; evidence loaded for a reply is read-only and point-in-time.

## Supported Slack surface

The adapter targets the **Events API** for inbound messages and Slack's
**interactivity** (`block_actions`) transport for button selections. It does
not implement Slash Commands, Modals/Views, the legacy Interactive Messages
verification token, or the Socket Mode connection — a host wires both HTTP
endpoints behind its own Slack app configuration.

The implementation follows Slack's current primary documentation for the
concepts it uses:

- [Verifying requests from Slack](https://api.slack.com/authentication/verifying-requests-from-slack)
- [Events API](https://api.slack.com/apis/events-api)
- [Handling user interactivity (`block_actions`)](https://api.slack.com/interactivity/handling)
- [`chat.postMessage`](https://api.slack.com/methods/chat.postMessage)

The server-only exports are:

```ts
import {
  createSlackAdapter,
  verifySlackSignature,
  verifySlackUrlVerification,
  parseSlackMessageEvent,
  parseSlackBlockActions,
  buildSlackPostMessage,
  SLACK_SHOW_CHOICES_LABEL,
  SlackIntegrationError,
  SlackWebhookValidationError,
  type SlackAuthenticatedAccount,
  type SlackChoiceStore,
  type SlackInboundMessage,
} from "@wordless/sdk/slack";
```

## Request signing and the URL-verification handshake

Every Slack request — both the Events API callback and an interactivity
submission — carries `X-Slack-Signature` and `X-Slack-Request-Timestamp`
headers. `verifySlackSignature()` recomputes the signature as
`"v0=" + HMAC-SHA256("v0:" + timestamp + ":" + rawBody, signingSecret)` and
compares it to the header in constant time. It also rejects the request if
the timestamp is more than **five minutes** old or in the future, which is
Slack's documented replay-protection window. This check must run against the
untouched raw body, before any JSON parsing; `createSlackAdapter()` performs
it internally as the first step of both `processEvent()` and
`processInteraction()`.

The first time an Events API request URL is configured (or reconfigured),
Slack sends a `url_verification` payload instead of a real event.
`verifySlackUrlVerification()` recognizes that payload and returns its
`challenge` string; `processEvent()` surfaces this as
`{ kind: "url_verification", challenge }` so the host can echo it straight
back with a 200 response — no signature bypass, since the request still has
to pass `verifySlackSignature()` first.

## Two transports, one signing secret

```text
POST /slack/events         -> adapter.processEvent(rawBody, headers)
POST /slack/interactions   -> adapter.processInteraction(rawBody, headers)
```

Both endpoints are verified with the same Slack app **signing secret**
(`signingSecret`). `processEvent()` expects the raw JSON body;
`processInteraction()` expects the standard
`application/x-www-form-urlencoded` body Slack sends for interactivity, with
the actual payload JSON in the `payload` form field — `createSlackAdapter()`
parses that field internally after verifying the signature.

## Avoiding the self-reply loop

`parseSlackMessageEvent()` ignores any event carrying `bot_id` or a `subtype`
(edits, joins, etc.), and it also drops any message whose `user` matches the
configured `selfBotUserId`. A host must pass the bot's own Slack user id here
— without it, Wordless's own `chat.postMessage` replies would arrive back as
inbound Events API messages and the bot would talk to itself.

## Block Kit buttons: at most three, evidence-only fallback

`buildSlackPostMessage()` renders a Wordless clarification turn as a
`section` block plus one `actions` block of `button` elements, and enforces
the same platform-shaped limits WhatsApp enforces for reply buttons, adapted
to Slack's actual limits:

- **At most three buttons.** More than three throws `SlackIntegrationError`.
- **Button text is capped at 75 characters** (Slack's `plain_text` limit for
  a button); a longer label throws.
- **The button `value` (the signed choice payload) is capped at 2,000
  characters** — Slack's documented limit for an action value.

Unlike WhatsApp, Slack's button text budget is generous enough that Wordless
does not need to shorten its fallback option. The button shown when a choice
has no matching detector carries the **full, unabbreviated**
`SLACK_SHOW_CHOICES_LABEL`:

```ts
export const SLACK_SHOW_CHOICES_LABEL = "I don't know what to say";
```

This is the complete sentence used elsewhere in the SDK (e.g. Zendesk); it is
*not* shortened to fit a character budget the way WhatsApp's
`WHATSAPP_SHOW_CHOICES_LABEL` ("Not sure what to say") is. It is exported so
a host can render the identical label anywhere else in its own UI.

## Signed, one-time button payloads

A Slack `block_actions` button's `value` is the only data that comes back on
selection. The SDK encodes the chosen suggestion, choice, and detector into
that value as an HMAC-signed, expiring payload (shared with the other
Wordless channels via `channel-support.ts`), bound to the Slack `team`,
`channel`, and `user` ids so a payload cannot be replayed into a different
conversation. `buildSlackPostMessage()` produces the payload and returns a
`SlackPendingChoiceSet` alongside the outbound request; save it before
sending:

```ts
const { request, pendingChoices } = buildSlackPostMessage(
  inbound, turn, choiceSigningSecret, nonce, issuedAtSeconds, expiresAtSeconds,
);
if (pendingChoices !== null) await choiceStore.save(pendingChoices);
await postToSlack(request);
```

A durable `SlackChoiceStore` is mandatory. Its `resolve()` must be atomic:

- consume an unexpired payload for the first button-tap action timestamp
  (`action_ts`);
- return that same resolved choice for a retry of the same `action_ts`; and
- return `null` when a different `action_ts` replays an already-consumed
  payload.

An in-memory map is not safe in a multi-worker or restarting service — use a
database transaction or compare-and-set. The default choice lifetime is 30
minutes and configurable up to a 24-hour maximum via `choiceTtlMs`.

## `resolveAuthenticatedAccount` contract

```ts
resolveAuthenticatedAccount(inbound: SlackInboundMessage): Promise<SlackAuthenticatedAccount | null>
```

This is the one function every host must write, and it carries the same
discipline as every other Wordless channel:

- **Never treat a Slack `user` id as the account id.** It is a
  workspace-scoped Slack identifier, not a verified company account. Map it
  through the host's own authenticated customer/account link (e.g. a Slack
  user previously linked to a company account out-of-band) before returning
  anything. Return `null` when there is no such link — Wordless then leaves
  the message to the host's normal bot rather than guessing.
- **Load point-in-time, read-only evidence at or before the message time.**
  `observedAt` and every item in `evidence` must reflect state as of the
  inbound message's timestamp or earlier. Do not return evidence computed
  after the message arrived, and do not return evidence that could change as
  a side effect of answering (Wordless is read-only end to end).
- Resolution runs on every inbound text message before Wordless is
  consulted; keep it fast and side-effect-free. A thrown error is treated as
  a hard failure by default (`accountResolutionFailureMode: "throw"`); set it
  to `"continue"` to fall back to the host bot instead, and observe failures
  via `onAccountResolutionError`.

## Runtime message flow

```text
inbound Slack event (message, not from selfBotUserId, no bot_id/subtype)
              |
              +-- explicit "talk to a person" request (humanHandoff.enabled) --> handoff
              |
              v
resolveAuthenticatedAccount() -> verified company account -> read-only evidence
              |
              v
Wordless concept/evidence pass
    | clear match      | unclear fragment       | unrelated
    v                  v                        v
signed Block Kit      "I don't know what to      continue_host_bot
buttons (<= 3)        say" + evidence-only
                       choices
```

`processEvent()` returns `{ kind: "ignored" }` for anything that is not a
verified user message (bot echoes, message edits, unrelated event types), or
`{ kind: "result", result }` where `result` is one `SlackResult`:
`post_message` (send `result.request` to `chat.postMessage`, save
`result.pendingChoices` if non-null), `continue` (let the host's own bot
answer), or `handoff` (route to a human inbox). `processInteraction()`
returns a `SlackResult` directly for a `block_actions` payload, or
`{ kind: "ignored", reason: "not_a_button_action" }` for anything else. Each
result carries a `deduplicationKey` (the message `ts` for events, the button
`action_ts` for interactions); claim it in a durable inbox/outbox before
sending, since Slack retries both Events API deliveries and, in some
failure modes, interactivity submissions.

## Example and validation

[`slack-events-handler.ts`](../../examples/slack-events-handler.ts) is a
framework-neutral example showing the URL-verification handshake,
signature-verified event and interaction handling, and the result-kind
switch a host implements around `createSlackAdapter()`.

```sh
cd sdk
npm test -- --run tests/slack.test.ts tests/channel-support.test.ts
npm run typecheck
npm run build
```

# Wordless for WhatsApp Cloud API

Wordless is a small, evidence-first step inside an ordinary WhatsApp Business
support conversation. A customer can type any English-language message while
Wordless is active. A fragmented but supportable message is matched to current
company evidence and shown as up to three short reply-button choices. A
customer can also select **"Not sure what to say"** without typing. An
unrelated message continues to the host's existing bot.

This is a universal interaction preference, not a diagnosis. Do not infer
aphasia or build a disability profile from how a customer writes. Wordless
never refunds, cancels, unlocks, edits an order, or performs any other company
action — it only confirms what the customer likely means and hands that
confirmed intent back to the host.

## Supported WhatsApp surface

The adapter targets the **WhatsApp Business Platform Cloud API** — a single
phone number id, one webhook subscription, and the standard `text` and
`interactive` (reply button) message types. It does not implement WhatsApp
Business flows, templates, catalogs, or the On-Premises API.

The implementation follows Meta's current primary documentation for the
concepts it uses:

- [Cloud API overview](https://developers.facebook.com/docs/whatsapp/cloud-api/overview)
- [Webhooks setup and payloads](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks)
- [Webhook security (`X-Hub-Signature-256`)](https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-the-request)
- [Interactive reply-button messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages)
- [Sending messages](https://developers.facebook.com/docs/whatsapp/cloud-api/messages)

The server-only exports are:

```ts
import {
  createWhatsAppCloudAdapter,
  verifyWhatsAppSignature,
  verifyWhatsAppSubscription,
  parseWhatsAppEnvelope,
  buildWhatsAppSendRequest,
  WHATSAPP_SHOW_CHOICES_LABEL,
  WhatsAppIntegrationError,
  WhatsAppWebhookValidationError,
  type WhatsAppAuthenticatedAccount,
  type WhatsAppChoiceStore,
  type WhatsAppInboundMessage,
} from "@wordless/sdk/whatsapp";
```

## Webhook subscription and delivery verification

Meta verifies a new webhook URL with a `GET` handshake — `hub.mode`,
`hub.verify_token`, and `hub.challenge` — before it will deliver anything.
`verifyWhatsAppSubscription()` checks the mode and compares the verify token
in constant time, then returns the challenge string to echo back:

```ts
app.get("/webhooks/whatsapp", (req, res) => {
  const challenge = verifyWhatsAppSubscription(
    { mode: req.query["hub.mode"], token: req.query["hub.verify_token"], challenge: req.query["hub.challenge"] },
    process.env.WHATSAPP_VERIFY_TOKEN!,
  );
  res.status(200).send(challenge);
});
```

Every subsequent delivery is a `POST` carrying an `X-Hub-Signature-256` header
— an HMAC-SHA256 of the exact raw request body, keyed with the app secret.
`verifyWhatsAppSignature()` must run against the untouched raw body, before any
JSON parsing, and it compares in constant time. `createWhatsAppCloudAdapter()`
performs this check internally as the first step of `processWebhook()`; pass it
the raw body string and the header value exactly as received, not a
re-serialized object.

## The 3-button / 20-character constraint

WhatsApp interactive reply-button messages allow at most **three** buttons, and
each button title is capped at **20 characters**. `buildWhatsAppSendRequest()`
enforces both: it throws `WhatsAppIntegrationError` if Wordless would offer
more than three choices, and again if any choice label exceeds 20 characters.
Keep detector-authored choice labels short by design — this is a hard platform
limit, not a soft one the SDK works around.

The "I don't know what to say" option that Zendesk and other channels show as
a longer sentence becomes the fixed, pre-shortened button title
`WHATSAPP_SHOW_CHOICES_LABEL` ("Not sure what to say") on WhatsApp, so it fits
the 20-character budget. It is exported so a host can render the same label
consistently anywhere else in its UI (e.g. an agent-facing transcript view).

## Signed, one-time reply-button payloads

A WhatsApp reply button's `id` is the only data that comes back on selection —
there is no separate session or state token. The SDK encodes the chosen
suggestion, choice, and detector into that `id` as an HMAC-signed, expiring
payload (shared with the other Wordless channels via `channel-support.ts`),
bound to the phone number id and the customer's `wa_id` so a payload cannot be
replayed against a different conversation. `buildWhatsAppSendRequest()`
produces the payload and returns a `WhatsAppPendingChoiceSet` alongside the
outbound request; save it before sending:

```ts
const { request, pendingChoices } = buildWhatsAppSendRequest(
  inbound, turn, choiceSigningSecret, nonce, issuedAtSeconds, expiresAtSeconds,
);
if (pendingChoices !== null) await choiceStore.save(pendingChoices);
await sendToWhatsApp(request);
```

A durable `WhatsAppChoiceStore` is mandatory. Its `resolve()` must be atomic:

- consume an unexpired payload for the first button-tap message id;
- return that same resolved choice for a retry of the same message id; and
- return `null` when a different message id replays an already-consumed
  payload.

An in-memory map is not safe in a multi-worker or restarting service — use a
database transaction or compare-and-set. The default choice lifetime is 30
minutes and configurable up to a 24-hour maximum via `choiceTtlMs`.

## `resolveAuthenticatedAccount` contract

```ts
resolveAuthenticatedAccount(inbound: WhatsAppInboundMessage): Promise<WhatsAppAuthenticatedAccount | null>
```

This is the one function every host must write, and it carries the same
discipline as every other Wordless channel:

- **Never treat `wa_id` as the account id.** `wa_id` is a WhatsApp-supplied
  phone-number identifier, not a verified company account. Map it through the
  host's own authenticated customer/account link (e.g. a phone number already
  on file and previously verified out-of-band) before returning anything.
  Return `null` when there is no such link — Wordless then leaves the message
  to the host's normal bot rather than guessing.
- **Load point-in-time, read-only evidence at or before the message time.**
  `observedAt` and every item in `evidence` must reflect state as of
  `inbound.receivedAt` or earlier. Do not return evidence computed after the
  message arrived, and do not return evidence that could change as a side
  effect of answering (Wordless is read-only end to end).
- Resolution runs on every inbound text message before Wordless is consulted;
  keep it fast and side-effect-free. A thrown error is treated as a hard
  failure by default (`accountResolutionFailureMode: "throw"`); set it to
  `"continue"` to fall back to the host bot instead, and observe failures via
  `onAccountResolutionError`.

## Runtime message flow

```text
inbound WhatsApp message (text or button_reply, active phone_number_id)
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
signed reply buttons  "Not sure what to say" +  continue_host_bot
(<= 3, <= 20 chars)   evidence-only choices
```

`processWebhook()` returns one `WhatsAppResult` per parsed message:
`post_message` (send `result.request`, save `result.pendingChoices` if
non-null), `continue` (let the host's own bot answer), `handoff` (route to a
human inbox), or `ignored` (status callback, unsupported message type, or a
delivery for a different `phone_number_id` — no-op). Each result carries a
`deduplicationKey` (the WhatsApp message id); claim it in a durable
inbox/outbox before sending, since Meta retries webhook deliveries and a retry
must never produce a duplicate customer message.

## Example and validation

[`whatsapp-cloud-handler.ts`](../../examples/whatsapp-cloud-handler.ts) is a
framework-neutral example showing the subscription handshake, signature-verified
webhook handling, and the result-kind switch a host implements around
`createWhatsAppCloudAdapter()`.

```sh
cd sdk
npm test -- --run tests/whatsapp.test.ts tests/channel-support.test.ts
npm run typecheck
npm run build
```

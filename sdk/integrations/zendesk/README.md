# Wordless for Zendesk Messaging

Wordless is a small, evidence-first step inside an ordinary Zendesk support
journey. In version 1, customers can type any English-language message while
Wordless is active. A fragmented but supportable message is matched to current
company evidence and shown as short confirmation choices. A customer can also
select **I don't know what to say** without typing. An unrelated message
continues to the existing bot. When the adapter is configured with the Agent
Workspace Switchboard entry id, an explicit request for a human bypasses
inference and passes control directly to that entry; otherwise it follows the
normal configured `next` route.

This is a universal interaction preference. Do not diagnose aphasia or build a
disability profile from how a customer writes. The host must verify the
authenticated Zendesk user's locale before resolving account evidence. A
missing or non-English locale must yield to the normal bot without an evidence
lookup. The dedicated production pilot has no missing-locale exception.

## Supported Zendesk surface

Use a Sunshine Conversations **v2 custom integration** for one controlled
customer, or a **Marketplace bot OAuth integration** for a product installed by
many customers. Do not build a new product on Zendesk's legacy Chat
Conversations API.

The implementation follows Zendesk's current primary documentation:

- [Building a Marketplace bot](https://developer.zendesk.com/documentation/conversations/how-to-guides/building-a-marketplace-bot/)
- [Receiving messages](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/receiving-messages/)
- [Switchboard](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/switchboard/)
- [Structured messages](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/structured-messages/)
- [API authentication](https://developer.zendesk.com/documentation/conversations/getting-started/api-authentication/)
- [Sunshine Conversations v2 OpenAPI](https://docs.smooch.io/sunco-openapi/openapi.yaml)

The server-only exports are split by responsibility:

```ts
import {
  createZendeskCompositionHelpMessage,
  createZendeskControlReleasePlan,
  createZendeskConversationsClient,
  createZendeskMessagingAdapter,
  createZendeskPassControlRequest,
  createZendeskReleaseControlRequest,
} from "@wordless/sdk/zendesk";

import {
  createZendeskMarketplaceAuthorizationUrl,
  discoverZendeskMarketplaceIntegrationReference,
  exchangeZendeskMarketplaceCode,
  generateZendeskMarketplaceOAuthState,
  getZendeskMarketplaceTokenInfo,
  handleZendeskMarketplaceLifecycleEvent,
  parseZendeskMarketplaceLifecycleWebhook,
  parseZendeskMarketplaceOAuthCallback,
  registerZendeskMarketplaceWebhook,
  verifyZendeskMarketplaceUninstall,
  verifyZendeskWebhookApiKey,
} from "@wordless/sdk/zendesk-marketplace";
```

## Marketplace installation

A distributed bot must complete Zendesk Technology Partner and Marketplace
onboarding. Zendesk issues the Marketplace `client_id` and `client_secret`; the
SDK cannot create them. Marketplace bots must use the OAuth bridge and must not
ask a customer for Sunshine Conversations API credentials.

Every OAuth and Conversations request must include the Zendesk-issued
Marketplace name, organization id, and bot id. The SDK adds these headers.

1. Generate state, store it in a short-lived server session, and redirect the
   installer:

   ```ts
   const state = generateZendeskMarketplaceOAuthState();
   await oauthStates.put(sessionId, state, { singleUse: true, ttlSeconds: 600 });

   const url = createZendeskMarketplaceAuthorizationUrl({
     clientId: process.env.ZENDESK_MARKETPLACE_CLIENT_ID!,
     state,
     redirectUri: "https://app.example.com/integrations/zendesk/callback",
   });
   ```

2. On callback, load the expected state from that same server session, verify
   it, delete it, and exchange the one-time code:

   ```ts
   const { code } = parseZendeskMarketplaceOAuthCallback(request.url, {
     expectedState: await oauthStates.get(sessionId),
   });
   await oauthStates.consume(sessionId);

   const token = await exchangeZendeskMarketplaceCode({
     code,
     clientId: process.env.ZENDESK_MARKETPLACE_CLIENT_ID!,
     clientSecret: process.env.ZENDESK_MARKETPLACE_CLIENT_SECRET!,
     marketplace,
   });
   const installation = await getZendeskMarketplaceTokenInfo({
     accessToken: token.accessToken,
     marketplace,
   });
   ```

3. Register one integration-scoped webhook:

   ```ts
   const webhook = await registerZendeskMarketplaceWebhook({
     accessToken: token.accessToken,
     marketplace,
     appId: installation.appId,
     subdomain: installation.subdomain,
     target: "https://app.example.com/webhooks/zendesk",
   });
   ```

   It subscribes to `conversation:message`, `conversation:create`,
   `conversation:referral`, `switchboard:passControl`, and
   `switchboard:releaseControl`. OAuth integrations can create at most three
   webhooks, so one combined subscription is the intended default.

The SDK returns tokens and webhook secrets to the caller but never persists or
logs them. Store the installation token and `webhook.secret` encrypted in the
host's secret store. Store app id, subdomain, webhook id, the two integration
ids, and installation status in a tenant-isolated installation record.

## The two integration ids are not interchangeable

Zendesk's `conversation.activeSwitchboardIntegration` contains two identifiers:

| Field | Meaning | Wordless use |
|---|---|---|
| `.id` | Switchboard integration entry id | Decide whether Wordless currently controls the conversation; pass as `switchboardIntegrationId`. |
| `.integrationId` | Underlying Conversations integration id | Bind the OAuth installation and uninstall callback; pass as `underlyingIntegrationId`/`integrationId`. |

Do not substitute app id, Marketplace bot id, or one of these values for the
other. `tokenInfo` documents app id and subdomain; it does not provide a safe
substitute for both Switchboard identifiers. Zendesk documents that a
Marketplace bot's active `integrationType` contains its issued OAuth
`client_id`. After verifying `X-API-Key` and the app/webhook envelope, bootstrap
the first active event and persist both observed ids:

```ts
const reference = discoverZendeskMarketplaceIntegrationReference(body, {
  expectedAppId: install.appId,
  expectedWebhookId: install.webhookId,
  marketplaceClientId: process.env.ZENDESK_MARKETPLACE_CLIENT_ID!,
});
```

If `reference` is null, this bot is not active and must not reply. Do not guess;
wait for a verified event where the issued client id identifies the bot. Once
persisted, use the exact `.id` and `.integrationId` checks below. The issued
client id and callback registration are details completed during Zendesk partner
onboarding.

The message adapter can enforce both values:

```ts
const adapter = createZendeskMessagingAdapter({
  chatbot,
  expectedAppId: install.appId,
  expectedWebhookId: install.webhookId,
  switchboardIntegrationId: install.switchboardIntegrationId, // `.id`
  underlyingIntegrationId: install.integrationId,             // `.integrationId`
  humanSwitchboardIntegrationId: install.humanSwitchboardIntegrationId, // Agent Workspace `.id`
  choiceSigningSecret: process.env.WORDLESS_CHOICE_SECRET!,
  choiceStore,
  resolveAuthenticatedAccount,
});
```

Wordless replies only when both configured Wordless identifiers match the active
integration. `humanSwitchboardIntegrationId` is the separate Agent Workspace
Switchboard entry `.id`; do not substitute the Wordless entry or an underlying
`.integrationId`.

## Webhook authentication and lifecycle

Zendesk creates a shared secret for every Sunshine Conversations webhook and
sends it in `X-API-Key`. Verify it before parsing or acting on the body:

```ts
if (!verifyZendeskWebhookApiKey(request.headers, install.webhookSecret)) {
  return new Response(null, { status: 401 });
}
```

Then validate the envelope app id, webhook id, v2 version, event id, author, and
active integration. A Marketplace lifecycle handler can use the same envelope:

```ts
const events = parseZendeskMarketplaceLifecycleWebhook(body, {
  expectedAppId: install.appId,
  expectedWebhookId: install.webhookId,
  switchboardIntegrationId: install.switchboardIntegrationId,
  integrationId: install.integrationId,
});

for (const event of events) {
  await inbox.claim(event.eventId, async () => {
    await handleZendeskMarketplaceLifecycleEvent(event, {
      scheduleRelease: (plan) => releaseJobs.persistEarliest(plan),
      greet: () => sendGreeting(),
      awaitMessage: () => undefined,
      inspectProactiveCampaign: () => inspectCampaignBeforeReplying(),
      cleanup: () => conversationState.remove(event.conversationId),
    });
  });
}
```

The lifecycle planner applies Zendesk's creation reasons:

- `startConversation`: greet only while Wordless is active.
- `message`: wait for the corresponding `conversation:message`; do not send a
  duplicate greeting.
- `proactiveMessaging`: inspect the campaign before deciding what to send.
- `linkRequest`, `notification`, and `none`: do not greet.
- `conversation:referral` or a pass into Wordless: a greeting is allowed while
  active.
- a pass away from Wordless or `releaseControl`: clean up local state.

When Wordless acquires control, the parser includes a `releasePlan`. Persist the
earliest deadline for that conversation; never replace an earlier deadline with
a later webhook. Release immediately when the interaction is resolved or idle,
and no later than 24 hours:

```ts
await zendesk.execute(createZendeskReleaseControlRequest({
  appId: install.appId,
  conversationId,
  metadata: { reason: "resolved" },
}));
```

## Safe pass-control semantics

`passControl({ switchboardIntegration: "next" })` is idempotent only with
integration-scoped authentication. With app-scoped authentication, a retry can
advance through multiple integrations. The SDK therefore fails closed unless
credential scope is explicitly `"integration"` (Marketplace OAuth tokens are
known to be integration-scoped).

Use `createZendeskPassControlRequest()` for new code. It permits `mode: "next"`
only with integration scope. App-scoped credentials must target an explicit
Switchboard integration id. Do not retry a pass/release operation outside the
durable inbox/outbox that owns its event.

## Runtime message flow

```text
conversation:message (user-authored, Wordless active)
              |
              +-- explicit human/person/agent request --> passControl safely
              |
              v
verified Zendesk user -> verified company account -> read-only evidence
              |
              v
Wordless concept/evidence pass
    | clear match      | unclear fragment       | unrelated
    v                  v                        v
native choices     evidence-only choices    existing bot/agent
```

Every choice is a native Zendesk reply action with `blockChatInput: false`, so
typing remains available. Choice payloads are HMAC-signed, bound to app,
conversation, user, a random source-message nonce, issue time, and expiry. A
durable `ZendeskChoiceStore` is mandatory. Its atomic `resolve()` must:

- consume an unexpired payload for the first selection event id;
- return that same result for a retry of the same event id; and
- return `null` when a different event id replays the consumed payload.

Use a database transaction or compare-and-set. An in-memory map is not safe in
a multi-worker or restarting service.

`resolveAuthenticatedAccount()` must resolve an authenticated Zendesk user to a
verified company account and load current read-only evidence. Never trust a
display name, email in message text, or caller-supplied account id. Wordless
does not refund, cancel, unlock, edit a ticket, or perform any other company
action.

## Delivery and crash recovery

Zendesk retries webhook deliveries. Atomically claim each event id and persist
the exact outbound operation in a durable outbox before executing it. Wordless
message requests also include deterministic root metadata:

```json
{ "wordless_delivery_key": "the-zendesk-event-id" }
```

If a process crashes after Zendesk accepts a message but before the outbox marks
it complete, list/reconcile recent conversation messages by this key before
retrying. This reduces duplicates but is not a documented API-level idempotency
guarantee. If metadata cannot be listed reliably for a channel or reconciliation
fails, delivery remains at-least-once and a duplicate customer message is a
residual risk; monitor and surface that state instead of claiming exactly-once.

## Uninstall verification

The Zendesk Marketplace uninstall callback contains `{ appId, integrationId }`
but has no request authentication. Do not delete an installation merely because
those fields arrived. `verifyZendeskMarketplaceUninstall()` first matches both
stored ids, then calls `tokenInfo`. It returns verified only when Zendesk rejects
the stored token with 401/403, confirming revocation. A valid token, timeout,
rate limit, or 5xx response is not proof of uninstall and must not delete secrets
or tenant state.

## Example and validation

[`zendesk-messaging-handler.ts`](../../examples/zendesk-messaging-handler.ts) is
a framework-neutral HTTPS handler showing X-API-Key verification, exact
installation binding, an integration-scoped client, and durable inbox/outbox
hooks.

```sh
cd /Users/ak/Desktop/Wordless/sdk
npm test -- --run tests/zendesk.test.ts tests/zendesk-marketplace.test.ts
npm run typecheck
npm run build
```

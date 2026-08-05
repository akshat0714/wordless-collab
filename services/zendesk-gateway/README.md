# Wordless Zendesk gateway

This service is the durable, multi-tenant Zendesk Conversations host for Wordless. It accepts authenticated webhooks immediately, validates each event with the SDK's canonical parser, resolves an authenticated customer account, asks Wordless for grounded composition help, and delivers exact Zendesk API operations through a transactional outbox.

The customer UI stays native and small: free typing is always enabled, the greeting offers **I don't know what to say** and **Talk to a person**, unclear text can become evidence-grounded choices, unrelated text passes to the normal bot, and explicit human requests pass directly to the configured Agent Workspace Switchboard entry without an evidence call.

## Supported topology

For the standalone gateway, configure Wordless as the default/front-door responder with `deliverStandbyEvents=false`, followed by the company's normal bot. The normal bot must release or pass control when its flow ends. Once Wordless passes control, it does not see every later message in that bot's active flow. A true every-message layer requires the server SDK embedded in the host bot before the host produces its reply.

Do not let an inactive Wordless integration acquire control based on inferred unclear text. Mid-flow re-entry requires a cooperative host-bot bridge that recognizes the exact `wordless:show_choices:v1` payload and directly passes control to the configured Wordless Switchboard entry.

## Run locally

From the repository root:

```bash
npm ci --prefix sdk
npm run build --prefix sdk
npm ci --prefix services/zendesk-gateway
npm run build --prefix services/zendesk-gateway
DATABASE_URL_FILE=/absolute/path/to/database_url npm run migrate --prefix services/zendesk-gateway
```

Copy `installations.example.json` outside the repository, replace every placeholder with Zendesk-issued identifiers, and set the environment shown in `.env.example`. Secret references resolve from either `REF` or `REF_FILE`, never from installation JSON.

Start the built service:

```bash
npm run start --prefix services/zendesk-gateway
```

For TypeScript watch mode:

```bash
npm run dev --prefix services/zendesk-gateway
```

The webhook target is:

```text
POST https://YOUR_PUBLIC_HOST/v1/webhooks/zendesk/INSTALLATION_ID
```

Zendesk Marketplace API-key authentication uses `X-API-Key`. `path_bearer` is available for a direct custom integration, and `hmac_sha256` is available behind a trusted signing edge. `GET /health/live` is process liveness and `GET /health/ready` verifies the store and configured secrets.

## Production invariants

- PostgreSQL and real Zendesk delivery are mandatory in production.
- The webhook POST only authenticates, bounds, parses JSON, and durably stores the inbox row before returning `202`. Inference runs asynchronously.
- The SDK parser caps a webhook at 100 events. Processing is limited to eight conversations and events in one conversation are serialized.
- Customer and lifecycle watermarks prevent an older in-flight event from cancelling or replacing newer work.
- A safety release is persisted before inference. The pilot uses a one-hour control/choice deadline; configuration is capped at 23 hours so it can never consume Zendesk's full 24-hour maximum.
- Outbound calls are ordered per conversation. A due, current, fenced release can bypass an ambiguous ordinary message so Wordless does not retain control indefinitely.
- An uncertain outbound result creates a durable conversation quarantine. Ordinary successors cannot send until an operator reconciles it; a fenced control release remains eligible.
- Production is English-only for this evaluated release: `SUPPORTED_LOCALE_PREFIXES=en` and `REQUIRE_KNOWN_LOCALE=true`. Explicit non-English or missing locales pass to the host bot without calling the company evidence resolver or Wordless.
- `RETENTION_DAYS` is 1–90 days for terminal inbox/outbox records and completed event claims. Raw inbox payloads are cleared immediately when processing completes or becomes terminal; pending/retry/leased safety work is preserved. Quarantine markers contain only bounded correlation fields and a reason, not the message body, and can outlive payload cleanup until an operator reconciles them.

Place a real WAF/load balancer in front of the service with connection, request-rate, and body limits. The Node and reverse-proxy timeouts are defense in depth, not a volumetric denial-of-service boundary.

## Evidence resolver contract

The gateway first reads Zendesk's authenticated user and its `profile.locale`. It calls the company resolver only for an authenticated, supported-locale identity. The request is HMAC-authenticated and binds:

```json
{
  "schema_version": 1,
  "installation_id": "acme",
  "zendesk_app_id": "app-id",
  "zendesk_identity": { "type": "external_id", "value": "company-link-id" },
  "zendesk_conversation_id": "conversation-id",
  "zendesk_message_id": "message-id",
  "message_received_at": "2026-07-30T20:00:00.000Z"
}
```

An authenticated response must echo `installation_id` and `zendesk_identity`, supply a stable `customer_id`, a timezone-aware `observed_at`, and at most 100 read-only evidence items. A false/404 response safely passes control onward.

## Quarantine operations

First inspect metadata only; this command never prints the stored request body or database credential. The marker retains `operationKind`, `eventKey`, `guardEventId`, and the applicable whitelisted Zendesk correlation fields even after payload cleanup:

```bash
DATABASE_URL_FILE=/run/secrets/database_url npm run quarantine --prefix services/zendesk-gateway -- list --installation acme --conversation CONVERSATION_ID
```

Use the operation-specific fields when comparing Zendesk conversation history:

- `post_message`: correlate `zendeskDeliveryKey` with the message metadata, then compare `eventKey` and `guardEventId` with the source webhook.
- `pass_control`: verify the Switchboard transition around `zendeskFirstMessageId` and `handoffReason`.
- `release_control`: verify the ownership transition using `zendeskReleaseKey` and `guardEventId`.

If an operation-specific field is null (including a historical marker created before migration 003), treat the outcome as unknown and investigate in Zendesk. Never approve a retry from the outbox UUID alone; it is gateway-internal and is not sent to Zendesk.

If the operation is present in Zendesk:

```bash
DATABASE_URL_FILE=/run/secrets/database_url npm run quarantine --prefix services/zendesk-gateway -- resolve --installation acme --conversation CONVERSATION_ID --outbox OUTBOX_UUID --resolution delivered --confirmation verified-delivered
```

Only after proving the operation is absent may an operator grant one send attempt:

```bash
DATABASE_URL_FILE=/run/secrets/database_url npm run quarantine --prefix services/zendesk-gateway -- resolve --installation acme --conversation CONVERSATION_ID --outbox OUTBOX_UUID --resolution retry --confirmation verified-absent-safe-to-retry
```

The one-shot grant is consumed atomically even when the automatic attempt budget was already exhausted. Never use `retry` when Zendesk history is inconclusive.

To purge all retained state for an uninstalled tenant, call the database function `wordless_gateway_purge_installation` through the controlled uninstall workflow; do not delete individual tables manually.

## Verification

```bash
npm run typecheck --prefix services/zendesk-gateway
npm test --prefix services/zendesk-gateway
TEST_DATABASE_URL=postgresql://... npm test --prefix services/zendesk-gateway -- tests/postgres.integration.test.ts
```

Build the production image from the repository root so the private SDK is included:

```bash
docker build -f services/zendesk-gateway/Dockerfile -t wordless-zendesk-gateway:local .
```

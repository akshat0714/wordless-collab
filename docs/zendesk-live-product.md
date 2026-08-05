# Wordless for Zendesk: live product boundary

Wordless is deployable as a dedicated, customer-facing Zendesk Messaging pilot.
The standalone Switchboard gateway evaluates English-language customer messages
while Wordless is the active integration, assists only configured
evidence-backed use cases, and hands everything else to the company's existing
bot or Agent Workspace. Embedding the server SDK in that active bot is the mode
that can evaluate every English-language turn. The first supported evidence
families are duplicate charges, late deliveries, wrong items, and locked
accounts.

This is a commercial integration boundary, not a diagnosis or medical product.
The **I don't know what to say** control is available to every customer. Wordless
does not infer or persist disability status and never refunds, cancels, unlocks,
or changes an account.

## Live request path

```text
Zendesk Messaging user
  -> authenticated Conversations webhook
  -> durable tenant/event inbox (fast 202 acknowledgement)
  -> active Switchboard + authenticated-user verification
  -> customer evidence resolver (read only)
  -> signed Wordless /v1/chat/assist request
  -> durable choice state + outbox
  -> active-control recheck
  -> native Zendesk choices, normal-bot handoff, human handoff, or releaseControl
```

The gateway owns retries and de-duplication. A webhook retry cannot create a
second inference or feedback decision. Choices are signed, expire, are bound to
the installation/conversation/user/source message, and can be consumed once;
the same Zendesk selection event may be replayed safely. Outbound operations are
sent only while the Wordless integration still controls the conversation.

Production startup requires the explicit `customer_clarify` product mode. In
that mode Wordless may show a low-risk clarification prompt or read-only status
message. The customer's choice is confirmation; it is not authorization for an
account change. An explicit request for a person bypasses inference.

## Authenticated evidence boundary

The gateway must verify the Zendesk user as authenticated before calling the
company evidence resolver. It uses a stable authenticated `externalId` when
available, or the verified Zendesk user id as an explicitly typed fallback. It
never maps an account from a display name, email in a message, or caller-supplied
account id.

Version 1 is English-only. The dedicated gateway reads the authenticated
Zendesk user's `profile.locale` and accepts only the `en` locale prefix. A
missing or non-English locale yields to the normal bot without calling the
customer evidence resolver or Wordless. The dedicated production pilot has no
missing-locale exception.

The company resolver receives a bounded, HMAC-authenticated request containing
the installation, verified identity-key type/value, conversation, message, and
message time. A successful response must echo the installation and identity
binding, include the evidence snapshot time, and return only supported read-only
facts. Anonymous users yield immediately to the normal support flow and cause no
evidence lookup.

## Zendesk installation modes

### Dedicated paid pilot

Use a Sunshine Conversations v2 custom integration with a dedicated,
integration-scoped API key, a v2 webhook, and a tested Switchboard route. Keep
the Wordless API private on the deployment network; expose only the HTTPS
gateway. This mode is suitable for one contracted company after its sandbox
acceptance tests and threshold review pass.

The standalone Switchboard gateway is an accessible front door, not a passive
per-message observer. Wordless must be the default responder for the relevant
channel; its `next` target is the normal bot, and that bot must release control
when its flow is resolved. While Wordless is on standby, Zendesk does not send
it customer message events when `deliverStandbyEvents` is false. A host bot
that wants a mid-flow Wordless button must recognize
`wordless:show_choices:v1` and pass control directly back to the Wordless
Switchboard entry. True every-message coverage uses the server SDK inside the
active host bot before each reply.

### Marketplace distribution

A broadly installable bot requires Zendesk Technology Partner/Marketplace
onboarding and Zendesk-issued OAuth client credentials. Marketplace installs
must use OAuth rather than asking customers for API keys, send the required
Marketplace headers, register their webhook through `integrations/me`, handle
conversation and Switchboard lifecycle events, verify unauthenticated uninstall
callbacks by confirming token revocation, and release control when done or by a
24-hour maximum inactivity deadline. The SDK implements these protocol
primitives; the production onboarding service must persist each installation's
token and identifiers in a managed secret store.

Current Zendesk references:

- [Build a Marketplace bot](https://developer.zendesk.com/documentation/conversations/how-to-guides/building-a-marketplace-bot/)
- [Receive v2 conversation events](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/receiving-messages/)
- [Switchboard control](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/switchboard/)
- [Authenticate messaging users](https://developer.zendesk.com/documentation/conversations/messaging-platform/users/authenticating-users-your-app/)
- [Send structured messages](https://developer.zendesk.com/documentation/conversations/messaging-platform/programmable-conversations/structured-messages/)

## Launch gates

A live company pilot is enabled only after all of these pass in its Zendesk
sandbox:

1. Valid webhook is accepted; missing, wrong-installation, replay-conflict, and
   oversized requests are rejected without resolver or inference calls.
2. The same event delivered concurrently or in a different batch produces one
   inference, one customer operation, and at most one feedback record.
3. Anonymous and cross-installation identities produce no evidence disclosure
   and pass control safely.
4. Clear normal questions continue to the existing bot; English fragments,
   misspellings, empty, and no-words turns exercise the evidence-backed path.
   Missing and non-English profile locales yield without an evidence lookup.
5. Human requests bypass evidence inference and reach the configured human
   route.
6. Lost Switchboard ownership suppresses every pending message, handoff, and
   release operation.
7. Resolver, Wordless, database, and Zendesk timeouts follow the tested retry or
   safe-handoff path without showing implementation errors to the customer.
8. Unanswered choices release control before the configured deadline and never
   release a conversation that has already moved on.
9. Retention, installation purge, backup/restore, secret rotation, rollback,
   alerting, and an ambiguous-delivery runbook are exercised by the operator.
10. The customer's labeled evaluation approves the configured threshold and
    supported evidence mappings. Repository benchmark values are not a customer
    production calibration.

## Honest commercial scope

What can be sold now is a dedicated integration pilot: deployment, Zendesk
Switchboard installation, authenticated evidence mapping, a customer-specific
evaluation, monitoring, and support. A self-service Marketplace listing is a
separate release gate because it depends on partner approval, OAuth credentials,
legal/support URLs, security review, and managed production infrastructure that
cannot be generated from this repository alone.

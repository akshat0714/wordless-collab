# Wordless provider connectors

`@wordless/sdk/connectors` turns **documented provider object shapes** —
a Stripe charge, a Shopify fulfillment/order, a carrier tracking update,
an auth lockout event, a return/RMA line — into the friendlier source
records that [`@wordless/sdk/evidence-resolvers`](../evidence-resolvers/README.md)
accepts. A host can pipe a provider object straight through to
`resolveAccountEvidence(...)` with no hand-mapping.

## This is a shape mapper, not a validator and not a detector

Connectors are pure, offline, zero-dependency functions. They do not call
any provider API, take no credentials, and do not perform final evidence
validation — the resolver layer remains the single strict-validation
boundary. A connector's whole job: select the documented fields it
depends on, normalize the provider's status vocabulary into the
resolver's vocabulary, convert timestamps to ISO-8601, and decide whether
the object is worth handing to the resolver at all.

### `null` means skip, not "something went wrong"

A well-formed provider object that simply isn't evidence-relevant —
a Stripe charge that didn't succeed, a Shopify fulfillment with no
tracking status yet, a pre-transit tracking label, an ordinary
successful login, a return whose SKUs match — returns `null`. That is
the expected, common case, not an error.

### `ConnectorError` means the object is malformed

`ConnectorError` is thrown only when the provider object can't be
mapped at all: it isn't an object, or it's missing an id/timestamp/order
reference the mapper depends on. Every thrown error is an instance of
`ConnectorError` (mirroring the rest of the SDK's error-class style,
with an optional `cause`).

Plural mappers (`fromStripeCharges`, `fromShopifyOrder`) map every
element, drop the `null`s, and return a frozen array.

## Provider mapping tables

### Stripe Charge → `ChargeRecord` (duplicate-charge family)

Reference: [Stripe Charge object](https://stripe.com/docs/api/charges/object).

| Documented Stripe field | `ChargeRecord` field | Notes |
| --- | --- | --- |
| `id` | `ref` | |
| `amount` | `amount` | Integer minor units; emitted with `minorUnits: true` |
| `currency` | `currency` | Passed through as-is (lower-case); the resolver upper-cases it |
| `status` | — | Only `"succeeded"` produces a record; `"pending"`/`"failed"` → `null` |
| `created` | `occurredAt` | Unix **seconds** → ISO-8601 |
| `metadata[orderRefKey]` | `orderRef?` | `orderRefKey` defaults to `"order_id"`, overridable via `opts.orderRefKey` |

`fromStripeCharge(charge, opts?)` throws `ConnectorError` if `id`,
`amount`, `currency`, or `created` is missing or the wrong type.
`fromStripeCharges(charges, opts?)` maps an array.

### Shopify Fulfillment → `ShipmentRecord` (late-delivery family)

Reference: [Shopify Fulfillment resource](https://shopify.dev/docs/api/admin-rest/latest/resources/fulfillment).

| Documented Shopify field | `ShipmentRecord` field | Notes |
| --- | --- | --- |
| `id` | `ref` | |
| `order_id` (or `opts.orderRef`) | `orderRef` | Falls back to `opts.orderRef` when the fulfillment has no `order_id` |
| `shipment_status` | `status` | Normalized — see the status table below; absent/unrecognized → `null` |
| `updated_at` | `occurredAt` | |
| `estimated_delivery_at` / `estimated_delivery` | `expectedDeliveryAt?` | Either documented key is read |

`fromShopifyFulfillment(fulfillment, opts?)` throws `ConnectorError` if
the input isn't an object, `id`/`updated_at` is missing, or no order
reference is resolvable. It does **not** throw for a fulfillment that
simply has no tracking yet.

`fromShopifyOrder(order)` reads `order.id` as the shared order reference
and maps every entry of `order.fulfillments[]` through
`fromShopifyFulfillment`, dropping untracked fulfillments.

### Generic carrier tracking → `ShipmentRecord` (provider-neutral)

Carrier-neutral input shape: `{ id, orderRef, status, updatedAt, estimatedDeliveryAt? }`.

`fromTrackingUpdate(update)` normalizes free carrier status text — see
the status table below — and throws `ConnectorError` if the input isn't
an object or `id`/`orderRef`/`updatedAt`/`status` is missing. A
pre-transit or label-only status (`pre_transit`, `label_created`) isn't
evidence of a shipment in progress yet, so it returns `null`.

### Generic auth lockout → `AccountAccessRecord` (account-lock family)

Provider-neutral input shape (Auth0/Cognito/Okta-style lockout event):
`{ id, accountRef, status, occurredAt, failedAttempts? }`.

`fromLockoutEvent(event)` normalizes the status — see the table below —
passes `failedAttempts` straight through when present, and throws
`ConnectorError` if the input isn't an object or `id`/`accountRef`/
`occurredAt`/`status` is missing. An ordinary successful-login event
(`status: "active"`) isn't a lockout signal, so it returns `null`.

### Return/RMA line → `FulfillmentRecord` (wrong-item family)

Normalized return/exchange input shape: `{ id, orderRef, orderedSku, deliveredSku, occurredAt, reason? }`.

`fromReturnLine(line)` emits a `FulfillmentRecord` with `orderedSku` and
`deliveredSku` set — the resolver derives `mismatched` when they differ
— and throws `ConnectorError` if the input isn't an object or
`id`/`orderRef`/`orderedSku`/`deliveredSku`/`occurredAt` is missing. A
return whose ordered and delivered SKUs match isn't a wrong-item signal,
so it returns `null`.

## Status-vocabulary tables

### Shopify `shipment_status` → resolver shipment status

| Shopify `shipment_status` | Resolver status |
| --- | --- |
| `confirmed` | `shipped` |
| `ready_for_pickup` | `shipped` |
| `picked_up` | `shipped` |
| `in_transit` | `in_transit` |
| `out_for_delivery` | `in_transit` |
| `attempted_delivery` | `delayed` |
| `delivered` | `delivered` |
| `failure` | `lost` |

Any other value (or an absent `shipment_status`) → `null`.

### Generic tracking `status` → resolver shipment status

| Carrier text (case-insensitive; spaces/hyphens → `_`) | Resolver status |
| --- | --- |
| `in_transit` / `in transit` | `in_transit` |
| `out_for_delivery` / `out for delivery` | `in_transit` |
| `delivered` | `delivered` |
| `exception` | `lost` |
| `returned` | `returned` |
| `delayed` | `delayed` |
| `available_for_pickup` / `available for pickup` | `shipped` |
| `pre_transit` | `null` (not yet shipped) |
| `label_created` | `null` (not yet shipped) |

Any other value → `null`.

### Generic auth `status` → resolver account-access status

| Provider text (case-insensitive; spaces/hyphens → `_`) | Resolver status |
| --- | --- |
| `locked` | `locked` |
| `lockout` / `locked_out` | `locked_out` |
| `blocked` / `suspended` | `blocked` |
| `unlocked` | `unlocked` |
| `reset` | `unlocked` |
| `active` | `null` (ordinary login, not a lockout signal) |

Any other value → `null`.

## End-to-end wiring

```ts
import { fromShopifyOrder, fromStripeCharges } from "@wordless/sdk/connectors";
import { resolveAccountEvidence } from "@wordless/sdk/evidence-resolvers";

async function resolveAuthenticatedAccount(customerId: string) {
  const [stripeCharges, shopifyOrder] = await Promise.all([
    billingSystem.recentStripeCharges(customerId),
    shippingSystem.shopifyOrder(customerId),
  ]);

  return resolveAccountEvidence({
    customerId,
    observedAt: new Date().toISOString(),
    charges: fromStripeCharges(stripeCharges),
    shipments: fromShopifyOrder(shopifyOrder),
  });
}
```

See `sdk/examples/connectors-usage.ts` for a runnable, fully placeholder
example.

## Validation discipline

- Every rejection throws a single error class, `ConnectorError`
  (mirroring `EvidenceResolverError` and the rest of the SDK's
  error-class style, with an optional `cause`).
- Only the provider fields named in the tables above are read; every
  other field on the provider object is ignored.
- Every returned record and array is frozen (`Object.freeze`).
- No provider API calls, no credentials, no third-party runtime
  dependencies, and no reliance on the system clock — every timestamp
  conversion is driven by the value the provider object supplies.
- Final validation (identifier length, ISO-instant format, currency
  code, status enum membership, and so on) is the resolver layer's job;
  connectors only decide *whether* to hand a record to it.

# Wordless evidence resolvers

`@wordless/sdk/evidence-resolvers` turns friendlier, provider-shaped
**source records** — the kind of data a billing, shipping, fulfillment, or
identity system already returns — into the exact, strictly typed
`WordlessEvidence[]` that the `/v1/chat/assist` contract and the channel
adapters (Zendesk, and others) consume.

## This is a normalizer, not a detector

This module validates and normalizes. It does not decide that a charge is
a duplicate, a delivery is late, an item is wrong, or an account is
suspiciously locked. Those are judgments the Wordless engine's detectors
make once they see the evidence. Feed this module raw facts; it hands back
raw, strictly typed facts. If you give it two charges for the same order
six minutes apart, both come back in the snapshot — normalizing input is
this module's whole job, and flagging the duplicate is the engine's.

## Source record → evidence mapping

### Charges → `WordlessChargeEvidence`

| Source field (`ChargeRecord`) | Evidence field | Notes |
| --- | --- | --- |
| `ref` | `ref` | Non-empty, trimmed, ≤256 chars |
| `occurredAt` | `occurred_at` | ISO-8601 instant with a timezone |
| `orderRef?` | `order_ref?` | Optional; omitted when not given |
| `amount` | `amount` | String or number — see **Amounts** below |
| `currency` | `currency` | Upper-cased, must be 3 letters (`^[A-Z]{3}$`) |
| `status` | `status` | Normalized — see **Status vocabularies** |
| `minorUnits?` | — | When `true`, a numeric `amount` is divided by 100 |

Allowed evidence statuses: `captured`, `completed`, `paid`, `posted`,
`succeeded`.

### Shipments → `WordlessShipmentEvidence`

| Source field (`ShipmentRecord`) | Evidence field | Notes |
| --- | --- | --- |
| `ref` | `ref` | |
| `occurredAt` | `occurred_at` | |
| `orderRef` | `order_ref` | **Required** — the evidence type demands it |
| `status` | `status` | Normalized |
| `expectedDeliveryAt?` | `expected_delivery_at?` | May legitimately be in the future |

Allowed evidence statuses: `cancelled`, `delayed`, `delivered`,
`in_transit`, `late`, `lost`, `missing`, `overdue`, `returned`, `shipped`.

### Fulfillments → `WordlessFulfillmentEvidence`

| Source field (`FulfillmentRecord`) | Evidence field | Notes |
| --- | --- | --- |
| `ref` | `ref` | |
| `occurredAt` | `occurred_at` | |
| `orderRef` | `order_ref` | |
| `orderedSku` | `ordered_sku` | |
| `deliveredSku` | `delivered_sku` | |
| `status?` | `status` | **If omitted**, derived: equal SKUs → `delivered`, otherwise → `mismatched`. If given, normalized. |

Allowed evidence statuses: `delivered`, `incorrect_item`, `mismatched`,
`wrong_item`.

### Account access → `WordlessAccountAccessEvidence`

| Source field (`AccountAccessRecord`) | Evidence field | Notes |
| --- | --- | --- |
| `ref` | `ref` | |
| `occurredAt` | `occurred_at` | |
| `accountRef` | `account_ref` | |
| `status` | `status` | Normalized |
| `failedAttempts?` | `failed_attempts` | Defaults to `0`; must be a non-negative integer |

Allowed evidence statuses: `active`, `blocked`, `locked`, `locked_out`,
`unlocked`.

## Status vocabularies and overrides

Each family ships a default map from common provider vocabulary
(case-insensitive; spaces and hyphens are normalized to underscores) to
the allowed evidence statuses:

- **Charge**: `succeeded` / `success` → `succeeded`; `paid` → `paid`;
  `complete` / `completed` → `completed`; `captured` → `captured`;
  `posted` / `settled` → `posted`.
- **Shipment**: `in transit` / `in_transit` / `out for delivery` →
  `in_transit`; `shipped` → `shipped`; `delivered` → `delivered`;
  `returned` → `returned`; `cancelled` / `canceled` → `cancelled`;
  `lost` → `lost`; `missing` → `missing`; `delayed` → `delayed`;
  `late` → `late`; `overdue` → `overdue`.
- **Fulfillment**: `wrong item` / `wrong_item` → `wrong_item`;
  `incorrect` / `incorrect_item` → `incorrect_item`; `mismatch` /
  `mismatched` → `mismatched`; `delivered` → `delivered`.
- **Account access**: `active` / `ok` / `open` → `active`;
  `blocked` → `blocked`; `locked` → `locked`; `locked_out` / `lockout` →
  `locked_out`; `unlocked` / `reset` → `unlocked`.

An unrecognized status throws `EvidenceResolverError` — there is no silent
fallback. Every resolver, and `buildEvidenceSnapshot`, accepts a
`statusMap` (or `statusMaps.{charge,shipment,fulfillment,accountAccess}`)
override that is merged over the defaults, so you can teach it your own
provider's vocabulary without forking the module.

## Amounts

`amount` may be:

- A decimal string matching `^\d+(?:\.\d+)?$` — passed through, trimmed.
- A finite, non-negative number — formatted to two decimal places.
- A finite, non-negative number with `minorUnits: true` — divided by 100,
  then formatted to two decimal places (e.g. `8400` cents → `"84.00"`).

Anything else (negative, non-finite, malformed string) throws
`EvidenceResolverError`.

## The future-state rule

The Wordless evidence contract only allows facts observed at or before the
snapshot's `observedAt`. `buildEvidenceSnapshot` enforces this: any
resolved item whose `occurred_at` is strictly **after** `observedAt` is
future-state.

- `futureStatePolicy: "drop"` (the default) — the item is skipped and, if
  provided, `onDropped(item, "future_state")` is called.
- `futureStatePolicy: "reject"` — `buildEvidenceSnapshot` throws
  `EvidenceResolverError` instead.

`expected_delivery_at` on a shipment is exempt from this rule — an ETA
that hasn't happened yet is expected, not future-state, so it is never
dropped or rejected on that basis alone.

The returned snapshot is sorted deterministically by `occurred_at`, then
by `ref`, and both the array and every item in it are frozen
(`Object.isFrozen`).

## The one derived signal: overdue shipments

Every other field is a direct, validated pass-through of the source
record. The single exception is opt-in: set
`deriveOverdueFromExpectedDelivery: true` (on `resolveShipmentEvidence`'s
options, alongside an `observedAt`, or on `buildEvidenceSnapshot`'s input)
and a shipment that is still in progress (`in_transit` or `shipped`) with
an `expectedDeliveryAt` strictly before `observedAt` has its emitted
status upgraded to `overdue`. It is off by default. A `delivered` (or any
other) shipment is never touched by this, regardless of its expected
delivery date.

## Wiring a channel's `resolveAuthenticatedAccount` in one line

`resolveAccountEvidence` accepts the same buckets as
`buildEvidenceSnapshot` plus `customerId` and optional `metadata`, and
returns `{ authenticated: true, customerId, observedAt, evidence,
metadata? }` — structurally exactly what the Zendesk (and other channel)
adapters' `resolveAuthenticatedAccount` callback must return:

```ts
import { resolveAccountEvidence } from "@wordless/sdk/evidence-resolvers";

async function resolveAuthenticatedAccount(userId: string) {
  const customerId = await lookUpVerifiedCustomerId(userId);
  if (customerId === null) return null;

  const [charges, shipments, accountAccess] = await Promise.all([
    billingSystem.recentCharges(customerId),
    shippingSystem.recentShipments(customerId),
    identityProvider.recentLockouts(customerId),
  ]);

  return resolveAccountEvidence({
    customerId,
    observedAt: new Date().toISOString(),
    charges,
    shipments,
    accountAccess,
  });
}
```

See `sdk/examples/evidence-resolvers-usage.ts` for a runnable, fully
placeholder example.

## Validation discipline

Every rejection throws a single error class, `EvidenceResolverError`
(mirroring the rest of the SDK's error-class style, with an optional
`cause`). Strict rules, matching the SDK's existing timestamp and
identifier conventions:

- `ref`, `order_ref` (when present), `account_ref`, and SKUs must be
  non-empty, already-trimmed strings of at most 256 characters.
- `occurredAt`, `expectedDeliveryAt`, and `observedAt` must parse via
  `Date.parse` and match the SDK's ISO-instant convention
  (`/T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/u`) — a timezone is required.
- `currency` is upper-cased and must match `^[A-Z]{3}$`.
- `failedAttempts` must be a non-negative integer; it defaults to `0`.

All returned objects and arrays are frozen (`Object.freeze`). This module
has no third-party runtime dependencies and does not read the system
clock — every timestamp comparison is driven by the `observedAt` the
caller supplies.

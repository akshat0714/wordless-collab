/**
 * Placeholder data only. Nothing here calls a real payment, shipping, or
 * account provider — it shows the shape of records those providers
 * typically return so a host can map its own data the same way.
 */
import { resolveAccountEvidence } from "@wordless/sdk/evidence-resolvers";

// A point-in-time read of "now" the host took when it loaded this
// customer's records. Every resolver enforces facts at-or-before this
// instant; anything after it is future-state and gets dropped (or, with
// futureStatePolicy: "reject", rejected outright).
const OBSERVED_AT = "2026-08-06T15:04:00Z";

// A normalized, Stripe-ish charge export. `amount` may be a decimal
// string, a plain number, or minor units (cents) with `minorUnits: true`.
// `status` accepts common provider vocabulary ("succeeded", "success",
// "paid", ...); resolveAccountEvidence normalizes it to the five statuses
// the Wordless evidence contract allows.
const charges = [
  {
    ref: "ch_1PQstripeExampleA",
    occurredAt: "2026-08-06T14:40:00Z",
    orderRef: "order-9312",
    amount: 8400, // minor units (cents)
    currency: "usd",
    status: "succeeded",
    minorUnits: true,
  },
];

// A carrier-shaped shipment record. "in transit" (with a space) is
// normalized to the contract's "in_transit".
const shipment = {
  ref: "1Z999AA10123456784",
  occurredAt: "2026-08-05T09:00:00Z",
  orderRef: "order-9312",
  status: "in transit",
  expectedDeliveryAt: "2026-08-05T20:00:00Z",
};

// An account-lock event from an identity/auth provider.
const accountLock = {
  ref: "evt_lockout_88213",
  occurredAt: "2026-08-06T14:55:00Z",
  accountRef: "cus_9312",
  status: "lockout",
  failedAttempts: 5,
};

/**
 * This is exactly the shape a WhatsApp/Slack/Zendesk channel adapter's
 * `resolveAuthenticatedAccount(...)` must return, so wiring it into a
 * channel host is a single call: once you've verified the customer's
 * identity, load their records and hand them to `resolveAccountEvidence`.
 */
export async function resolveWordlessAccount(customerId: string) {
  return resolveAccountEvidence({
    customerId,
    observedAt: OBSERVED_AT,
    charges,
    shipments: shipment,
    accountAccess: accountLock,
    // Off by default: only set this when you want an in-progress shipment
    // past its expected delivery date upgraded to "overdue" for you.
    deriveOverdueFromExpectedDelivery: true,
    onDropped: (item, reason) => {
      console.warn(`Dropped evidence ${item.ref}: ${reason}`);
    },
  });
}

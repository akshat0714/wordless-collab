/**
 * Placeholder data only. Nothing here calls the real Stripe or Shopify
 * APIs — it shows the shape those providers document so a host can pipe
 * its own provider objects straight through the same way.
 */
import { fromShopifyOrder, fromStripeCharges } from "@wordless/sdk/connectors";
import { resolveAccountEvidence } from "@wordless/sdk/evidence-resolvers";

// A point-in-time read of "now" the host took when it loaded this
// customer's records. resolveAccountEvidence enforces facts at-or-before
// this instant; anything after it is future-state and gets dropped.
const OBSERVED_AT = "2026-08-06T15:04:00Z";

// Documented Stripe Charge objects, as returned by the Stripe API.
// `fromStripeCharges` skips any charge whose `status` isn't "succeeded"
// (only a captured charge is evidence) and resolves the order reference
// from `metadata.order_id` by default.
const stripeCharges = [
  {
    id: "ch_1PQstripeExampleA",
    amount: 8400, // minor units (cents)
    currency: "usd",
    status: "succeeded",
    created: 1781028000, // unix seconds
    metadata: { order_id: "order-9312" },
  },
  {
    id: "ch_1PQstripeExampleB",
    amount: 8400,
    currency: "usd",
    status: "pending", // not yet captured — fromStripeCharges skips this one
    created: 1781028300,
    metadata: { order_id: "order-9312" },
  },
];

// A documented Shopify Order object with its nested fulfillments.
// `fromShopifyOrder` reads `order.id` as the shared order reference and
// maps each fulfillment's `shipment_status`; a fulfillment with no
// tracking status yet is skipped rather than treated as an error.
const shopifyOrder = {
  id: 820982911946154500,
  fulfillments: [
    {
      id: 255858046,
      order_id: 820982911946154500,
      shipment_status: "out_for_delivery",
      updated_at: "2026-08-05T09:00:00Z",
      estimated_delivery_at: "2026-08-05T20:00:00Z",
    },
  ],
};

/**
 * Connectors are pure shape mappers: they select the documented fields
 * they rely on and normalize provider status vocabulary into the source
 * records `@wordless/sdk/evidence-resolvers` accepts. The resolver layer
 * still performs the final, strict validation — connectors never bypass
 * it.
 */
export async function resolveWordlessAccountFromProviders(customerId: string) {
  const charges = fromStripeCharges(stripeCharges);
  const shipments = fromShopifyOrder(shopifyOrder);

  return resolveAccountEvidence({
    customerId,
    observedAt: OBSERVED_AT,
    charges,
    shipments,
  });
}

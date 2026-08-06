// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  ConnectorError,
  fromLockoutEvent,
  fromReturnLine,
  fromShopifyFulfillment,
  fromShopifyOrder,
  fromStripeCharge,
  fromStripeCharges,
  fromTrackingUpdate,
} from "../src/connectors";
import { resolveChargeEvidence } from "../src/evidence-resolvers";

/* -------------------------------------------------------------------------
 * Stripe → charge
 * ---------------------------------------------------------------------- */

describe("fromStripeCharge", () => {
  it("maps a succeeded charge to a ChargeRecord", () => {
    const record = fromStripeCharge({
      id: "ch_1PQstripeExampleA",
      amount: 8400,
      currency: "usd",
      status: "succeeded",
      created: 1781028000, // 2026-06-09T18:00:00Z
      metadata: { order_id: "order-9312" },
    });
    expect(record).toEqual({
      ref: "ch_1PQstripeExampleA",
      occurredAt: "2026-06-09T18:00:00.000Z",
      amount: 8400,
      minorUnits: true,
      currency: "usd",
      status: "succeeded",
      orderRef: "order-9312",
    });
  });

  it("returns null for a pending charge", () => {
    expect(
      fromStripeCharge({
        id: "ch_pending",
        amount: 1000,
        currency: "usd",
        status: "pending",
        created: 1781028000,
      }),
    ).toBeNull();
  });

  it("returns null for a failed charge", () => {
    expect(
      fromStripeCharge({
        id: "ch_failed",
        amount: 1000,
        currency: "usd",
        status: "failed",
        created: 1781028000,
      }),
    ).toBeNull();
  });

  it("throws ConnectorError when amount is missing", () => {
    expect(() =>
      fromStripeCharge({
        id: "ch_no_amount",
        currency: "usd",
        status: "succeeded",
        created: 1781028000,
      }),
    ).toThrow(ConnectorError);
  });

  it("throws ConnectorError when id is missing", () => {
    expect(() =>
      fromStripeCharge({
        amount: 1000,
        currency: "usd",
        status: "succeeded",
        created: 1781028000,
      }),
    ).toThrow(ConnectorError);
  });

  it("throws ConnectorError when created is missing", () => {
    expect(() =>
      fromStripeCharge({
        id: "ch_no_created",
        amount: 1000,
        currency: "usd",
        status: "succeeded",
      }),
    ).toThrow(ConnectorError);
  });

  it("throws ConnectorError for a non-object charge", () => {
    expect(() => fromStripeCharge("not-a-charge")).toThrow(ConnectorError);
    expect(() => fromStripeCharge(null)).toThrow(ConnectorError);
  });

  it("resolves the order ref via a custom orderRefKey", () => {
    const record = fromStripeCharge(
      {
        id: "ch_custom_key",
        amount: 500,
        currency: "usd",
        status: "succeeded",
        created: 1781028000,
        metadata: { external_order: "order-777" },
      },
      { orderRefKey: "external_order" },
    );
    expect(record?.orderRef).toBe("order-777");
  });

  it("omits orderRef when no metadata order id is resolvable", () => {
    const record = fromStripeCharge({
      id: "ch_no_order",
      amount: 500,
      currency: "usd",
      status: "succeeded",
      created: 1781028000,
    });
    expect(record?.orderRef).toBeUndefined();
  });

  it("freezes the returned record", () => {
    const record = fromStripeCharge({
      id: "ch_frozen",
      amount: 500,
      currency: "usd",
      status: "succeeded",
      created: 1781028000,
    });
    expect(Object.isFrozen(record)).toBe(true);
  });
});

describe("fromStripeCharges", () => {
  it("maps each charge, drops nulls, and freezes the array", () => {
    const records = fromStripeCharges([
      {
        id: "ch_a",
        amount: 100,
        currency: "usd",
        status: "succeeded",
        created: 1781028000,
      },
      {
        id: "ch_b",
        amount: 200,
        currency: "usd",
        status: "pending",
        created: 1781028000,
      },
      {
        id: "ch_c",
        amount: 300,
        currency: "usd",
        status: "succeeded",
        created: 1781028000,
      },
    ]);
    expect(records.map((r) => r.ref)).toEqual(["ch_a", "ch_c"]);
    expect(Object.isFrozen(records)).toBe(true);
  });

  it("piped into resolveChargeEvidence yields valid WordlessChargeEvidence", () => {
    const records = fromStripeCharges([
      {
        id: "ch_e2e",
        amount: 8400,
        currency: "usd",
        status: "succeeded",
        created: 1781028000,
        metadata: { order_id: "order-9312" },
      },
    ]);
    const evidence = resolveChargeEvidence(records);
    expect(evidence).toEqual([
      {
        type: "charge",
        ref: "ch_e2e",
        occurred_at: "2026-06-09T18:00:00.000Z",
        order_ref: "order-9312",
        amount: "84.00",
        currency: "USD",
        status: "succeeded",
      },
    ]);
    expect(Object.isFrozen(evidence)).toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * Shopify → shipment
 * ---------------------------------------------------------------------- */

describe("fromShopifyFulfillment", () => {
  it("maps in_transit using order_id", () => {
    const record = fromShopifyFulfillment({
      id: 998877,
      order_id: 123456,
      shipment_status: "in_transit",
      updated_at: "2026-08-05T09:00:00Z",
    });
    expect(record).toEqual({
      ref: "998877",
      occurredAt: "2026-08-05T09:00:00Z",
      orderRef: "123456",
      status: "in_transit",
    });
  });

  it("maps out_for_delivery to in_transit", () => {
    const record = fromShopifyFulfillment({
      id: 1,
      order_id: 2,
      shipment_status: "out_for_delivery",
      updated_at: "2026-08-05T09:00:00Z",
    });
    expect(record?.status).toBe("in_transit");
  });

  it("maps delivered to delivered", () => {
    const record = fromShopifyFulfillment({
      id: 1,
      order_id: 2,
      shipment_status: "delivered",
      updated_at: "2026-08-05T09:00:00Z",
    });
    expect(record?.status).toBe("delivered");
  });

  it("maps failure to lost", () => {
    const record = fromShopifyFulfillment({
      id: 1,
      order_id: 2,
      shipment_status: "failure",
      updated_at: "2026-08-05T09:00:00Z",
    });
    expect(record?.status).toBe("lost");
  });

  it("maps attempted_delivery to delayed", () => {
    const record = fromShopifyFulfillment({
      id: 1,
      order_id: 2,
      shipment_status: "attempted_delivery",
      updated_at: "2026-08-05T09:00:00Z",
    });
    expect(record?.status).toBe("delayed");
  });

  it("includes expectedDeliveryAt when estimated_delivery_at is present", () => {
    const record = fromShopifyFulfillment({
      id: 1,
      order_id: 2,
      shipment_status: "in_transit",
      updated_at: "2026-08-05T09:00:00Z",
      estimated_delivery_at: "2026-08-07T00:00:00Z",
    });
    expect(record?.expectedDeliveryAt).toBe("2026-08-07T00:00:00Z");
  });

  it("returns null when shipment_status is absent", () => {
    expect(
      fromShopifyFulfillment({
        id: 1,
        order_id: 2,
        updated_at: "2026-08-05T09:00:00Z",
      }),
    ).toBeNull();
  });

  it("returns null for an unrecognized shipment_status", () => {
    expect(
      fromShopifyFulfillment({
        id: 1,
        order_id: 2,
        shipment_status: "some_unknown_status",
        updated_at: "2026-08-05T09:00:00Z",
      }),
    ).toBeNull();
  });

  it("throws ConnectorError when no order reference is resolvable", () => {
    expect(() =>
      fromShopifyFulfillment({
        id: 1,
        shipment_status: "in_transit",
        updated_at: "2026-08-05T09:00:00Z",
      }),
    ).toThrow(ConnectorError);
  });

  it("uses opts.orderRef when order_id is absent", () => {
    const record = fromShopifyFulfillment(
      {
        id: 1,
        shipment_status: "in_transit",
        updated_at: "2026-08-05T09:00:00Z",
      },
      { orderRef: "order-fallback" },
    );
    expect(record?.orderRef).toBe("order-fallback");
  });

  it("throws ConnectorError when updated_at is missing", () => {
    expect(() =>
      fromShopifyFulfillment({
        id: 1,
        order_id: 2,
        shipment_status: "in_transit",
      }),
    ).toThrow(ConnectorError);
  });

  it("throws ConnectorError for a non-object fulfillment", () => {
    expect(() => fromShopifyFulfillment("nope")).toThrow(ConnectorError);
  });

  it("freezes the returned record", () => {
    const record = fromShopifyFulfillment({
      id: 1,
      order_id: 2,
      shipment_status: "delivered",
      updated_at: "2026-08-05T09:00:00Z",
    });
    expect(Object.isFrozen(record)).toBe(true);
  });
});

describe("fromShopifyOrder", () => {
  it("maps multiple fulfillments using the order's id", () => {
    const records = fromShopifyOrder({
      id: 555,
      fulfillments: [
        { id: 1, shipment_status: "in_transit", updated_at: "2026-08-05T09:00:00Z" },
        { id: 2, shipment_status: "delivered", updated_at: "2026-08-06T09:00:00Z" },
        { id: 3, updated_at: "2026-08-06T10:00:00Z" }, // no shipment_status -> dropped
      ],
    });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ ref: "1", orderRef: "555", status: "in_transit" });
    expect(records[1]).toMatchObject({ ref: "2", orderRef: "555", status: "delivered" });
    expect(Object.isFrozen(records)).toBe(true);
  });

  it("throws ConnectorError for a non-object order", () => {
    expect(() => fromShopifyOrder(null)).toThrow(ConnectorError);
  });
});

/* -------------------------------------------------------------------------
 * Generic carrier tracking → shipment
 * ---------------------------------------------------------------------- */

describe("fromTrackingUpdate", () => {
  it("normalizes 'out for delivery' to in_transit", () => {
    const record = fromTrackingUpdate({
      id: "1Z999AA1",
      orderRef: "order-1",
      status: "out for delivery",
      updatedAt: "2026-08-05T09:00:00Z",
    });
    expect(record?.status).toBe("in_transit");
  });

  it("returns null for label_created", () => {
    expect(
      fromTrackingUpdate({
        id: "1Z999AA1",
        orderRef: "order-1",
        status: "label_created",
        updatedAt: "2026-08-05T09:00:00Z",
      }),
    ).toBeNull();
  });

  it("returns null for pre_transit", () => {
    expect(
      fromTrackingUpdate({
        id: "1Z999AA1",
        orderRef: "order-1",
        status: "pre_transit",
        updatedAt: "2026-08-05T09:00:00Z",
      }),
    ).toBeNull();
  });

  it("maps delivered, exception, returned, delayed, and available for pickup", () => {
    const base = { id: "t1", orderRef: "order-1", updatedAt: "2026-08-05T09:00:00Z" };
    expect(fromTrackingUpdate({ ...base, status: "delivered" })?.status).toBe("delivered");
    expect(fromTrackingUpdate({ ...base, status: "exception" })?.status).toBe("lost");
    expect(fromTrackingUpdate({ ...base, status: "returned" })?.status).toBe("returned");
    expect(fromTrackingUpdate({ ...base, status: "delayed" })?.status).toBe("delayed");
    expect(fromTrackingUpdate({ ...base, status: "available for pickup" })?.status).toBe("shipped");
  });

  it("throws ConnectorError for a malformed update", () => {
    expect(() => fromTrackingUpdate("nope")).toThrow(ConnectorError);
    expect(() => fromTrackingUpdate({ orderRef: "order-1", status: "delivered", updatedAt: "x" })).toThrow(
      ConnectorError,
    );
  });

  it("freezes the returned record", () => {
    const record = fromTrackingUpdate({
      id: "1Z999AA1",
      orderRef: "order-1",
      status: "delivered",
      updatedAt: "2026-08-05T09:00:00Z",
    });
    expect(Object.isFrozen(record)).toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * Generic auth lockout → account_access
 * ---------------------------------------------------------------------- */

describe("fromLockoutEvent", () => {
  it("maps lockout to a locked-family status with failedAttempts passthrough", () => {
    const record = fromLockoutEvent({
      id: "evt_1",
      accountRef: "cus_1",
      status: "lockout",
      occurredAt: "2026-08-06T14:55:00Z",
      failedAttempts: 5,
    });
    expect(record).toEqual({
      ref: "evt_1",
      occurredAt: "2026-08-06T14:55:00Z",
      accountRef: "cus_1",
      status: "locked_out",
      failedAttempts: 5,
    });
  });

  it("returns null for an ordinary successful login", () => {
    expect(
      fromLockoutEvent({
        id: "evt_2",
        accountRef: "cus_1",
        status: "active",
        occurredAt: "2026-08-06T14:55:00Z",
      }),
    ).toBeNull();
  });

  it("throws ConnectorError for a malformed event", () => {
    expect(() => fromLockoutEvent("nope")).toThrow(ConnectorError);
    expect(() =>
      fromLockoutEvent({ accountRef: "cus_1", status: "lockout", occurredAt: "2026-08-06T14:55:00Z" }),
    ).toThrow(ConnectorError);
  });

  it("freezes the returned record", () => {
    const record = fromLockoutEvent({
      id: "evt_3",
      accountRef: "cus_1",
      status: "locked",
      occurredAt: "2026-08-06T14:55:00Z",
    });
    expect(Object.isFrozen(record)).toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * Return/RMA → fulfillment
 * ---------------------------------------------------------------------- */

describe("fromReturnLine", () => {
  it("emits a FulfillmentRecord when SKUs differ", () => {
    const record = fromReturnLine({
      id: "rma_1",
      orderRef: "order-1",
      orderedSku: "SKU-A",
      deliveredSku: "SKU-B",
      occurredAt: "2026-08-06T14:55:00Z",
      reason: "wrong item",
    });
    expect(record).toEqual({
      ref: "rma_1",
      occurredAt: "2026-08-06T14:55:00Z",
      orderRef: "order-1",
      orderedSku: "SKU-A",
      deliveredSku: "SKU-B",
    });
  });

  it("returns null when SKUs match", () => {
    expect(
      fromReturnLine({
        id: "rma_2",
        orderRef: "order-1",
        orderedSku: "SKU-A",
        deliveredSku: "SKU-A",
        occurredAt: "2026-08-06T14:55:00Z",
      }),
    ).toBeNull();
  });

  it("throws ConnectorError for a malformed return line", () => {
    expect(() => fromReturnLine("nope")).toThrow(ConnectorError);
    expect(() =>
      fromReturnLine({
        orderRef: "order-1",
        orderedSku: "SKU-A",
        deliveredSku: "SKU-B",
        occurredAt: "2026-08-06T14:55:00Z",
      }),
    ).toThrow(ConnectorError);
  });

  it("freezes the returned record", () => {
    const record = fromReturnLine({
      id: "rma_3",
      orderRef: "order-1",
      orderedSku: "SKU-A",
      deliveredSku: "SKU-B",
      occurredAt: "2026-08-06T14:55:00Z",
    });
    expect(Object.isFrozen(record)).toBe(true);
  });
});

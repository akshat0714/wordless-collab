// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  EvidenceResolverError,
  buildEvidenceSnapshot,
  resolveAccountAccessEvidence,
  resolveAccountEvidence,
  resolveChargeEvidence,
  resolveFulfillmentEvidence,
  resolveShipmentEvidence,
} from "../src/evidence-resolvers";
import type { WordlessEvidence } from "../src/server";

const OBSERVED_AT = "2026-08-01T12:00:00Z";

describe("resolveChargeEvidence", () => {
  it("resolves a succeeded charge record", () => {
    const [evidence] = resolveChargeEvidence({
      ref: "charge-1",
      occurredAt: "2026-07-30T19:00:00Z",
      amount: "84.00",
      currency: "usd",
      status: "succeeded",
      orderRef: "order-441",
    });
    expect(evidence).toEqual({
      type: "charge",
      ref: "charge-1",
      occurred_at: "2026-07-30T19:00:00Z",
      order_ref: "order-441",
      amount: "84.00",
      currency: "USD",
      status: "succeeded",
    });
  });

  it("formats a number amount to two decimals", () => {
    const [evidence] = resolveChargeEvidence({
      ref: "charge-2",
      occurredAt: "2026-07-30T19:00:00Z",
      amount: 12.34,
      currency: "USD",
      status: "paid",
    });
    expect(evidence?.amount).toBe("12.34");
  });

  it("divides minor-units amounts by 100", () => {
    const [evidence] = resolveChargeEvidence({
      ref: "charge-3",
      occurredAt: "2026-07-30T19:00:00Z",
      amount: 1234,
      currency: "USD",
      status: "captured",
      minorUnits: true,
    });
    expect(evidence?.amount).toBe("12.34");
  });

  it("passes through a valid decimal amount string unchanged", () => {
    const [evidence] = resolveChargeEvidence({
      ref: "charge-4",
      occurredAt: "2026-07-30T19:00:00Z",
      amount: "84.00",
      currency: "USD",
      status: "posted",
    });
    expect(evidence?.amount).toBe("84.00");
  });

  it("rejects an invalid amount string", () => {
    expect(() =>
      resolveChargeEvidence({
        ref: "charge-5",
        occurredAt: "2026-07-30T19:00:00Z",
        amount: "not-a-number",
        currency: "USD",
        status: "paid",
      }),
    ).toThrow(EvidenceResolverError);
  });

  it("rejects a bad currency code", () => {
    expect(() =>
      resolveChargeEvidence({
        ref: "charge-6",
        occurredAt: "2026-07-30T19:00:00Z",
        amount: "10.00",
        currency: "US",
        status: "paid",
      }),
    ).toThrow(EvidenceResolverError);
  });

  it("maps a status synonym (success) to succeeded", () => {
    const [evidence] = resolveChargeEvidence({
      ref: "charge-7",
      occurredAt: "2026-07-30T19:00:00Z",
      amount: "10.00",
      currency: "USD",
      status: "success",
    });
    expect(evidence?.status).toBe("succeeded");
  });

  it("rejects an unknown status", () => {
    expect(() =>
      resolveChargeEvidence({
        ref: "charge-8",
        occurredAt: "2026-07-30T19:00:00Z",
        amount: "10.00",
        currency: "USD",
        status: "pending-review",
      }),
    ).toThrow(EvidenceResolverError);
  });

  it("honors a statusMap override", () => {
    const [evidence] = resolveChargeEvidence(
      {
        ref: "charge-9",
        occurredAt: "2026-07-30T19:00:00Z",
        amount: "10.00",
        currency: "USD",
        status: "wl_custom_paid",
      },
      { statusMap: { wl_custom_paid: "paid" } },
    );
    expect(evidence?.status).toBe("paid");
  });
});

describe("resolveShipmentEvidence", () => {
  it("normalizes 'in transit' to in_transit", () => {
    const [evidence] = resolveShipmentEvidence({
      ref: "ship-1",
      occurredAt: "2026-07-30T19:00:00Z",
      orderRef: "order-441",
      status: "in transit",
    });
    expect(evidence?.status).toBe("in_transit");
  });

  it("requires orderRef", () => {
    expect(() =>
      resolveShipmentEvidence({
        ref: "ship-2",
        occurredAt: "2026-07-30T19:00:00Z",
        orderRef: "",
        status: "shipped",
      }),
    ).toThrow(EvidenceResolverError);
  });

  it("upgrades an overdue in_transit shipment when deriveOverdueFromExpectedDelivery is set", () => {
    const [evidence] = resolveShipmentEvidence(
      {
        ref: "ship-3",
        occurredAt: "2026-07-30T19:00:00Z",
        orderRef: "order-441",
        status: "in_transit",
        expectedDeliveryAt: "2026-07-29T19:00:00Z",
      },
      { deriveOverdueFromExpectedDelivery: true, observedAt: OBSERVED_AT },
    );
    expect(evidence?.status).toBe("overdue");
  });

  it("does not touch a delivered shipment even past its expected date", () => {
    const [evidence] = resolveShipmentEvidence(
      {
        ref: "ship-4",
        occurredAt: "2026-07-30T19:00:00Z",
        orderRef: "order-441",
        status: "delivered",
        expectedDeliveryAt: "2026-07-29T19:00:00Z",
      },
      { deriveOverdueFromExpectedDelivery: true, observedAt: OBSERVED_AT },
    );
    expect(evidence?.status).toBe("delivered");
  });
});

describe("resolveFulfillmentEvidence", () => {
  it("derives mismatched when status omitted and SKUs differ", () => {
    const [evidence] = resolveFulfillmentEvidence({
      ref: "fulfill-1",
      occurredAt: "2026-07-30T19:00:00Z",
      orderRef: "order-441",
      orderedSku: "SKU-A",
      deliveredSku: "SKU-B",
    });
    expect(evidence?.status).toBe("mismatched");
  });

  it("derives delivered when status omitted and SKUs match", () => {
    const [evidence] = resolveFulfillmentEvidence({
      ref: "fulfill-2",
      occurredAt: "2026-07-30T19:00:00Z",
      orderRef: "order-441",
      orderedSku: "SKU-A",
      deliveredSku: "SKU-A",
    });
    expect(evidence?.status).toBe("delivered");
  });

  it("maps 'wrong item' to wrong_item", () => {
    const [evidence] = resolveFulfillmentEvidence({
      ref: "fulfill-3",
      occurredAt: "2026-07-30T19:00:00Z",
      orderRef: "order-441",
      orderedSku: "SKU-A",
      deliveredSku: "SKU-B",
      status: "wrong item",
    });
    expect(evidence?.status).toBe("wrong_item");
  });
});

describe("resolveAccountAccessEvidence", () => {
  it("maps 'locked' to locked with a default failed_attempts of 0", () => {
    const [evidence] = resolveAccountAccessEvidence({
      ref: "access-1",
      occurredAt: "2026-07-30T19:00:00Z",
      accountRef: "account-9",
      status: "locked",
    });
    expect(evidence?.status).toBe("locked");
    expect(evidence?.failed_attempts).toBe(0);
  });

  it("rejects a negative failedAttempts", () => {
    expect(() =>
      resolveAccountAccessEvidence({
        ref: "access-2",
        occurredAt: "2026-07-30T19:00:00Z",
        accountRef: "account-9",
        status: "locked",
        failedAttempts: -1,
      }),
    ).toThrow(EvidenceResolverError);
  });
});

describe("buildEvidenceSnapshot future-state handling", () => {
  it("drops a charge whose occurredAt is after observedAt by default", () => {
    const dropped: { item: WordlessEvidence; reason: string }[] = [];
    const snapshot = buildEvidenceSnapshot({
      observedAt: OBSERVED_AT,
      charges: {
        ref: "future-charge",
        occurredAt: "2026-08-02T12:00:00Z",
        amount: "10.00",
        currency: "USD",
        status: "paid",
      },
      onDropped: (item, reason) => {
        dropped.push({ item, reason });
      },
    });
    expect(snapshot).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.reason).toBe("future_state");
    expect(dropped[0]?.item.ref).toBe("future-charge");
  });

  it("throws under futureStatePolicy: reject", () => {
    expect(() =>
      buildEvidenceSnapshot({
        observedAt: OBSERVED_AT,
        futureStatePolicy: "reject",
        charges: {
          ref: "future-charge-2",
          occurredAt: "2026-08-02T12:00:00Z",
          amount: "10.00",
          currency: "USD",
          status: "paid",
        },
      }),
    ).toThrow(EvidenceResolverError);
  });

  it("allows a future expected_delivery_at without dropping the shipment", () => {
    const snapshot = buildEvidenceSnapshot({
      observedAt: OBSERVED_AT,
      shipments: {
        ref: "ship-future-eta",
        occurredAt: "2026-07-30T19:00:00Z",
        orderRef: "order-441",
        status: "in_transit",
        expectedDeliveryAt: "2026-08-15T19:00:00Z",
      },
    });
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ ref: "ship-future-eta", status: "in_transit" });
  });
});

describe("buildEvidenceSnapshot duplicate-charge end-to-end", () => {
  it("keeps both charge records in deterministic order", () => {
    const snapshot = buildEvidenceSnapshot({
      observedAt: OBSERVED_AT,
      charges: [
        {
          ref: "charge-dup-2",
          occurredAt: "2026-07-30T19:06:00Z",
          orderRef: "order-441",
          amount: "84.00",
          currency: "USD",
          status: "succeeded",
        },
        {
          ref: "charge-dup-1",
          occurredAt: "2026-07-30T19:00:00Z",
          orderRef: "order-441",
          amount: "84.00",
          currency: "USD",
          status: "succeeded",
        },
      ],
    });
    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((item) => item.ref)).toEqual(["charge-dup-1", "charge-dup-2"]);
  });
});

describe("resolveAccountEvidence", () => {
  it("returns an authenticated account shape with frozen evidence", () => {
    const result = resolveAccountEvidence({
      customerId: "customer-1",
      observedAt: OBSERVED_AT,
      charges: {
        ref: "charge-acct-1",
        occurredAt: "2026-07-30T19:00:00Z",
        amount: "10.00",
        currency: "USD",
        status: "paid",
      },
      accountAccess: {
        ref: "access-acct-1",
        occurredAt: "2026-07-30T19:05:00Z",
        accountRef: "account-1",
        status: "locked",
      },
    });
    expect(result.authenticated).toBe(true);
    expect(result.customerId).toBe("customer-1");
    expect(result.observedAt).toBe(OBSERVED_AT);
    expect(result.evidence.map((item) => item.ref)).toEqual([
      "charge-acct-1",
      "access-acct-1",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    for (const item of result.evidence) {
      expect(Object.isFrozen(item)).toBe(true);
    }
  });
});

describe("frozen outputs", () => {
  it("freezes resolver arrays and items", () => {
    const evidence = resolveChargeEvidence({
      ref: "charge-frozen",
      occurredAt: "2026-07-30T19:00:00Z",
      amount: "10.00",
      currency: "USD",
      status: "paid",
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence[0])).toBe(true);
  });

  it("freezes buildEvidenceSnapshot output", () => {
    const snapshot = buildEvidenceSnapshot({
      observedAt: OBSERVED_AT,
      fulfillments: {
        ref: "fulfill-frozen",
        occurredAt: "2026-07-30T19:00:00Z",
        orderRef: "order-441",
        orderedSku: "SKU-A",
        deliveredSku: "SKU-A",
      },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
  });
});

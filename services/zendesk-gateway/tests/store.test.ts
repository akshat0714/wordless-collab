import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { MemoryGatewayStore } from "../src/store.js";

const request = {
  method: "POST" as const,
  path: "/sc/v2/apps/app/conversations/conversation/messages",
  body: {
    author: { type: "business" as const },
    content: { type: "text" as const, text: "Safe reply", blockChatInput: false as const },
  },
};

const releaseRequest = {
  method: "POST" as const,
  path: "/sc/v2/apps/app/conversations/conversation/releaseControl",
  body: {},
};

async function leasedDelivery(store: MemoryGatewayStore, deliveryKey: string): Promise<void> {
  await store.claimDelivery({
    installationId: "tenant",
    deliveryKey,
    bodySha256: deliveryKey.padEnd(64, "a").slice(0, 64),
    payload: {},
  });
  const claimed = await store.claimInbox(1, 10_000, 3);
  expect(claimed[0]?.deliveryKey).toBe(deliveryKey);
}

it("reserves an event once across differently batched deliveries", async () => {
  const store = new MemoryGatewayStore();
  const claims = await Promise.all([
    store.claimEvent({ installationId: "tenant", eventId: "event-1", deliveryKey: "delivery-a", leaseMs: 10_000, conversationId: "conversation", controlActivity: true, safetyRelease: null, eventCreatedAt: "2026-01-01T00:00:00.000Z" }),
    store.claimEvent({ installationId: "tenant", eventId: "event-1", deliveryKey: "delivery-b", leaseMs: 10_000, conversationId: "conversation", controlActivity: true, safetyRelease: null, eventCreatedAt: "2026-01-01T00:00:00.000Z" }),
  ]);
  expect(claims.filter((value) => value === "claimed")).toHaveLength(1);
  expect(claims).toContain("busy");
});

it("makes choice consumption same-event idempotent and rejects new-event replay", async () => {
  const store = new MemoryGatewayStore();
  const expires = new Date(Date.now() + 60_000);
  const issuedAt = new Date().toISOString();
  const expiresAt = expires.toISOString();
  await store.saveChoices("tenant", [{
    appId: "app",
    conversationId: "conversation",
    userId: "user",
    suggestionId: `sg_${"a".repeat(32)}`,
    sourceMessageId: "message",
    sourceMessageNonce: "nonce-123456789",
    issuedAt,
    expiresAt,
    choices: [{ payload: "signed", id: "late_order", label: "Late order", reply: "Where is my order?", detectorId: "late_shipment", evidenceIndexes: [0], feedback: "confirmed" }],
  }], expires);
  const input = {
    appId: "app",
    conversationId: "conversation",
    userId: "user",
    payload: "signed",
    selectionReceivedAt: issuedAt,
    sourceMessageNonce: "nonce-123456789",
    issuedAt,
    expiresAt,
  };
  await expect(store.resolveChoice("tenant", { ...input, selectionEventId: "event-a" })).resolves.not.toBeNull();
  await expect(store.resolveChoice("tenant", { ...input, selectionEventId: "event-a" })).resolves.not.toBeNull();
  await expect(store.resolveChoice("tenant", { ...input, selectionEventId: "event-b" })).resolves.toBeNull();
});

it("quarantines an ambiguous send instead of leasing it again", async () => {
  const store = new MemoryGatewayStore();
  await store.claimDelivery({ installationId: "tenant", deliveryKey: "delivery", bodySha256: "a".repeat(64), payload: {} });
  await store.claimInbox(1, 10_000, 3);
  const id = randomUUID();
  await store.stageDelivery({
    installationId: "tenant",
    deliveryKey: "delivery",
    choiceExpiresAt: new Date(Date.now() + 60_000),
    plans: [{
      eventId: null,
      activity: null,
      operations: [{
        id,
        eventKey: "event",
        kind: "post_message",
        productMode: "customer_clarify",
        conversationId: "conversation",
        availableAt: new Date(),
        guardEventId: null,
        request,
      }],
      choices: [],
    }],
  });
  const [leased] = await store.claimOutbox(1, 10_000, 3);
  expect(leased?.id).toBe(id);
  await store.markOutboxAmbiguous(id, "ambiguous_delivery_error");
  await expect(store.claimOutbox(1, 10_000, 3)).resolves.toHaveLength(0);
});

it("purges all tenant state without affecting future installation use", async () => {
  const store = new MemoryGatewayStore();
  const claim = { installationId: "tenant", deliveryKey: "delivery", bodySha256: "b".repeat(64), payload: {} };
  await expect(store.claimDelivery(claim)).resolves.toBe("claimed");
  await store.purgeInstallation("tenant");
  await expect(store.claimDelivery(claim)).resolves.toBe("claimed");
});

it("drops older in-flight customer and lifecycle plans without cancelling newer releases", async () => {
  for (const claimsAdvance of [true, false]) {
    const store = new MemoryGatewayStore();
    await leasedDelivery(store, "delivery-a");
    await store.claimEvent({
      installationId: "tenant", eventId: "event-a", deliveryKey: "delivery-a", leaseMs: 10_000,
      conversationId: "conversation", controlActivity: claimsAdvance, safetyRelease: null,
      eventCreatedAt: "2026-01-01T00:00:00.000Z",
    });
    await leasedDelivery(store, "delivery-b");
    await store.claimEvent({
      installationId: "tenant", eventId: "event-b", deliveryKey: "delivery-b", leaseMs: 10_000,
      conversationId: "conversation", controlActivity: claimsAdvance, safetyRelease: null,
      eventCreatedAt: "2026-01-01T00:00:01.000Z",
    });
    const operation = (eventId: string) => ({
      id: randomUUID(),
      eventKey: `release:${eventId}`,
      kind: "release_control" as const,
      productMode: "customer_clarify" as const,
      conversationId: "conversation",
      availableAt: new Date(Date.now() + 60_000),
      guardEventId: eventId,
      request: releaseRequest,
    });
    await store.stageDelivery({
      installationId: "tenant", deliveryKey: "delivery-b", choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{
        eventId: "event-b",
        activity: { conversationId: "conversation", occurredAt: "2026-01-01T00:00:01.000Z", cancelReleases: true },
        operations: [operation("event-b")], choices: [],
      }],
    });
    await expect(store.stageDelivery({
      installationId: "tenant", deliveryKey: "delivery-a", choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{
        eventId: "event-a",
        activity: { conversationId: "conversation", occurredAt: "2026-01-01T00:00:00.000Z", cancelReleases: true },
        operations: [operation("event-a")], choices: [],
      }],
    })).resolves.toBe(0);
    const live = store.snapshot().outbox.filter((item) => item.status === "pending");
    expect(live.map((item) => item.eventKey)).toEqual(["release:event-b"]);
  }
});

it("fences a leased message when a newer control event advances the conversation", async () => {
  const store = new MemoryGatewayStore();
  await leasedDelivery(store, "delivery-a");
  await store.claimEvent({
    installationId: "tenant", eventId: "event-a", deliveryKey: "delivery-a", leaseMs: 10_000,
    conversationId: "conversation", controlActivity: true, safetyRelease: null,
    eventCreatedAt: "2026-01-01T00:00:00.000Z",
  });
  const postId = randomUUID();
  await store.stageDelivery({
    installationId: "tenant", deliveryKey: "delivery-a", choiceExpiresAt: new Date(Date.now() + 60_000),
    plans: [{
      eventId: "event-a",
      activity: { conversationId: "conversation", occurredAt: "2026-01-01T00:00:00.000Z", cancelReleases: true },
      choices: [],
      operations: [{
        id: postId, eventKey: "post-a", kind: "post_message", productMode: "customer_clarify",
        conversationId: "conversation", availableAt: new Date(), guardEventId: "event-a", request,
      }],
    }],
  });
  const [leased] = await store.claimOutbox(1, 10_000, 3);
  expect(leased?.id).toBe(postId);

  await leasedDelivery(store, "delivery-b");
  await store.claimEvent({
    installationId: "tenant", eventId: "event-b", deliveryKey: "delivery-b", leaseMs: 10_000,
    conversationId: "conversation", controlActivity: true, safetyRelease: null,
    eventCreatedAt: "2026-01-01T00:00:01.000Z",
  });
  let executed = false;
  await expect(store.deliverOutboxFenced(leased!, async () => {
    executed = true;
    return "delivered";
  })).resolves.toBe("stale");
  expect(executed).toBe(false);
});

it("lets the current fenced release bypass an ambiguous message while ordinary successors stay quarantined", async () => {
  const store = new MemoryGatewayStore();
  await leasedDelivery(store, "delivery");
  await store.claimEvent({
    installationId: "tenant", eventId: "event-current", deliveryKey: "delivery", leaseMs: 10_000,
    conversationId: "conversation", controlActivity: true, safetyRelease: null,
    eventCreatedAt: "2026-01-01T00:00:00.000Z",
  });
  const postId = randomUUID();
  const releaseId = randomUUID();
  await store.stageDelivery({
    installationId: "tenant", deliveryKey: "delivery", choiceExpiresAt: new Date(Date.now() + 60_000),
    plans: [{
      eventId: "event-current",
      activity: { conversationId: "conversation", occurredAt: "2026-01-01T00:00:00.000Z", cancelReleases: true },
      choices: [],
      operations: [
        { id: postId, eventKey: "post", kind: "post_message", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(), guardEventId: "event-current", request },
        { id: releaseId, eventKey: "release", kind: "release_control", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(Date.now() + 20), guardEventId: "event-current", request: releaseRequest },
        { id: randomUUID(), eventKey: "later-post", kind: "post_message", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(), guardEventId: "event-current", request },
      ],
    }],
  });
  expect((await store.claimOutbox(10, 10_000, 3))[0]?.id).toBe(postId);
  await store.markOutboxAmbiguous(postId, "unknown_outcome");
  await new Promise((resolve) => setTimeout(resolve, 25));
  const [release] = await store.claimOutbox(10, 10_000, 3);
  expect(release?.id).toBe(releaseId);
  await expect(store.deliverOutboxFenced(release!, async () => "delivered")).resolves.toBe("delivered");
  await expect(store.claimOutbox(10, 10_000, 3)).resolves.toHaveLength(0);
});

it("lets a newer explicit human handoff bypass an ambiguous message", async () => {
  const store = new MemoryGatewayStore();
  await leasedDelivery(store, "delivery-a");
  const ambiguousId = randomUUID();
  await store.stageDelivery({
    installationId: "tenant", deliveryKey: "delivery-a", choiceExpiresAt: new Date(Date.now() + 60_000),
    plans: [{ eventId: null, activity: null, choices: [], operations: [{
      id: ambiguousId, eventKey: "ambiguous-post", kind: "post_message", productMode: "customer_clarify",
      conversationId: "conversation", availableAt: new Date(), guardEventId: null, request,
    }] }],
  });
  expect((await store.claimOutbox(1, 10_000, 3))[0]?.id).toBe(ambiguousId);
  await store.markOutboxAmbiguous(ambiguousId, "unknown_outcome");

  await leasedDelivery(store, "delivery-b");
  await store.claimEvent({
    installationId: "tenant", eventId: "human-event", deliveryKey: "delivery-b", leaseMs: 10_000,
    conversationId: "conversation", controlActivity: true, safetyRelease: null,
    eventCreatedAt: "2026-01-01T00:00:01.000Z",
  });
  const passId = randomUUID();
  await store.stageDelivery({
    installationId: "tenant", deliveryKey: "delivery-b", choiceExpiresAt: new Date(Date.now() + 60_000),
    plans: [{
      eventId: "human-event",
      activity: { conversationId: "conversation", occurredAt: "2026-01-01T00:00:01.000Z", cancelReleases: true },
      choices: [],
      operations: [{
        id: passId, eventKey: "human-pass", kind: "pass_control", productMode: "customer_clarify",
        conversationId: "conversation", availableAt: new Date(), guardEventId: "human-event",
        request: {
          method: "POST",
          path: "/sc/v2/apps/app/conversations/conversation/passControl",
          body: {
            switchboardIntegration: "human-agent-switchboard",
            metadata: { first_message_id: "human-message", handoff_reason: "human_requested" },
          },
        },
      }],
    }],
  });
  const [pass] = await store.claimOutbox(1, 10_000, 3);
  expect(pass?.id).toBe(passId);
  await expect(store.deliverOutboxFenced(pass!, async () => "delivered")).resolves.toBe("delivered");
});

it("keeps a conversation quarantined after ambiguous payload retention and supports verified reconciliation", async () => {
  const store = new MemoryGatewayStore();
  await leasedDelivery(store, "delivery");
  const ambiguousId = randomUUID();
  await store.stageDelivery({
    installationId: "tenant", deliveryKey: "delivery", choiceExpiresAt: new Date(Date.now() + 60_000),
    plans: [{ eventId: null, activity: null, choices: [], operations: [
      { id: ambiguousId, eventKey: "first", kind: "post_message", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(), guardEventId: null, request },
      { id: randomUUID(), eventKey: "successor", kind: "post_message", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(), guardEventId: null, request },
    ] }],
  });
  await store.claimOutbox(1, 10_000, 3);
  await store.markOutboxAmbiguous(ambiguousId, "unknown_outcome");
  await store.cleanup(new Date(Date.now() + 1_000));
  await expect(store.claimOutbox(1, 10_000, 3)).resolves.toHaveLength(0);
  await expect(store.listQuarantines()).resolves.toEqual([
    expect.objectContaining({
      outboxId: ambiguousId,
      payloadAvailable: false,
      operationKind: "post_message",
      eventKey: "first",
    }),
  ]);
  await store.reconcileQuarantine({
    installationId: "tenant", conversationId: "conversation", outboxId: ambiguousId, resolution: "delivered",
  });
  await expect(store.claimOutbox(1, 10_000, 3)).resolves.toHaveLength(1);
});

it("does not let a future release block a later due message", async () => {
  const store = new MemoryGatewayStore();
  await leasedDelivery(store, "delivery");
  const first = randomUUID();
  const second = randomUUID();
  await store.stageDelivery({
    installationId: "tenant", deliveryKey: "delivery", choiceExpiresAt: new Date(Date.now() + 60_000),
    plans: [{ eventId: null, activity: null, choices: [], operations: [
      { id: first, eventKey: "first", kind: "post_message", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(), guardEventId: null, request },
      { id: randomUUID(), eventKey: "future-release", kind: "release_control", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(Date.now() + 60_000), guardEventId: "event", request: releaseRequest },
      { id: second, eventKey: "second", kind: "post_message", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(), guardEventId: null, request },
    ] }],
  });
  expect((await store.claimOutbox(1, 10_000, 3))[0]?.id).toBe(first);
  await store.markOutboxDelivered(first);
  expect((await store.claimOutbox(1, 10_000, 3))[0]?.id).toBe(second);
});

it("grants exactly one operator-approved retry even after the automatic attempt budget is exhausted", async () => {
  const store = new MemoryGatewayStore();
  await leasedDelivery(store, "delivery");
  const id = randomUUID();
  await store.stageDelivery({
    installationId: "tenant", deliveryKey: "delivery", choiceExpiresAt: new Date(Date.now() + 60_000),
    plans: [{ eventId: null, activity: null, choices: [], operations: [
      { id, eventKey: "operator-retry", kind: "post_message", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(), guardEventId: null, request },
    ] }],
  });
  const [leased] = await store.claimOutbox(1, 10_000, 1);
  expect(leased?.id).toBe(id);
  await store.markOutboxAmbiguous(id, "unknown_outcome");
  await store.reconcileQuarantine({
    installationId: "tenant", conversationId: "conversation", outboxId: id, resolution: "retry",
  });
  const approved = await store.claimOutbox(1, 10_000, 1);
  expect(approved).toHaveLength(1);
  expect(approved[0]?.id).toBe(id);
  await store.rescheduleOutbox(id, new Date(), "definitive_failure", false);
  await expect(store.claimOutbox(1, 10_000, 1)).resolves.toHaveLength(0);
});

it("retains conversation state while work is live and removes it after safe retention", async () => {
  const store = new MemoryGatewayStore();
  await leasedDelivery(store, "retention-delivery");
  await store.claimEvent({
    installationId: "tenant", eventId: "retention-event", deliveryKey: "retention-delivery", leaseMs: 10_000,
    conversationId: "retention-conversation", controlActivity: true, safetyRelease: null,
    eventCreatedAt: "2026-01-01T00:00:00.000Z",
  });
  const id = randomUUID();
  await store.stageDelivery({
    installationId: "tenant", deliveryKey: "retention-delivery", choiceExpiresAt: new Date(Date.now() + 60_000),
    plans: [{
      eventId: "retention-event",
      activity: { conversationId: "retention-conversation", occurredAt: "2026-01-01T00:00:00.000Z", cancelReleases: true },
      choices: [],
      operations: [{
        id, eventKey: "retention-post", kind: "post_message", productMode: "customer_clarify",
        conversationId: "retention-conversation", availableAt: new Date(), guardEventId: "retention-event", request,
      }],
    }],
  });
  expect((await store.cleanup(new Date(Date.now() + 1_000))).conversations).toBe(0);
  expect(store.snapshot().conversationStateCount).toBe(1);
  const [leased] = await store.claimOutbox(1, 10_000, 3);
  await store.deliverOutboxFenced(leased!, async () => "delivered");
  expect((await store.cleanup(new Date(Date.now() + 1_000))).conversations).toBe(1);
  expect(store.snapshot().conversationStateCount).toBe(0);
});

it("preserves the same event's safety release across repeated processing retries", async () => {
  const store = new MemoryGatewayStore();
  await leasedDelivery(store, "delivery");
  const safety = (id: string) => ({
    id,
    eventKey: "safety-release:conversation:event",
    kind: "release_control" as const,
    productMode: "customer_clarify" as const,
    conversationId: "conversation",
    availableAt: new Date(Date.now() + 60_000),
    guardEventId: "event",
    request: releaseRequest,
  });
  await expect(store.claimEvent({
    installationId: "tenant", eventId: "event", deliveryKey: "delivery", leaseMs: 10_000,
    conversationId: "conversation", controlActivity: true, safetyRelease: safety(randomUUID()),
    eventCreatedAt: "2026-01-01T00:00:00.000Z",
  })).resolves.toBe("claimed");
  for (let retry = 0; retry < 2; retry += 1) {
    await store.releaseEvent("tenant", "event", "delivery");
    await expect(store.claimEvent({
      installationId: "tenant", eventId: "event", deliveryKey: "delivery", leaseMs: 10_000,
      conversationId: "conversation", controlActivity: true, safetyRelease: safety(randomUUID()),
      eventCreatedAt: "2026-01-01T00:00:00.000Z",
    })).resolves.toBe("claimed");
    const releases = store.snapshot().outbox.filter((item) => item.eventKey === "safety-release:conversation:event");
    expect(releases).toHaveLength(1);
    expect(releases[0]?.status).toBe("pending");
  }
  await store.stageDelivery({
    installationId: "tenant", deliveryKey: "delivery", choiceExpiresAt: new Date(Date.now() + 60_000),
    plans: [{
      eventId: "event",
      activity: { conversationId: "conversation", occurredAt: "2026-01-01T00:00:00.000Z", cancelReleases: true },
      choices: [],
      operations: [{ ...safety(randomUUID()), eventKey: "final-release:conversation:event" }],
    }],
  });
  const snapshot = store.snapshot().outbox;
  expect(snapshot.find((item) => item.eventKey === "safety-release:conversation:event")?.status).toBe("dead");
  expect(snapshot.find((item) => item.eventKey === "final-release:conversation:event")?.status).toBe("pending");
});

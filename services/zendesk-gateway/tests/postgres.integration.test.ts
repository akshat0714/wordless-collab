import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { PostgresGatewayStore } from "../src/postgres-store.js";
import { OutboxPersistenceAfterExecutionError } from "../src/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);
const { Client } = pg;

const messageRequest = {
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

integration.sequential("PostgreSQL gateway ordering", () => {
  let store: PostgresGatewayStore;
  const installations = new Set<string>();

  beforeAll(() => {
    store = new PostgresGatewayStore(databaseUrl as string);
  });

  afterAll(async () => {
    await Promise.all([...installations].map((installationId) => store.purgeInstallation(installationId)));
    await store.close();
  });

  async function delivery(): Promise<{ installationId: string; deliveryKey: string }> {
    const installationId = `test_${randomUUID().replace(/-/gu, "")}`;
    const deliveryKey = `delivery-${randomUUID()}`;
    installations.add(installationId);
    await store.claimDelivery({ installationId, deliveryKey, bodySha256: "a".repeat(64), payload: {} });
    const [claimed] = await store.claimInbox(1, 60_000, 3);
    expect(claimed).toMatchObject({ installationId, deliveryKey });
    return { installationId, deliveryKey };
  }

  it("rejects an unmigrated schema instead of reporting a network-only ping", async () => {
    const schema = `gateway_unmigrated_${randomUUID().replace(/-/gu, "")}`;
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(databaseUrl as string);
    isolatedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    const isolated = new PostgresGatewayStore(isolatedUrl.toString());
    try {
      await expect(isolated.ping()).rejects.toThrow();
    } finally {
      await isolated.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  it("does not let a future release block a later due message", async () => {
    const { installationId, deliveryKey } = await delivery();
    const first = randomUUID();
    const second = randomUUID();
    await store.stageDelivery({
      installationId,
      deliveryKey,
      choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{ eventId: null, activity: null, choices: [], operations: [
        { id: first, eventKey: "first", kind: "post_message", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(), guardEventId: null, request: messageRequest },
        { id: randomUUID(), eventKey: "future-release", kind: "release_control", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(Date.now() + 60_000), guardEventId: "event", request: releaseRequest },
        { id: second, eventKey: "second", kind: "post_message", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(), guardEventId: null, request: messageRequest },
      ] }],
    });
    const firstClaim = await store.claimOutbox(20, 60_000, 3);
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]?.id).toBe(first);
    await store.markOutboxDelivered(first);
    const secondClaim = await store.claimOutbox(20, 60_000, 3);
    expect(secondClaim).toHaveLength(1);
    expect(secondClaim[0]?.id).toBe(second);
    await store.markOutboxDelivered(second);
  });

  it("leases exactly the current release after an older release becomes ambiguous", async () => {
    const { installationId, deliveryKey } = await delivery();
    await store.claimEvent({
      installationId, eventId: "event-a", deliveryKey, leaseMs: 60_000,
      conversationId: "conversation", controlActivity: true, safetyRelease: null,
      eventCreatedAt: "2026-01-01T00:00:00.000Z",
    });
    const oldRelease = randomUUID();
    await store.stageDelivery({
      installationId, deliveryKey, choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{
        eventId: "event-a",
        activity: { conversationId: "conversation", occurredAt: "2026-01-01T00:00:00.000Z", cancelReleases: true },
        choices: [],
        operations: [{ id: oldRelease, eventKey: "old-release", kind: "release_control", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(), guardEventId: "event-a", request: releaseRequest }],
      }],
    });
    expect((await store.claimOutbox(20, 60_000, 3))[0]?.id).toBe(oldRelease);
    await store.markOutboxAmbiguous(oldRelease, "unknown_outcome");

    const nextDeliveryKey = `delivery-${randomUUID()}`;
    await store.claimDelivery({ installationId, deliveryKey: nextDeliveryKey, bodySha256: "b".repeat(64), payload: {} });
    await store.claimInbox(1, 60_000, 3);
    await store.claimEvent({
      installationId, eventId: "event-b", deliveryKey: nextDeliveryKey, leaseMs: 60_000,
      conversationId: "conversation", controlActivity: true, safetyRelease: null,
      eventCreatedAt: "2026-01-01T00:00:01.000Z",
    });
    const currentRelease = randomUUID();
    await store.stageDelivery({
      installationId, deliveryKey: nextDeliveryKey, choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{
        eventId: "event-b",
        activity: { conversationId: "conversation", occurredAt: "2026-01-01T00:00:01.000Z", cancelReleases: true },
        choices: [],
        operations: [
          { id: randomUUID(), eventKey: "ordinary", kind: "post_message", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(), guardEventId: "event-b", request: messageRequest },
          { id: currentRelease, eventKey: "current-release", kind: "release_control", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(), guardEventId: "event-b", request: releaseRequest },
        ],
      }],
    });
    const claim = await store.claimOutbox(20, 60_000, 3);
    expect(claim).toHaveLength(1);
    expect(claim[0]?.id).toBe(currentRelease);
    await expect(store.deliverOutboxFenced(claim[0]!, async () => "delivered")).resolves.toBe("delivered");
    await expect(store.claimOutbox(20, 60_000, 3)).resolves.toHaveLength(0);

    await store.cleanup(new Date(Date.now() + 1_000));
    const markers = await store.listQuarantines({ installationId, conversationId: "conversation" });
    expect(markers).toEqual([expect.objectContaining({ outboxId: oldRelease, payloadAvailable: false })]);
    await store.reconcileQuarantine({ installationId, conversationId: "conversation", outboxId: oldRelease, resolution: "delivered" });
    await expect(store.claimOutbox(20, 60_000, 3)).resolves.toHaveLength(1);
  });

  it("records an expired send lease before cleanup and preserves its quarantine marker", async () => {
    const { installationId, deliveryKey } = await delivery();
    const outboxId = randomUUID();
    await store.stageDelivery({
      installationId, deliveryKey, choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{ eventId: null, activity: null, choices: [], operations: [
        { id: outboxId, eventKey: "expired-lease", kind: "post_message", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(), guardEventId: null, request: messageRequest },
      ] }],
    });
    expect((await store.claimOutbox(1, 1, 3))[0]?.id).toBe(outboxId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(store.claimOutbox(1, 1, 3)).resolves.toHaveLength(0);
    expect(await store.listQuarantines({ installationId })).toEqual([
      expect.objectContaining({ outboxId, payloadAvailable: true }),
    ]);
    await store.cleanup(new Date(Date.now() + 1_000));
    expect(await store.listQuarantines({ installationId })).toEqual([
      expect.objectContaining({
        outboxId,
        payloadAvailable: false,
        operationKind: "post_message",
        eventKey: "expired-lease",
      }),
    ]);
  });

  it("does not quarantine a sender that commits after its lease deadline", async () => {
    const { installationId, deliveryKey } = await delivery();
    await store.claimEvent({
      installationId, eventId: "slow-event", deliveryKey, leaseMs: 60_000,
      conversationId: "slow-conversation", controlActivity: true, safetyRelease: null,
      eventCreatedAt: "2026-01-01T00:00:00.000Z",
    });
    const outboxId = randomUUID();
    await store.stageDelivery({
      installationId, deliveryKey, choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{
        eventId: "slow-event",
        activity: { conversationId: "slow-conversation", occurredAt: "2026-01-01T00:00:00.000Z", cancelReleases: true },
        choices: [],
        operations: [{
          id: outboxId, eventKey: "slow-send", kind: "post_message", productMode: "customer_clarify",
          conversationId: "slow-conversation", availableAt: new Date(), guardEventId: "slow-event", request: messageRequest,
        }],
      }],
    });
    const [leased] = await store.claimOutbox(1, 1, 3);
    let releaseSend!: () => void;
    const sendMayFinish = new Promise<void>((resolve) => { releaseSend = resolve; });
    let senderEntered!: () => void;
    const senderStarted = new Promise<void>((resolve) => { senderEntered = resolve; });
    const delivering = store.deliverOutboxFenced(leased!, async () => {
      senderEntered();
      await sendMayFinish;
      return "delivered";
    });
    await senderStarted;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reclaiming = store.claimOutbox(1, 1, 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseSend();
    await expect(delivering).resolves.toBe("delivered");
    await expect(reclaiming).resolves.toHaveLength(0);
    await expect(store.listQuarantines({ installationId, conversationId: "slow-conversation" })).resolves.toHaveLength(0);
  });

  it("classifies a post-send persistence failure as ambiguous and supports independent quarantine", async () => {
    const installationId = `test_${randomUUID().replace(/-/gu, "")}`;
    const deliveryKey = `delivery-${randomUUID()}`;
    installations.add(installationId);
    const faulted = new PostgresGatewayStore(databaseUrl as string, {
      afterFencedExternalDelivery: async () => { throw new Error("simulated commit path failure"); },
    });
    try {
      await faulted.claimDelivery({ installationId, deliveryKey, bodySha256: "f".repeat(64), payload: {} });
      await faulted.claimInbox(1, 60_000, 3);
      await faulted.claimEvent({
        installationId, eventId: "persistence-event", deliveryKey, leaseMs: 60_000,
        conversationId: "persistence-conversation", controlActivity: true, safetyRelease: null,
        eventCreatedAt: "2026-01-01T00:00:00.000Z",
      });
      const outboxId = randomUUID();
      await faulted.stageDelivery({
        installationId, deliveryKey, choiceExpiresAt: new Date(Date.now() + 60_000),
        plans: [{
          eventId: "persistence-event",
          activity: { conversationId: "persistence-conversation", occurredAt: "2026-01-01T00:00:00.000Z", cancelReleases: true },
          choices: [],
          operations: [{
            id: outboxId, eventKey: "persistence-post", kind: "post_message", productMode: "customer_clarify",
            conversationId: "persistence-conversation", availableAt: new Date(), guardEventId: "persistence-event", request: messageRequest,
          }],
        }],
      });
      const [leased] = await faulted.claimOutbox(1, 60_000, 3);
      let executed = false;
      await expect(faulted.deliverOutboxFenced(leased!, async () => {
        executed = true;
        return "delivered";
      })).rejects.toBeInstanceOf(OutboxPersistenceAfterExecutionError);
      expect(executed).toBe(true);
      await faulted.markOutboxAmbiguous(outboxId, "outbox_persistence_after_execution_error");
      await expect(faulted.listQuarantines({ installationId })).resolves.toEqual([
        expect.objectContaining({ outboxId, eventKey: "persistence-post", operationKind: "post_message" }),
      ]);
    } finally {
      await faulted.close();
    }
  });

  it("consumes exactly one operator retry grant after attempts are exhausted", async () => {
    const { installationId, deliveryKey } = await delivery();
    const outboxId = randomUUID();
    await store.stageDelivery({
      installationId, deliveryKey, choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{ eventId: null, activity: null, choices: [], operations: [
        { id: outboxId, eventKey: "operator-retry", kind: "post_message", productMode: "customer_clarify", conversationId: "conversation", availableAt: new Date(), guardEventId: null, request: messageRequest },
      ] }],
    });
    expect((await store.claimOutbox(1, 60_000, 1))[0]?.id).toBe(outboxId);
    await store.markOutboxAmbiguous(outboxId, "unknown_outcome");
    await store.reconcileQuarantine({ installationId, conversationId: "conversation", outboxId, resolution: "retry" });
    expect((await store.claimOutbox(1, 60_000, 1))[0]?.id).toBe(outboxId);
    await store.rescheduleOutbox(outboxId, new Date(), "definitive_failure", false);
    await expect(store.claimOutbox(1, 60_000, 1)).resolves.toHaveLength(0);
  });

  it("preserves one safety release when the same event is retried", async () => {
    const { installationId, deliveryKey } = await delivery();
    const safety = (id: string) => ({
      id,
      eventKey: "safety-release:conversation:event",
      kind: "release_control" as const,
      productMode: "customer_clarify" as const,
      conversationId: "conversation",
      availableAt: new Date(),
      guardEventId: "event",
      request: releaseRequest,
    });
    await expect(store.claimEvent({
      installationId, eventId: "event", deliveryKey, leaseMs: 60_000,
      conversationId: "conversation", controlActivity: true, safetyRelease: safety(randomUUID()),
      eventCreatedAt: "2026-01-01T00:00:00.000Z",
    })).resolves.toBe("claimed");
    for (let retry = 0; retry < 2; retry += 1) {
      await store.releaseEvent(installationId, "event", deliveryKey);
      await expect(store.claimEvent({
        installationId, eventId: "event", deliveryKey, leaseMs: 60_000,
        conversationId: "conversation", controlActivity: true, safetyRelease: safety(randomUUID()),
        eventCreatedAt: "2026-01-01T00:00:00.000Z",
      })).resolves.toBe("claimed");
    }
    const claimed = await store.claimOutbox(20, 60_000, 3);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.eventKey).toBe("safety-release:conversation:event");
  });

  it("fences a leased message after a newer control event advances the conversation", async () => {
    const { installationId, deliveryKey } = await delivery();
    await store.claimEvent({
      installationId, eventId: "event-a", deliveryKey, leaseMs: 60_000,
      conversationId: "conversation", controlActivity: true, safetyRelease: null,
      eventCreatedAt: "2026-01-01T00:00:00.000Z",
    });
    const postId = randomUUID();
    await store.stageDelivery({
      installationId, deliveryKey, choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{
        eventId: "event-a",
        activity: { conversationId: "conversation", occurredAt: "2026-01-01T00:00:00.000Z", cancelReleases: true },
        choices: [],
        operations: [{
          id: postId, eventKey: "post-a", kind: "post_message", productMode: "customer_clarify",
          conversationId: "conversation", availableAt: new Date(), guardEventId: "event-a", request: messageRequest,
        }],
      }],
    });
    const [leased] = await store.claimOutbox(1, 60_000, 3);
    expect(leased?.id).toBe(postId);

    const deliveryKeyB = `delivery-${randomUUID()}`;
    await store.claimDelivery({ installationId, deliveryKey: deliveryKeyB, bodySha256: "c".repeat(64), payload: {} });
    await store.claimInbox(1, 60_000, 3);
    await store.claimEvent({
      installationId, eventId: "event-b", deliveryKey: deliveryKeyB, leaseMs: 60_000,
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

  it("lets a current explicit human pass bypass an older ambiguous message", async () => {
    const { installationId, deliveryKey } = await delivery();
    const ambiguousId = randomUUID();
    await store.stageDelivery({
      installationId, deliveryKey, choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{ eventId: null, activity: null, choices: [], operations: [{
        id: ambiguousId, eventKey: "ambiguous-post", kind: "post_message", productMode: "customer_clarify",
        conversationId: "conversation", availableAt: new Date(), guardEventId: null, request: messageRequest,
      }] }],
    });
    expect((await store.claimOutbox(1, 60_000, 3))[0]?.id).toBe(ambiguousId);
    await store.markOutboxAmbiguous(ambiguousId, "unknown_outcome");

    const humanDeliveryKey = `delivery-${randomUUID()}`;
    await store.claimDelivery({ installationId, deliveryKey: humanDeliveryKey, bodySha256: "d".repeat(64), payload: {} });
    await store.claimInbox(1, 60_000, 3);
    await store.claimEvent({
      installationId, eventId: "human-event", deliveryKey: humanDeliveryKey, leaseMs: 60_000,
      conversationId: "conversation", controlActivity: true, safetyRelease: null,
      eventCreatedAt: "2026-01-01T00:00:01.000Z",
    });
    const passId = randomUUID();
    await store.stageDelivery({
      installationId, deliveryKey: humanDeliveryKey, choiceExpiresAt: new Date(Date.now() + 60_000),
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
    const [pass] = await store.claimOutbox(1, 60_000, 3);
    expect(pass?.id).toBe(passId);
    await expect(store.deliverOutboxFenced(pass!, async () => "delivered")).resolves.toBe("delivered");
  });

  it("retains conversation state for live work and removes it after safe retention", async () => {
    const { installationId, deliveryKey } = await delivery();
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    try {
    await store.claimEvent({
      installationId, eventId: "retention-event", deliveryKey, leaseMs: 60_000,
      conversationId: "retention-conversation", controlActivity: true, safetyRelease: null,
      eventCreatedAt: "2026-01-01T00:00:00.000Z",
    });
    const postId = randomUUID();
    await store.stageDelivery({
      installationId, deliveryKey, choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{
        eventId: "retention-event",
        activity: { conversationId: "retention-conversation", occurredAt: "2026-01-01T00:00:00.000Z", cancelReleases: true },
        choices: [],
        operations: [{
          id: postId, eventKey: "retention-post", kind: "post_message", productMode: "customer_clarify",
          conversationId: "retention-conversation", availableAt: new Date(), guardEventId: "retention-event", request: messageRequest,
        }],
      }],
    });
    await store.cleanup(new Date(Date.now() + 1_000));
    expect((await admin.query(
      `SELECT 1 FROM wordless_gateway_conversation_state
        WHERE installation_id = $1 AND conversation_id = 'retention-conversation'`,
      [installationId],
    )).rowCount).toBe(1);
    const [leased] = await store.claimOutbox(1, 60_000, 3);
    await store.deliverOutboxFenced(leased!, async () => "delivered");
    await store.cleanup(new Date(Date.now() + 1_000));
    expect((await admin.query(
      `SELECT 1 FROM wordless_gateway_conversation_state
        WHERE installation_id = $1 AND conversation_id = 'retention-conversation'`,
      [installationId],
    )).rowCount).toBe(0);

    const olderDeliveryKey = `delivery-${randomUUID()}`;
    await store.claimDelivery({ installationId, deliveryKey: olderDeliveryKey, bodySha256: "e".repeat(64), payload: {} });
    await store.claimInbox(1, 60_000, 3);
    await expect(store.claimEvent({
      installationId, eventId: "older-after-retention", deliveryKey: olderDeliveryKey, leaseMs: 60_000,
      conversationId: "retention-conversation", controlActivity: true, safetyRelease: null,
      eventCreatedAt: "2025-01-01T00:00:00.000Z",
    })).resolves.toBe("claimed");
    } finally {
      await admin.end();
    }
  });
});

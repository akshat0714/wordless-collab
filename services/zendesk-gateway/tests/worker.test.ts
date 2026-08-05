import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { createZendeskControlReleasePlan } from "@wordless/sdk/zendesk";

import { MemoryLogger } from "../src/logger.js";
import { AmbiguousDeliveryError, type GatewayRuntime } from "../src/runtime.js";
import { MemoryGatewayStore, OutboxPersistenceAfterExecutionError } from "../src/store.js";
import { GatewayWorker } from "../src/worker.js";
import { installation, testConfig } from "./helpers.js";

function body(marker: string): Record<string, unknown> {
  return {
    marker,
    app: { id: installation.appId },
    webhook: { id: installation.webhookId, version: "v2" },
    events: [{
      id: "same-event-123",
      type: "conversation:message",
      createdAt: new Date().toISOString(),
      payload: {
        conversation: {
          id: "conversation-123",
          activeSwitchboardIntegration: {
            id: installation.switchboardIntegrationId,
            integrationId: installation.underlyingIntegrationId,
          },
        },
        message: {
          id: "message-123",
          received: new Date().toISOString(),
          author: { type: "user", userId: "user-123" },
          content: { type: "text", text: "help" },
        },
      },
    }],
  };
}

async function accept(store: MemoryGatewayStore, deliveryKey: string, payload: unknown): Promise<void> {
  const raw = JSON.stringify(payload);
  await store.claimDelivery({
    installationId: installation.id,
    deliveryKey,
    bodySha256: createHash("sha256").update(raw).digest("hex"),
    payload,
  });
}

describe("durable worker", () => {
  it("runs resolver/inference once for the same event in different delivery bodies", async () => {
    const store = new MemoryGatewayStore();
    await accept(store, "delivery-a", body("batch-a"));
    await accept(store, "delivery-b", body("batch-b"));
    const process = vi.fn(async () => ({
      results: [{ kind: "ignored" as const, reason: "unsupported_event" as const, eventId: "same-event-123" }],
      choices: [],
      lifecycle: [],
    }));
    const runtime = { process, execute: vi.fn() } as unknown as GatewayRuntime;
    const worker = new GatewayWorker(testConfig({ outboxPollMs: 5 }), store, runtime, new MemoryLogger());
    worker.start();
    await vi.waitFor(() => expect(process).toHaveBeenCalledTimes(1), { timeout: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(process).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it("lets a later delivery complete while another legal delivery is still processing", async () => {
    const store = new MemoryGatewayStore();
    const logger = new MemoryLogger();
    const slow = body("slow-delivery") as any;
    const fast = body("fast-delivery") as any;
    fast.events[0].id = "fast-event-456";
    fast.events[0].payload.conversation.id = "fast-conversation-456";
    fast.events[0].payload.message.id = "fast-message-456";
    let releaseSlow!: () => void;
    const slowMayFinish = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let slowStarted!: () => void;
    const slowEntered = new Promise<void>((resolve) => { slowStarted = resolve; });
    const process = vi.fn(async (_installation: unknown, envelope: any) => {
      if (envelope.marker === "slow-delivery") {
        slowStarted();
        await slowMayFinish;
      }
      return {
        results: [{ kind: "ignored" as const, reason: "unsupported_event" as const, eventId: envelope.events[0].id }],
        choices: [],
        lifecycle: [],
      };
    });
    await accept(store, "slow-delivery-key", slow);
    const worker = new GatewayWorker(
      testConfig({ outboxPollMs: 5, processTimeoutMs: 10_000 }),
      store,
      { process, execute: vi.fn() } as unknown as GatewayRuntime,
      logger,
    );
    worker.start();
    await slowEntered;
    await accept(store, "fast-delivery-key", fast);
    await vi.waitFor(() => {
      expect(process.mock.calls.some((call) => (call[1] as any).marker === "fast-delivery")).toBe(true);
      expect(logger.entries.filter((entry) => entry.event === "inbox_staged")).toHaveLength(1);
    }, { timeout: 1_000 });
    releaseSlow();
    await vi.waitFor(() => expect(logger.entries.filter((entry) => entry.event === "inbox_staged")).toHaveLength(2));
    await worker.stop();
  });

  it("delivers one durable release after restart and cancels a stale release on reply", async () => {
    const store = new MemoryGatewayStore();
    const logger = new MemoryLogger();
    await accept(store, "release-delivery", {});
    await store.claimInbox(1, 10_000, 3);
    await store.claimEvent({ installationId: installation.id, eventId: "release-event-1", deliveryKey: "release-delivery", leaseMs: 10_000, conversationId: "conversation-123", controlActivity: true, safetyRelease: null, eventCreatedAt: "2026-01-01T00:00:00.000Z" });
    await store.stageDelivery({
      installationId: installation.id,
      deliveryKey: "release-delivery",
      choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{
        eventId: "release-event-1",
        activity: { conversationId: "conversation-123", occurredAt: "2026-01-01T00:00:00.000Z", cancelReleases: true },
        operations: [{
          id: randomUUID(),
          eventKey: "release:conversation-123:message-1",
          kind: "release_control",
          productMode: "customer_clarify",
          conversationId: "conversation-123",
          availableAt: new Date(Date.now() - 1),
          guardEventId: "release-event-1",
          request: {
            method: "POST",
            path: `/sc/v2/apps/${installation.appId}/conversations/conversation-123/releaseControl`,
            body: {},
          },
        }],
        choices: [],
      }],
    });
    const runtime = { process: vi.fn(), execute: vi.fn() } as unknown as GatewayRuntime;
    const restartedWorker = new GatewayWorker(testConfig({ outboxPollMs: 5 }), store, runtime, logger);
    restartedWorker.start();
    await vi.waitFor(() => expect(logger.entries.filter((entry) => entry.event === "outbox_delivered")).toHaveLength(1));
    await restartedWorker.stop();

    await accept(store, "release-delivery-2", {});
    await store.claimInbox(1, 10_000, 3);
    await store.claimEvent({ installationId: installation.id, eventId: "release-event-2", deliveryKey: "release-delivery-2", leaseMs: 10_000, conversationId: "conversation-123", controlActivity: true, safetyRelease: null, eventCreatedAt: "2026-01-01T00:00:01.000Z" });
    await store.stageDelivery({
      installationId: installation.id,
      deliveryKey: "release-delivery-2",
      choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{
        eventId: "release-event-2",
        activity: { conversationId: "conversation-123", occurredAt: "2026-01-01T00:00:01.000Z", cancelReleases: true },
        operations: [{
          id: randomUUID(),
          eventKey: "release:conversation-123:message-2",
          kind: "release_control",
          productMode: "customer_clarify",
          conversationId: "conversation-123",
          availableAt: new Date(),
          guardEventId: "release-event-2",
          request: {
            method: "POST",
            path: `/sc/v2/apps/${installation.appId}/conversations/conversation-123/releaseControl`,
            body: {},
          },
        }],
        choices: [],
      }],
    });
    await accept(store, "reply-delivery", {});
    await store.claimInbox(1, 10_000, 3);
    await store.claimEvent({ installationId: installation.id, eventId: "reply-event", deliveryKey: "reply-delivery", leaseMs: 10_000, conversationId: "conversation-123", controlActivity: true, safetyRelease: null, eventCreatedAt: "2026-01-01T00:00:02.000Z" });
    await store.stageDelivery({
      installationId: installation.id,
      deliveryKey: "reply-delivery",
      choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{
        eventId: "reply-event",
        activity: { conversationId: "conversation-123", occurredAt: "2026-01-01T00:00:02.000Z", cancelReleases: true },
        operations: [],
        choices: [],
      }],
    });
    await expect(store.claimOutbox(10, 1_000, 3)).resolves.toHaveLength(0);
  });

  it("rejects malformed, far-future, wrong-installation, and oversized batches before runtime or control state", async () => {
    const base = body("strict") as any;
    const malformed = structuredClone(base);
    malformed.events[0].createdAt = "not-a-timestamp";
    const future = structuredClone(base);
    future.events[0].createdAt = new Date(Date.now() + 3_600_000).toISOString();
    future.events[0].payload.message.received = future.events[0].createdAt;
    const wrongApp = structuredClone(base);
    wrongApp.app.id = "wrong-app";
    const oversized = structuredClone(base);
    oversized.events = Array.from({ length: 101 }, (_, index) => ({ id: `event-${index}` }));

    for (const [index, payload] of [malformed, future, wrongApp, oversized].entries()) {
      const store = new MemoryGatewayStore();
      const logger = new MemoryLogger();
      await accept(store, `invalid-delivery-${index}`, payload);
      const process = vi.fn();
      const worker = new GatewayWorker(
        testConfig({ outboxPollMs: 5 }),
        store,
        { process, execute: vi.fn() } as unknown as GatewayRuntime,
        logger,
      );
      worker.start();
      await vi.waitFor(() => expect(logger.entries.some((entry) => entry.event === "inbox_dead")).toBe(true));
      await worker.stop();
      expect(process).not.toHaveBeenCalled();
      expect(store.snapshot()).toMatchObject({ outbox: [], conversationStateCount: 0 });
    }
  });

  it("bounds batch processing to eight conversations and serializes each conversation", async () => {
    const template = body("bounded") as any;
    const now = Date.now() - 1_000;
    template.events = Array.from({ length: 40 }, (_, index) => {
      const event = structuredClone((body(`bounded-${index}`) as any).events[0]);
      event.id = `bounded-event-${index}`;
      event.createdAt = new Date(now + index).toISOString();
      event.payload.conversation.id = `conversation-${index % 20}`;
      event.payload.message.id = `message-${index}`;
      event.payload.message.received = event.createdAt;
      return event;
    });
    const store = new MemoryGatewayStore();
    const logger = new MemoryLogger();
    await accept(store, "bounded-delivery", template);
    let active = 0;
    let maximum = 0;
    const perConversation = new Map<string, number>();
    const process = vi.fn(async (_installation: unknown, envelope: any) => {
      const conversationId = envelope.events[0].payload.conversation.id as string;
      active += 1;
      maximum = Math.max(maximum, active);
      const sameConversation = (perConversation.get(conversationId) ?? 0) + 1;
      perConversation.set(conversationId, sameConversation);
      expect(sameConversation).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      perConversation.set(conversationId, sameConversation - 1);
      active -= 1;
      return { results: [{ kind: "ignored" as const, reason: "unsupported_event" as const, eventId: envelope.events[0].id }], choices: [], lifecycle: [] };
    });
    const worker = new GatewayWorker(testConfig({ outboxPollMs: 5 }), store, { process, execute: vi.fn() } as unknown as GatewayRuntime, logger);
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(
      logger.entries.some((entry) => entry.event === "inbox_staged"),
      JSON.stringify(logger.entries),
    ).toBe(true);
    await worker.stop();
    expect(process).toHaveBeenCalledTimes(40);
    expect(maximum).toBeLessThanOrEqual(8);
  });

  it("leases and executes at most four outbound conversations concurrently", async () => {
    const store = new MemoryGatewayStore();
    const logger = new MemoryLogger();
    await accept(store, "outbox-bounded-delivery", {});
    await store.claimInbox(1, 10_000, 3);
    await store.stageDelivery({
      installationId: installation.id,
      deliveryKey: "outbox-bounded-delivery",
      choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{
        eventId: null,
        activity: null,
        choices: [],
        operations: Array.from({ length: 12 }, (_, index) => ({
          id: randomUUID(),
          eventKey: `bounded-outbox-${index}`,
          kind: "post_message" as const,
          productMode: "customer_clarify" as const,
          conversationId: `bounded-conversation-${index}`,
          availableAt: new Date(),
          guardEventId: null,
          request: {
            method: "POST" as const,
            path: `/sc/v2/apps/${installation.appId}/conversations/bounded-conversation-${index}/messages`,
            body: {
              author: { type: "business" as const },
              content: { type: "text" as const, text: "Safe reply", blockChatInput: false as const },
            },
          },
        })),
      }],
    });
    let active = 0;
    let maximum = 0;
    const execute = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return "delivered" as const;
    });
    const worker = new GatewayWorker(
      testConfig({ outboxPollMs: 5, deliveryMode: "zendesk" }),
      store,
      { process: vi.fn(), execute } as unknown as GatewayRuntime,
      logger,
    );
    worker.start();
    await vi.waitFor(
      () => expect(logger.entries.filter((entry) => entry.event === "outbox_delivered")).toHaveLength(12),
      { timeout: 2_000 },
    );
    await worker.stop();
    expect(maximum).toBeLessThanOrEqual(4);
    expect(execute).toHaveBeenCalledTimes(12);
  });

  it("persists lifecycle greeting and every active control deadline, including directive none", async () => {
    for (const directive of ["greet", "none"] as const) {
      const createdAt = new Date().toISOString();
      const payload = {
        app: { id: installation.appId },
        webhook: { id: installation.webhookId, version: "v2" },
        events: [{
          id: `lifecycle-${directive}`,
          type: "conversation:create",
          createdAt,
          payload: {
            creationReason: directive === "greet" ? "startConversation" : "unknown",
            conversation: {
              id: `conversation-${directive}`,
              activeSwitchboardIntegration: {
                id: installation.switchboardIntegrationId,
                integrationId: installation.underlyingIntegrationId,
              },
            },
          },
        }],
      };
      const releasePlan = createZendeskControlReleasePlan({
        appId: installation.appId,
        conversationId: `conversation-${directive}`,
        acquiredAt: createdAt,
        releaseAfterMs: 120_000,
      });
      const store = new MemoryGatewayStore();
      const logger = new MemoryLogger();
      await accept(store, `lifecycle-delivery-${directive}`, payload);
      const process = vi.fn(async () => ({
        results: [{ kind: "ignored" as const, reason: "unsupported_event" as const, eventId: `lifecycle-${directive}` }],
        choices: [],
        lifecycle: [{
          kind: "conversation_create" as const,
          appId: installation.appId,
          webhookId: installation.webhookId,
          eventId: `lifecycle-${directive}`,
          eventCreatedAt: createdAt,
          conversationId: `conversation-${directive}`,
          activeSwitchboardIntegration: null,
          previousActiveSwitchboardIntegration: null,
          configuredIntegrationActive: true,
          directive,
          releasePlan,
          creationReason: directive === "greet" ? "startConversation" : "unknown",
        }],
      }));
      const worker = new GatewayWorker(testConfig({ outboxPollMs: 5 }), store, { process, execute: vi.fn() } as unknown as GatewayRuntime, logger);
      worker.start();
      await vi.waitFor(() => expect(logger.entries.some((entry) => entry.event === "inbox_staged")).toBe(true));
      await worker.stop();
      const live = store.snapshot().outbox.filter((item) => item.status !== "dead");
      expect(live.some((item) => item.kind === "release_control")).toBe(true);
      expect(live.some((item) => item.kind === "post_message")).toBe(directive === "greet");
      if (directive === "greet") {
        const greeting = live.find((item) => item.kind === "post_message");
        expect((greeting?.request.body as any).content.actions).toHaveLength(2);
      }
    }
  });

  it.each([
    ["conversation:create", true, true],
    ["conversation:referral", true, true],
    ["switchboard:passControl", true, true],
    ["switchboard:releaseControl", true, false],
    ["switchboard:passControl", false, false],
  ] as const)("persists claim-time control safety for %s (active=%s)", async (type, active, expectedSafety) => {
    const createdAt = new Date().toISOString();
    const eventId = `safety-${type.replace(/:/gu, "-")}-${active}`;
    const payload = {
      app: { id: installation.appId },
      webhook: { id: installation.webhookId, version: "v2" },
      events: [{
        id: eventId,
        type,
        createdAt,
        payload: {
          ...(type === "conversation:create" ? { creationReason: "startConversation" } : {}),
          conversation: {
            id: `conversation-${eventId}`,
            activeSwitchboardIntegration: {
              id: active ? installation.switchboardIntegrationId : "other-switchboard",
              integrationId: active ? installation.underlyingIntegrationId : "other-integration",
            },
          },
        },
      }],
    };
    const store = new MemoryGatewayStore();
    const logger = new MemoryLogger();
    await accept(store, `delivery-${eventId}`, payload);
    const process = vi.fn().mockRejectedValue(new Error("runtime unavailable"));
    const worker = new GatewayWorker(
      testConfig({ outboxPollMs: 5, outboxMaxAttempts: 1 }),
      store,
      { process, execute: vi.fn() } as unknown as GatewayRuntime,
      logger,
    );
    worker.start();
    await vi.waitFor(() => expect(logger.entries.some((entry) => entry.event === "inbox_dead")).toBe(true));
    await worker.stop();
    const safety = store.snapshot().outbox.filter((item) => item.eventKey === `safety-release:conversation-${eventId}:${eventId}`);
    expect(safety).toHaveLength(expectedSafety ? 1 : 0);
    if (expectedSafety) expect(safety[0]?.status).toBe("pending");
  });

  it("releases earlier event claims when a later claim fails so the immediate retry can complete", async () => {
    const payload = body("claim-retry") as any;
    const second = structuredClone(payload.events[0]);
    second.id = "second-event-456";
    second.createdAt = new Date(Date.parse(second.createdAt) + 1).toISOString();
    second.payload.message.id = "second-message-456";
    second.payload.message.received = second.createdAt;
    payload.events.push(second);

    class FlakyClaimStore extends MemoryGatewayStore {
      private claimCalls = 0;

      override async claimEvent(input: Parameters<MemoryGatewayStore["claimEvent"]>[0]) {
        this.claimCalls += 1;
        if (this.claimCalls === 2) throw new Error("transient claim failure");
        return super.claimEvent(input);
      }
    }

    const store = new FlakyClaimStore();
    const logger = new MemoryLogger();
    await accept(store, "claim-retry-delivery", payload);
    const process = vi.fn(async (_installation: unknown, envelope: any) => ({
      results: [{ kind: "ignored" as const, reason: "unsupported_event" as const, eventId: envelope.events[0].id }],
      choices: [],
      lifecycle: [],
    }));
    const worker = new GatewayWorker(
      testConfig({ outboxPollMs: 5, processTimeoutMs: 5_000 }),
      store,
      { process, execute: vi.fn() } as unknown as GatewayRuntime,
      logger,
    );
    worker.start();
    await vi.waitFor(
      () => expect(logger.entries.some((entry) => entry.event === "inbox_staged")).toBe(true),
      { timeout: 2_500 },
    );
    await worker.stop();
    expect(process).toHaveBeenCalledTimes(2);
    expect(logger.entries.some((entry) => entry.event === "inbox_retry")).toBe(true);
  });

  it.each([
    ["definitive", new Error("definitive pass failure"), "outbox_dead", "dead"],
    ["ambiguous", new AmbiguousDeliveryError(), "outbox_ambiguous", "ambiguous"],
  ] as const)("keeps a guarded release deadline when a pass-control delivery is %s", async (_label, failure, logEvent, passStatus) => {
    const payload = body("failed-pass") as any;
    const event = payload.events[0];
    const store = new MemoryGatewayStore();
    const logger = new MemoryLogger();
    await accept(store, "failed-pass-delivery", payload);
    const process = vi.fn(async () => ({
      results: [{
        kind: "pass_control" as const,
        incoming: {
          appId: installation.appId,
          webhookId: installation.webhookId,
          eventId: event.id,
          eventCreatedAt: event.createdAt,
          conversationId: event.payload.conversation.id,
          messageId: event.payload.message.id,
          receivedAt: event.payload.message.received,
          userId: event.payload.message.author.userId,
          sourceType: "web",
          sourceIntegrationId: null,
          activeSwitchboardIntegrationId: installation.switchboardIntegrationId,
          activeIntegrationId: installation.underlyingIntegrationId,
          contentType: "text",
          text: "help",
          payload: null,
        },
        deduplicationKey: event.id,
        request: {
          method: "POST" as const,
          path: `/sc/v2/apps/${installation.appId}/conversations/${event.payload.conversation.id}/passControl`,
          body: {
            switchboardIntegration: "next",
            metadata: { first_message_id: event.payload.message.id, handoff_reason: "evidence_unavailable" },
          },
        },
        handoff: {
          target: "next" as const,
          reason: "evidence_unavailable" as const,
          firstMessageId: event.payload.message.id,
          suggestionId: null,
          confirmedChoice: null,
        },
        wordless: null,
        pendingChoices: null,
      }],
      choices: [],
      lifecycle: [],
    }));
    const execute = vi.fn().mockRejectedValue(failure);
    const worker = new GatewayWorker(
      testConfig({ outboxPollMs: 5, deliveryMode: "zendesk", outboxMaxAttempts: 1 }),
      store,
      { process, execute } as unknown as GatewayRuntime,
      logger,
    );
    worker.start();
    await vi.waitFor(() => expect(logger.entries.some((entry) => entry.event === logEvent)).toBe(true));
    await worker.stop();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.snapshot().outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "pass_control", status: passStatus }),
      expect.objectContaining({
        eventKey: `pass-safety-release:${event.payload.conversation.id}:${event.id}`,
        kind: "release_control",
        status: "pending",
      }),
    ]));
  });

  it("quarantines an externally delivered operation when durable recording fails", async () => {
    class PostSendFailureStore extends MemoryGatewayStore {
      override async deliverOutboxFenced(
        _item: Parameters<MemoryGatewayStore["deliverOutboxFenced"]>[0],
        execute: Parameters<MemoryGatewayStore["deliverOutboxFenced"]>[1],
      ): Promise<never> {
        await execute();
        throw new OutboxPersistenceAfterExecutionError({ cause: new Error("store write failed") });
      }
    }
    const store = new PostSendFailureStore();
    const logger = new MemoryLogger();
    await accept(store, "post-send-failure-delivery", {});
    await store.claimInbox(1, 10_000, 3);
    await store.claimEvent({
      installationId: installation.id, eventId: "post-send-event", deliveryKey: "post-send-failure-delivery", leaseMs: 10_000,
      conversationId: "conversation-123", controlActivity: true, safetyRelease: null,
      eventCreatedAt: "2026-01-01T00:00:00.000Z",
    });
    const id = randomUUID();
    await store.stageDelivery({
      installationId: installation.id,
      deliveryKey: "post-send-failure-delivery",
      choiceExpiresAt: new Date(Date.now() + 60_000),
      plans: [{
        eventId: "post-send-event",
        activity: { conversationId: "conversation-123", occurredAt: "2026-01-01T00:00:00.000Z", cancelReleases: true },
        choices: [],
        operations: [{
          id, eventKey: "post-send-failure", kind: "post_message", productMode: "customer_clarify",
          conversationId: "conversation-123", availableAt: new Date(), guardEventId: "post-send-event",
          request: {
            method: "POST",
            path: `/sc/v2/apps/${installation.appId}/conversations/conversation-123/messages`,
            body: {
              author: { type: "business" },
              content: { type: "text", text: "Safe reply", blockChatInput: false },
              metadata: { wordless_delivery_key: "post-send-failure" },
            },
          },
        }],
      }],
    });
    const execute = vi.fn().mockResolvedValue("delivered");
    const worker = new GatewayWorker(
      testConfig({ outboxPollMs: 5, deliveryMode: "zendesk" }),
      store,
      { process: vi.fn(), execute } as unknown as GatewayRuntime,
      logger,
    );
    worker.start();
    await vi.waitFor(() => expect(logger.entries.some((entry) => entry.event === "outbox_ambiguous")).toBe(true));
    await worker.stop();
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(store.listQuarantines()).resolves.toEqual([
      expect.objectContaining({ outboxId: id, eventKey: "post-send-failure" }),
    ]);
  });

  it("does not infer or extend control for a delayed message beyond its release window", async () => {
    const payload = body("delayed") as any;
    const createdAt = new Date(Date.now() - 24 * 3_600_000).toISOString();
    payload.events[0].createdAt = createdAt;
    payload.events[0].payload.message.received = createdAt;
    const store = new MemoryGatewayStore();
    const logger = new MemoryLogger();
    await accept(store, "delayed-delivery", payload);
    const process = vi.fn();
    const worker = new GatewayWorker(testConfig({ outboxPollMs: 5 }), store, { process, execute: vi.fn() } as unknown as GatewayRuntime, logger);
    worker.start();
    await vi.waitFor(() => expect(logger.entries.some((entry) => entry.event === "outbox_delivered")).toBe(true));
    await worker.stop();
    expect(process).not.toHaveBeenCalled();
    expect(store.snapshot().outbox.some((item) => item.kind === "post_message")).toBe(false);
  });
});

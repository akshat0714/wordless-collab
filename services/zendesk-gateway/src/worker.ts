import { randomUUID } from "node:crypto";

import {
  createZendeskControlReleasePlan,
  createZendeskCompositionHelpMessage,
  ZendeskApiError,
  ZendeskWebhookValidationError,
} from "@wordless/sdk/zendesk";

import { safeErrorCode, type Logger } from "./logger.js";
import { AmbiguousDeliveryError, OwnershipCheckError, splitWebhookEvents, type GatewayRuntime } from "./runtime.js";
import { OutboxPersistenceAfterExecutionError, type GatewayStore } from "./store.js";
import type { GatewayConfig, InboxItem, StageEventPlan, StagedOperation } from "./types.js";

class ProcessingTimeoutError extends Error {
  constructor() {
    super("Webhook processing exceeded its deadline.");
    this.name = "ProcessingTimeoutError";
  }
}

class EventBusyError extends Error {
  constructor() {
    super("A duplicate event is currently being processed.");
    this.name = "EventBusyError";
  }
}

const PROCESS_CONCURRENCY = 8;
const INBOX_CONCURRENCY = 4;
const OUTBOX_CONCURRENCY = 4;

async function processByConversation<T extends { readonly eventId: string; readonly conversationId: string | null }, R>(
  values: readonly T[],
  process: (value: T) => Promise<R>,
): Promise<ReadonlyMap<string, R>> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = value.conversationId === null ? `event:${value.eventId}` : `conversation:${value.conversationId}`;
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  const queue = [...groups.values()];
  const output = new Map<string, R>();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(PROCESS_CONCURRENCY, queue.length) }, async () => {
    while (cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      const group = queue[index];
      if (group === undefined) continue;
      for (const value of group) output.set(value.eventId, await process(value));
    }
  }));
  return output;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProcessingTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class GatewayWorker {
  private readonly controller = new AbortController();
  private running: Promise<void> | null = null;
  private processSlots = PROCESS_CONCURRENCY;
  private readonly processWaiters: Array<() => void> = [];

  constructor(
    private readonly config: GatewayConfig,
    private readonly store: GatewayStore,
    private readonly runtime: GatewayRuntime,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running === null) {
      this.running = Promise.all([
        ...Array.from({ length: INBOX_CONCURRENCY }, () => this.inboxLoop()),
        this.outboxLoop(),
        this.cleanupLoop(),
      ]).then(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.running;
  }

  private async withProcessSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.processSlots === 0) {
      await new Promise<void>((resolve) => this.processWaiters.push(resolve));
    } else {
      this.processSlots -= 1;
    }
    try {
      return await operation();
    } finally {
      const waiter = this.processWaiters.shift();
      if (waiter === undefined) this.processSlots += 1;
      else waiter();
    }
  }

  private async inboxLoop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      try {
        const inboxLeaseMs = Math.max(this.config.outboxLeaseMs, this.config.processTimeoutMs * 2);
        const items = await this.store.claimInbox(1, inboxLeaseMs, this.config.outboxMaxAttempts);
        if (items.length === 0) {
          await delay(this.config.outboxPollMs, this.controller.signal);
          continue;
        }
        await Promise.all(items.map((item) => this.processInbox(item)));
      } catch (error) {
        this.logger.log("error", "inbox_poll_failed", { error_code: safeErrorCode(error) });
        await delay(this.config.outboxPollMs, this.controller.signal);
      }
    }
  }

  private async processInbox(item: InboxItem): Promise<void> {
    const installation = this.config.installations.get(item.installationId);
    try {
      if (installation === undefined) throw new Error("Installation is no longer configured.");
      // Strict SDK parsing and the 100-event cap happen before any event/control mutation.
      const parts = splitWebhookEvents(
        item.payload,
        installation,
        this.config.webhookClockSkewSeconds * 1_000,
      );
      // A single conversation is intentionally serialized, so reserve for the worst-case
      // number of per-event deadlines in this bounded batch before claiming any event.
      const processingLeaseMs = Math.max(
        this.config.outboxLeaseMs,
        this.config.processTimeoutMs * (parts.length + 2),
      );
      if (!await this.store.renewDelivery(item.installationId, item.deliveryKey, processingLeaseMs)) {
        throw new Error("Inbox delivery lease was lost.");
      }
      const locallySeen = new Set<string>();
      const claimed: Array<{
        envelope: unknown;
        eventId: string;
        conversationId: string | null;
        eventCreatedAt: string;
        customerActivity: boolean;
        suppress: boolean;
      }> = [];
      try {
        for (const part of parts) {
          if (locallySeen.has(part.eventId)) continue;
          locallySeen.add(part.eventId);
          const customerActivity = part.customerActivity && part.configuredIntegrationActive;
          const lifecycleControlAcquisition = part.configuredIntegrationActive && part.conversationId !== null && (
            part.eventType === "conversation:create" ||
            part.eventType === "conversation:referral" ||
            part.eventType === "switchboard:passControl"
          );
          const controlActivity = customerActivity || lifecycleControlAcquisition;
          const controlDeadline = Date.parse(part.eventCreatedAt) + this.config.choiceTtlHours * 3_600_000;
          const controlWindowExpired = controlActivity && controlDeadline <= Date.now() + 60_000;
          const safetyPlan = controlActivity && part.conversationId !== null
            ? createZendeskControlReleasePlan({
                appId: installation.appId,
                conversationId: part.conversationId,
                acquiredAt: part.eventCreatedAt,
                releaseAfterMs: this.config.choiceTtlHours * 3_600_000,
                metadata: {
                  wordless_release_key: part.eventId,
                  wordless_product_mode: this.config.productMode,
                },
              })
            : null;
          const eventClaim = await this.store.claimEvent({
            installationId: item.installationId,
            eventId: part.eventId,
            deliveryKey: item.deliveryKey,
            leaseMs: processingLeaseMs,
            conversationId: part.conversationId,
            controlActivity,
            safetyRelease: safetyPlan === null ? null : {
              id: randomUUID(),
              eventKey: `safety-release:${part.conversationId}:${part.eventId}`,
              kind: "release_control",
              productMode: this.config.productMode,
              conversationId: part.conversationId as string,
              availableAt: new Date(safetyPlan.releaseNoLaterThan),
              guardEventId: part.eventId,
              request: safetyPlan.request,
            },
            eventCreatedAt: part.eventCreatedAt,
          });
          if (eventClaim === "busy") throw new EventBusyError();
          if (eventClaim === "claimed" || eventClaim === "stale") claimed.push({
            envelope: part.envelope,
            eventId: part.eventId,
            conversationId: part.conversationId,
            eventCreatedAt: part.eventCreatedAt,
            customerActivity: eventClaim === "claimed" && customerActivity && !controlWindowExpired,
            suppress: eventClaim === "stale" || controlWindowExpired,
          });
        }
        const plans: StageEventPlan[] = [];
        const renewed = await this.store.renewDelivery(
          item.installationId,
          item.deliveryKey,
          processingLeaseMs,
        );
        if (!renewed) throw new Error("Inbox delivery lease was lost.");
        const activeParts = claimed.filter((part) => !part.suppress);
        const batches = await processByConversation(activeParts, (part) =>
          this.withProcessSlot(() => deadline(
            this.runtime.process(installation, part.envelope),
            this.config.processTimeoutMs,
          )));
        for (const part of claimed) {
          const processed = batches.get(part.eventId);
          if (processed === undefined) {
            plans.push({ eventId: part.eventId, activity: null, operations: [], choices: [] });
            continue;
          }
          const operations: StagedOperation[] = [];
          let activity: StageEventPlan["activity"] = part.customerActivity && part.conversationId !== null
            ? {
                conversationId: part.conversationId,
                occurredAt: part.eventCreatedAt,
                cancelReleases: true,
              }
            : null;
          for (const result of processed.results) {
            if (result.kind === "ignored") continue;
            operations.push({
              id: randomUUID(),
              eventKey: result.deduplicationKey,
              kind: result.kind,
              productMode: this.config.productMode,
              conversationId: result.incoming.conversationId,
              availableAt: new Date(),
              guardEventId: part.eventId,
              request: result.request,
            });
            if (result.kind === "post_message" || result.kind === "pass_control") {
              const pending = result.pendingChoices;
              const acquiredAt = pending?.issuedAt ?? part.eventCreatedAt;
              const releaseAfterMs = pending === null
                ? this.config.choiceTtlHours * 3_600_000
                : Math.max(60_000, Date.parse(pending.expiresAt) - Date.parse(pending.issuedAt));
              const plan = createZendeskControlReleasePlan({
                appId: result.incoming.appId,
                conversationId: result.incoming.conversationId,
                acquiredAt,
                releaseAfterMs,
                metadata: {
                  wordless_release_key: result.incoming.messageId,
                  wordless_product_mode: this.config.productMode,
                },
              });
              operations.push({
                id: randomUUID(),
                eventKey: `${result.kind === "pass_control" ? "pass-safety-release" : "release"}:${result.incoming.conversationId}:${result.incoming.eventId}`,
                kind: "release_control",
                productMode: this.config.productMode,
                conversationId: result.incoming.conversationId,
                availableAt: new Date(Math.min(
                  Date.parse(pending?.expiresAt ?? plan.releaseNoLaterThan),
                  Date.parse(part.eventCreatedAt) + this.config.choiceTtlHours * 3_600_000,
                )),
                guardEventId: result.incoming.eventId,
                request: plan.request,
              });
            }
          }
          for (const lifecycle of processed.lifecycle) {
            if (lifecycle.kind === "ignored") continue;
            // An active control lease always gets a deadline, even when no greeting is appropriate.
            if (lifecycle.directive === "none" && lifecycle.releasePlan === null) continue;
            activity = {
              conversationId: lifecycle.conversationId,
              occurredAt: lifecycle.eventCreatedAt,
              cancelReleases: true,
            };
            const lifecycleDeadlineExpired = lifecycle.releasePlan !== null &&
              Date.parse(lifecycle.releasePlan.releaseNoLaterThan) <= Date.now() + 60_000;
            if (lifecycle.directive === "greet" && !lifecycleDeadlineExpired) {
              const help = createZendeskCompositionHelpMessage();
              operations.push({
                id: randomUUID(),
                eventKey: `greet:${lifecycle.eventId}`,
                kind: "post_message",
                productMode: this.config.productMode,
                conversationId: lifecycle.conversationId,
                availableAt: new Date(),
                guardEventId: lifecycle.eventId,
                request: {
                  method: "POST",
                  path: `/sc/v2/apps/${encodeURIComponent(lifecycle.appId)}/conversations/${encodeURIComponent(lifecycle.conversationId)}/messages`,
                  body: {
                    ...help,
                    metadata: { wordless_delivery_key: `greet:${lifecycle.eventId}` },
                  },
                },
              });
            }
            if (lifecycle.releasePlan !== null) {
              operations.push({
                id: randomUUID(),
                eventKey: `lifecycle-release:${lifecycle.conversationId}:${lifecycle.eventId}`,
                kind: "release_control",
                productMode: this.config.productMode,
                conversationId: lifecycle.conversationId,
                availableAt: new Date(lifecycle.releasePlan.releaseNoLaterThan),
                guardEventId: lifecycle.eventId,
                request: lifecycle.releasePlan.request,
              });
            }
          }
          plans.push({
            eventId: part.eventId,
            activity,
            operations,
            choices: [...processed.choices],
          });
        }
        const queued = await this.store.stageDelivery({
          installationId: item.installationId,
          deliveryKey: item.deliveryKey,
          choiceExpiresAt: new Date(Date.now() + this.config.choiceTtlHours * 3_600_000),
          plans,
        });
        this.logger.log("info", "inbox_staged", {
          installation_id: item.installationId,
          product_mode: this.config.productMode,
          count: queued,
          attempt: item.attemptCount,
        });
      } catch (error) {
        // A later claim/runtime/stage failure must not strand earlier event leases.
        // stageDelivery completes them atomically on success, so this runs only pre-commit.
        await Promise.allSettled(claimed.map((entry) =>
          this.store.releaseEvent(item.installationId, entry.eventId, item.deliveryKey)));
        throw error;
      }
    } catch (error) {
      const terminal = installation === undefined || error instanceof ZendeskWebhookValidationError || item.attemptCount >= this.config.outboxMaxAttempts;
      const backoffMs = Math.min(300_000, 500 * (2 ** Math.min(item.attemptCount - 1, 10)));
      const errorCode = safeErrorCode(error);
      await this.store.rescheduleDelivery(
        item.installationId,
        item.deliveryKey,
        new Date(Date.now() + backoffMs),
        errorCode,
        terminal,
      );
      this.logger.log(terminal ? "error" : "warn", terminal ? "inbox_dead" : "inbox_retry", {
        installation_id: item.installationId,
        product_mode: this.config.productMode,
        attempt: item.attemptCount,
        error_code: errorCode,
      });
    }
  }

  private async outboxLoop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      try {
        // Guarded delivery holds one PostgreSQL connection across the ownership check
        // and send. Keep ample pool headroom for ingress, claims, and readiness.
        const items = await this.store.claimOutbox(
          OUTBOX_CONCURRENCY,
          this.config.outboxLeaseMs,
          this.config.outboxMaxAttempts,
        );
        if (items.length === 0) {
          await delay(this.config.outboxPollMs, this.controller.signal);
          continue;
        }
        await Promise.all(items.map(async (item) => {
          const installation = this.config.installations.get(item.installationId);
          try {
            if (installation === undefined) throw new Error("Installation is no longer configured.");
            let outcome: "delivered" | "ownership_lost" = "delivered";
            if (item.guardEventId !== null) {
              const fenced = await this.store.deliverOutboxFenced(item, async () => {
                if (this.config.deliveryMode === "zendesk") {
                  return this.runtime.execute(installation, item.request, this.controller.signal);
                }
                this.logger.log("info", "outbox_demo_delivery", {
                  installation_id: item.installationId,
                  product_mode: item.productMode,
                  operation_kind: item.kind,
                  attempt: item.attemptCount,
                });
                return "delivered";
              });
              if (fenced === "stale") {
                this.logger.log("info", "outbox_guard_stale", {
                  installation_id: item.installationId,
                  product_mode: item.productMode,
                  operation_kind: item.kind,
                  attempt: item.attemptCount,
                });
                return;
              }
              outcome = fenced;
            } else if (this.config.deliveryMode === "zendesk") {
              outcome = await this.runtime.execute(installation, item.request, this.controller.signal);
            } else {
              this.logger.log("info", "outbox_demo_delivery", {
                installation_id: item.installationId,
                product_mode: item.productMode,
                operation_kind: item.kind,
                attempt: item.attemptCount,
              });
            }
            if (item.guardEventId === null) {
              try {
                await this.store.markOutboxDelivered(item.id);
              } catch (error) {
                if (outcome === "delivered" && this.config.deliveryMode === "zendesk") {
                  throw new OutboxPersistenceAfterExecutionError({ cause: error });
                }
                throw error;
              }
            }
            this.logger.log("info", outcome === "ownership_lost" ? "outbox_ownership_lost" : "outbox_delivered", {
              installation_id: item.installationId,
              product_mode: item.productMode,
              operation_kind: item.kind,
              attempt: item.attemptCount,
            });
          } catch (error) {
            const errorCode = safeErrorCode(error);
            if (error instanceof AmbiguousDeliveryError || error instanceof OutboxPersistenceAfterExecutionError) {
              await this.store.markOutboxAmbiguous(item.id, errorCode);
              this.logger.log("error", "outbox_ambiguous", {
                installation_id: item.installationId,
                product_mode: item.productMode,
                operation_kind: item.kind,
                attempt: item.attemptCount,
                error_code: errorCode,
              });
              return;
            }
            const retryable = error instanceof OwnershipCheckError || error instanceof ZendeskApiError && error.status === 429;
            const terminal = installation === undefined || !retryable || item.attemptCount >= this.config.outboxMaxAttempts;
            const backoffMs = Math.min(300_000, 500 * (2 ** Math.min(item.attemptCount - 1, 10)));
            await this.store.rescheduleOutbox(item.id, new Date(Date.now() + backoffMs), errorCode, terminal);
            this.logger.log(terminal ? "error" : "warn", terminal ? "outbox_dead" : "outbox_retry", {
              installation_id: item.installationId,
              product_mode: item.productMode,
              operation_kind: item.kind,
              attempt: item.attemptCount,
              error_code: errorCode,
            });
          }
        }));
      } catch (error) {
        this.logger.log("error", "outbox_poll_failed", { error_code: safeErrorCode(error) });
        await delay(this.config.outboxPollMs, this.controller.signal);
      }
    }
  }

  private async cleanupLoop(): Promise<void> {
    while (!this.controller.signal.aborted) {
      await delay(this.config.cleanupIntervalMs, this.controller.signal);
      if (this.controller.signal.aborted) return;
      try {
        const before = new Date(Date.now() - this.config.retentionDays * 86_400_000);
        const counts = await this.store.cleanup(before);
        this.logger.log("info", "retention_cleanup", {
          count: counts.inbox + counts.outbox + counts.choices + counts.events + counts.conversations,
        });
      } catch (error) {
        this.logger.log("error", "retention_cleanup_failed", { error_code: safeErrorCode(error) });
      }
    }
  }
}

import type { ZendeskPendingChoiceSet, ZendeskResolvedChoice } from "@wordless/sdk/zendesk";

import type {
  ChoiceResolutionInput,
  ClaimResult,
  DeliveryClaim,
  InboxItem,
  OutboxItem,
  StageDeliveryInput,
  StagedOperation,
  CleanupCounts,
  EventClaimResult,
  EventClaimInput,
  QuarantineResolutionInput,
  QuarantineRecord,
} from "./types.js";

export interface GatewayStore {
  ping(): Promise<void>;
  claimDelivery(input: DeliveryClaim): Promise<ClaimResult>;
  claimInbox(limit: number, leaseMs: number, maxAttempts: number): Promise<readonly InboxItem[]>;
  renewDelivery(installationId: string, deliveryKey: string, leaseMs: number): Promise<boolean>;
  claimEvent(input: EventClaimInput): Promise<EventClaimResult>;
  releaseEvent(installationId: string, eventId: string, deliveryKey: string): Promise<void>;
  stageDelivery(input: StageDeliveryInput): Promise<number>;
  rescheduleDelivery(installationId: string, deliveryKey: string, nextAttemptAt: Date, errorCode: string, terminal: boolean): Promise<void>;
  saveChoices(installationId: string, values: readonly ZendeskPendingChoiceSet[], expiresAt: Date): Promise<void>;
  resolveChoice(installationId: string, input: ChoiceResolutionInput): Promise<ZendeskResolvedChoice | null>;
  claimOutbox(limit: number, leaseMs: number, maxAttempts: number): Promise<readonly OutboxItem[]>;
  markOutboxDelivered(id: string): Promise<void>;
  rescheduleOutbox(id: string, nextAttemptAt: Date, errorCode: string, terminal: boolean): Promise<void>;
  markOutboxAmbiguous(id: string, errorCode: string): Promise<void>;
  reconcileQuarantine(input: QuarantineResolutionInput): Promise<void>;
  listQuarantines(filter?: { readonly installationId?: string; readonly conversationId?: string }): Promise<readonly QuarantineRecord[]>;
  deliverOutboxFenced(
    item: OutboxItem,
    execute: () => Promise<"delivered" | "ownership_lost">,
  ): Promise<"delivered" | "ownership_lost" | "stale">;
  cleanup(retentionBefore: Date): Promise<CleanupCounts>;
  purgeInstallation(installationId: string): Promise<void>;
  close(): Promise<void>;
}

export class OutboxPersistenceAfterExecutionError extends Error {
  constructor(options?: { readonly cause?: unknown }) {
    super("An externally delivered operation could not be durably recorded.", options);
    this.name = "OutboxPersistenceAfterExecutionError";
  }
}

interface MemoryDelivery {
  readonly bodySha256: string;
  payload: unknown;
  status: "pending" | "retry" | "leased" | "completed" | "dead";
  attemptCount: number;
  nextAttemptAt: number;
  leaseUntil: number;
  completedAt: number | null;
}

interface MemoryOutbox extends OutboxItem {
  status: "pending" | "retry" | "leased" | "sent" | "dead" | "ambiguous";
  nextAttemptAt: number;
  leaseUntil: number;
  createdAt: number;
  sequence: number;
  operatorRetryRemaining: 0 | 1;
}

interface MemoryChoice {
  readonly appId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly suggestionId: string;
  readonly sourceMessageId: string;
  readonly sourceMessageNonce: string;
  readonly issuedAt: string;
  readonly choiceId: string;
  readonly detectorId: string | null;
  readonly reply: string;
  readonly feedback: "confirmed" | "none" | "skip";
  readonly payload: string;
  readonly expiresAt: string;
  readonly expiresAtMs: number;
  consumedByEventId: string | null;
}

interface MemoryEventClaim {
  ownerDeliveryKey: string;
  status: "leased" | "retry" | "completed";
  leaseUntil: number;
  completedAt: number | null;
}

interface MemoryQuarantine {
  readonly installationId: string;
  readonly conversationId: string;
  readonly outboxId: string;
  readonly reasonCode: string;
  readonly createdAt: string;
  readonly operationKind: StagedOperation["kind"];
  readonly eventKey: string;
  readonly guardEventId: string | null;
  readonly zendeskDeliveryKey: string | null;
  readonly zendeskFirstMessageId: string | null;
  readonly handoffReason: string | null;
  readonly zendeskReleaseKey: string | null;
}

function boundedMetadataString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\r\n]/u.test(value)
    ? value
    : null;
}

function buildQuarantineMetadata(item: MemoryOutbox, reasonCode: string): MemoryQuarantine {
  const body = item.request.body as unknown;
  const bodyRecord = typeof body === "object" && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const metadata = typeof bodyRecord.metadata === "object" && bodyRecord.metadata !== null && !Array.isArray(bodyRecord.metadata)
    ? bodyRecord.metadata as Record<string, unknown>
    : {};
  return {
    installationId: item.installationId,
    conversationId: item.conversationId,
    outboxId: item.id,
    reasonCode,
    createdAt: new Date().toISOString(),
    operationKind: item.kind,
    eventKey: item.eventKey,
    guardEventId: item.guardEventId,
    zendeskDeliveryKey: boundedMetadataString(metadata.wordless_delivery_key),
    zendeskFirstMessageId: boundedMetadataString(metadata.first_message_id),
    handoffReason: boundedMetadataString(metadata.handoff_reason),
    zendeskReleaseKey: boundedMetadataString(metadata.wordless_release_key),
  };
}

function isHumanPass(item: Pick<StagedOperation, "kind" | "request">): boolean {
  if (item.kind !== "pass_control") return false;
  const body = item.request.body as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  const metadata = value.metadata;
  return value.switchboardIntegration !== "next" && typeof value.switchboardIntegration === "string" &&
    typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).handoff_reason === "human_requested";
}

export class MemoryGatewayStore implements GatewayStore {
  private readonly deliveries = new Map<string, MemoryDelivery>();
  private readonly outbox = new Map<string, MemoryOutbox>();
  private readonly eventKeys = new Set<string>();
  private readonly choices = new Map<string, MemoryChoice>();
  private readonly events = new Map<string, MemoryEventClaim>();
  private readonly conversationState = new Map<string, { eventId: string; occurredAtMs: number; updatedAtMs: number }>();
  private readonly conversationLocks = new Map<string, Promise<void>>();
  private readonly quarantinedConversations = new Map<string, Set<string>>();
  private readonly quarantineMetadata = new Map<string, MemoryQuarantine>();
  private outboxSequence = 0;
  private available = true;

  async ping(): Promise<void> {
    if (!this.available) throw new Error("Memory store is closed.");
  }

  async claimDelivery(input: DeliveryClaim): Promise<ClaimResult> {
    const key = `${input.installationId}\0${input.deliveryKey}`;
    const current = this.deliveries.get(key);
    if (current === undefined) {
      this.deliveries.set(key, {
        bodySha256: input.bodySha256,
        payload: input.payload,
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: Date.now(),
        leaseUntil: 0,
        completedAt: null,
      });
      return "claimed";
    }
    if (current.bodySha256 !== input.bodySha256) return "conflict";
    return "duplicate";
  }

  async claimInbox(limit: number, leaseMs: number, maxAttempts: number): Promise<readonly InboxItem[]> {
    const now = Date.now();
    const claimed: InboxItem[] = [];
    for (const [key, item] of this.deliveries) {
      if (item.status === "leased" && item.leaseUntil <= now) item.status = "retry";
      if ((item.status === "pending" || item.status === "retry") && item.attemptCount >= maxAttempts) {
        item.status = "dead";
        item.payload = null;
        item.completedAt = now;
      }
      if (claimed.length >= limit) break;
      if (item.attemptCount >= maxAttempts) continue;
      const due = (item.status === "pending" || item.status === "retry") && item.nextAttemptAt <= now ||
        item.status === "leased" && item.leaseUntil <= now;
      if (!due) continue;
      item.status = "leased";
      item.leaseUntil = now + leaseMs;
      item.attemptCount += 1;
      const separator = key.indexOf("\0");
      claimed.push({
        installationId: key.slice(0, separator),
        deliveryKey: key.slice(separator + 1),
        payload: item.payload,
        attemptCount: item.attemptCount,
      });
    }
    return claimed;
  }

  async renewDelivery(installationId: string, deliveryKey: string, leaseMs: number): Promise<boolean> {
    const item = this.deliveries.get(`${installationId}\0${deliveryKey}`);
    if (item?.status !== "leased" || item.leaseUntil <= Date.now()) return false;
    item.leaseUntil = Date.now() + leaseMs;
    return true;
  }

  private async withConversationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.conversationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.conversationLocks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.conversationLocks.get(key) === tail) this.conversationLocks.delete(key);
    }
  }

  private async withConversationLocks<T>(
    keys: readonly string[],
    operation: () => Promise<T>,
    index = 0,
  ): Promise<T> {
    const key = keys[index];
    if (key === undefined) return operation();
    return this.withConversationLock(key, () => this.withConversationLocks(keys, operation, index + 1));
  }

  async claimEvent(input: EventClaimInput): Promise<EventClaimResult> {
    if (!input.controlActivity || input.conversationId === null) return this.claimEventUnlocked(input);
    const key = `${input.installationId}\0${input.conversationId}`;
    return this.withConversationLock(key, () => this.claimEventUnlocked(input));
  }

  private async claimEventUnlocked(input: EventClaimInput): Promise<EventClaimResult> {
    const key = `${input.installationId}\0${input.eventId}`;
    const current = this.events.get(key);
    if (current === undefined) {
      this.events.set(key, { ownerDeliveryKey: input.deliveryKey, status: "leased", leaseUntil: Date.now() + input.leaseMs, completedAt: null });
      if (input.controlActivity && input.conversationId !== null) {
        if (!this.advanceConversation(input.installationId, input.conversationId, input.eventId, input.eventCreatedAt)) return "stale";
        this.replaceWithSafetyRelease(input);
      }
      return "claimed";
    }
    if (current.status === "completed") return "completed";
    if (current.status === "leased" && current.leaseUntil > Date.now()) return "busy";
    current.ownerDeliveryKey = input.deliveryKey;
    current.status = "leased";
    current.leaseUntil = Date.now() + input.leaseMs;
    if (input.controlActivity && input.conversationId !== null) {
      if (!this.advanceConversation(input.installationId, input.conversationId, input.eventId, input.eventCreatedAt)) return "stale";
      this.replaceWithSafetyRelease(input);
    }
    return "claimed";
  }

  private advanceConversation(installationId: string, conversationId: string, eventId: string, occurredAt: string): boolean {
    const key = `${installationId}\0${conversationId}`;
    const occurredAtMs = Date.parse(occurredAt);
    const current = this.conversationState.get(key);
    if (!Number.isFinite(occurredAtMs) || current !== undefined && (
      occurredAtMs < current.occurredAtMs ||
      occurredAtMs === current.occurredAtMs && current.eventId !== eventId
    )) return false;
    this.conversationState.set(key, { eventId, occurredAtMs, updatedAtMs: Date.now() });
    return true;
  }

  private replaceWithSafetyRelease(input: EventClaimInput): void {
    if (input.conversationId === null || input.safetyRelease === null) return;
    const operation = input.safetyRelease;
    const eventKey = `${input.installationId}\0${operation.eventKey}`;
    let sameEvent: MemoryOutbox | undefined;
    for (const item of this.outbox.values()) {
      if (item.installationId === input.installationId && item.kind === "release_control" &&
          item.conversationId === input.conversationId) {
        if (`${item.installationId}\0${item.eventKey}` === eventKey) {
          sameEvent = item;
          continue;
        }
        if (item.status === "pending" || item.status === "retry" || item.status === "leased") {
          item.status = "dead";
          item.leaseUntil = 0;
        }
      }
    }
    if (sameEvent !== undefined) {
      if (sameEvent.status === "pending" || sameEvent.status === "retry" || sameEvent.status === "dead") {
        sameEvent.status = "pending";
        sameEvent.nextAttemptAt = operation.availableAt.getTime();
        sameEvent.leaseUntil = 0;
        Object.assign(sameEvent, { attemptCount: 0 });
        sameEvent.operatorRetryRemaining = 0;
        Object.assign(sameEvent, {
          guardEventId: operation.guardEventId,
          request: operation.request,
        });
      }
      return;
    }
    if (!this.eventKeys.has(eventKey)) {
      this.eventKeys.add(eventKey);
      this.outbox.set(operation.id, {
        ...operation,
        installationId: input.installationId,
        attemptCount: 0,
        status: "pending",
        nextAttemptAt: operation.availableAt.getTime(),
        leaseUntil: 0,
        createdAt: Date.now(),
        sequence: this.outboxSequence += 1,
        operatorRetryRemaining: 0,
      });
    }
  }

  async releaseEvent(installationId: string, eventId: string, deliveryKey: string): Promise<void> {
    const value = this.events.get(`${installationId}\0${eventId}`);
    if (value !== undefined && value.status === "leased" && value.ownerDeliveryKey === deliveryKey) {
      value.status = "retry";
      value.leaseUntil = 0;
    }
  }

  async stageDelivery(input: StageDeliveryInput): Promise<number> {
    const keys = [...new Set(input.plans.flatMap((plan) => plan.activity === null
      ? []
      : [`${input.installationId}\0${plan.activity.conversationId}`]))].sort();
    return this.withConversationLocks(keys, () => this.stageDeliveryUnlocked(input));
  }

  private async stageDeliveryUnlocked(input: StageDeliveryInput): Promise<number> {
    const delivery = this.deliveries.get(`${input.installationId}\0${input.deliveryKey}`);
    if (delivery === undefined) throw new Error("Delivery was not claimed.");
    if (delivery.status !== "leased") throw new Error("Delivery lease was lost.");
    const eventIds = input.plans.flatMap((plan) => plan.eventId === null ? [] : [plan.eventId]);
    for (const eventId of eventIds) {
      const event = this.events.get(`${input.installationId}\0${eventId}`);
      if (event === undefined || event.ownerDeliveryKey !== input.deliveryKey || event.status !== "leased") {
        throw new Error("Event lease was lost.");
      }
    }
    for (const plan of input.plans) {
      if (plan.activity !== null) {
        if (plan.eventId === null) throw new Error("Conversation activity requires a claimed event.");
        this.advanceConversation(
          input.installationId,
          plan.activity.conversationId,
          plan.eventId,
          plan.activity.occurredAt,
        );
      }
    }
    let queued = 0;
    for (const plan of input.plans) {
      const accepted = plan.activity === null || plan.eventId !== null &&
        this.conversationState.get(`${input.installationId}\0${plan.activity.conversationId}`)?.eventId === plan.eventId;
      if (!accepted) continue;
      if (plan.activity?.cancelReleases === true) {
        for (const item of this.outbox.values()) {
          if (
            item.installationId === input.installationId && item.kind === "release_control" &&
            item.conversationId === plan.activity.conversationId &&
            (item.status === "pending" || item.status === "retry" || item.status === "leased")
          ) {
            item.status = "dead";
            item.leaseUntil = 0;
          }
        }
      }
      for (const choice of plan.choices) this.upsertChoice(input.installationId, choice, input.choiceExpiresAt);
      for (const operation of plan.operations) {
        const eventKey = `${input.installationId}\0${operation.eventKey}`;
        if (this.eventKeys.has(eventKey)) continue;
        this.eventKeys.add(eventKey);
        this.outbox.set(operation.id, {
          ...operation,
          installationId: input.installationId,
          attemptCount: 0,
          status: "pending",
          nextAttemptAt: operation.availableAt.getTime(),
          leaseUntil: 0,
          createdAt: Date.now(),
          sequence: this.outboxSequence += 1,
          operatorRetryRemaining: 0,
        });
        queued += 1;
      }
    }
    delivery.status = "completed";
    delivery.payload = null;
    delivery.completedAt = Date.now();
    delivery.leaseUntil = 0;
    for (const eventId of eventIds) {
      const event = this.events.get(`${input.installationId}\0${eventId}`);
      if (event === undefined) throw new Error("Event lease was lost.");
      event.status = "completed";
      event.completedAt = Date.now();
      event.leaseUntil = 0;
    }
    return queued;
  }

  async rescheduleDelivery(installationId: string, deliveryKey: string, nextAttemptAt: Date, _errorCode: string, terminal: boolean): Promise<void> {
    const delivery = this.deliveries.get(`${installationId}\0${deliveryKey}`);
    if (delivery !== undefined) {
      delivery.status = terminal ? "dead" : "retry";
      delivery.nextAttemptAt = nextAttemptAt.getTime();
      if (terminal) delivery.payload = null;
      if (terminal) delivery.completedAt = Date.now();
      delivery.leaseUntil = 0;
    }
  }

  async saveChoices(installationId: string, values: readonly ZendeskPendingChoiceSet[], expiresAt: Date): Promise<void> {
    for (const value of values) this.upsertChoice(installationId, value, expiresAt);
  }

  private upsertChoice(installationId: string, value: ZendeskPendingChoiceSet, expiresAt: Date): void {
    for (const choice of value.choices) {
      this.choices.set(`${installationId}\0${choice.payload}`, {
        appId: value.appId,
        conversationId: value.conversationId,
        userId: value.userId,
        suggestionId: value.suggestionId,
        sourceMessageId: value.sourceMessageId,
        sourceMessageNonce: value.sourceMessageNonce,
        issuedAt: value.issuedAt,
        choiceId: choice.id,
        detectorId: choice.detectorId,
        reply: choice.reply,
        feedback: choice.feedback,
        payload: choice.payload,
        expiresAt: value.expiresAt,
        expiresAtMs: Math.min(expiresAt.getTime(), Date.parse(value.expiresAt)),
        consumedByEventId: null,
      });
    }
  }

  async resolveChoice(installationId: string, input: ChoiceResolutionInput): Promise<ZendeskResolvedChoice | null> {
    const value = this.choices.get(`${installationId}\0${input.payload}`);
    if (
      value === undefined ||
      value.expiresAtMs <= Date.now() ||
      value.appId !== input.appId ||
      value.conversationId !== input.conversationId ||
      value.userId !== input.userId ||
      value.sourceMessageNonce !== input.sourceMessageNonce ||
      value.issuedAt !== input.issuedAt ||
      value.expiresAt !== input.expiresAt ||
      Date.parse(input.selectionReceivedAt) > value.expiresAtMs
    ) return null;
    if (value.consumedByEventId !== null && value.consumedByEventId !== input.selectionEventId) return null;
    value.consumedByEventId = input.selectionEventId;
    return {
      appId: value.appId,
      conversationId: value.conversationId,
      userId: value.userId,
      suggestionId: value.suggestionId,
      sourceMessageId: value.sourceMessageId,
      sourceMessageNonce: value.sourceMessageNonce,
      issuedAt: value.issuedAt,
      expiresAt: value.expiresAt,
      selectionEventId: input.selectionEventId,
      choiceId: value.choiceId,
      detectorId: value.detectorId,
      reply: value.reply,
      feedback: value.feedback,
    };
  }

  async claimOutbox(limit: number, leaseMs: number, maxAttempts: number): Promise<readonly OutboxItem[]> {
    const now = Date.now();
    for (const item of this.outbox.values()) {
      if (item.status === "leased" && item.leaseUntil <= now) {
        item.status = "ambiguous";
        this.addQuarantine(item, "lease_expired_after_send");
      }
      if ((item.status === "pending" || item.status === "retry") && item.attemptCount >= maxAttempts && item.operatorRetryRemaining === 0) item.status = "dead";
    }
    const conversations = new Set<string>();
    const due = [...this.outbox.values()]
      .filter((item) =>
        (item.attemptCount < maxAttempts || item.operatorRetryRemaining === 1) &&
        (item.kind === "release_control" ||
          isHumanPass(item) && item.guardEventId !== null &&
            this.conversationState.get(`${item.installationId}\0${item.conversationId}`)?.eventId === item.guardEventId ||
          !this.quarantinedConversations.has(`${item.installationId}\0${item.conversationId}`)) &&
        ((item.status === "pending" || item.status === "retry") && item.nextAttemptAt <= now ||
          item.status === "leased" && item.leaseUntil <= now))
      .sort((left, right) => {
        const priority = (item: MemoryOutbox): number => {
          const current = this.conversationState.get(`${item.installationId}\0${item.conversationId}`)?.eventId;
          if (item.guardEventId !== null && item.guardEventId === current &&
              (item.kind === "release_control" || isHumanPass(item))) return 0;
          return item.kind === "release_control" ? 1 : 2;
        };
        return priority(left) - priority(right) || left.sequence - right.sequence;
      })
      .filter((item) => ![...this.outbox.values()].some((earlier) =>
        item.kind !== "release_control" && !(isHumanPass(item) && item.guardEventId !== null &&
          this.conversationState.get(`${item.installationId}\0${item.conversationId}`)?.eventId === item.guardEventId) &&
        earlier !== item && earlier.installationId === item.installationId &&
        earlier.conversationId === item.conversationId &&
        (earlier.status === "leased" || earlier.status === "ambiguous" ||
          (earlier.status === "pending" || earlier.status === "retry") && earlier.nextAttemptAt <= now) &&
        earlier.sequence < item.sequence))
      .filter((item) => {
        const key = `${item.installationId}\0${item.conversationId}`;
        if (conversations.has(key)) return false;
        conversations.add(key);
        return true;
      })
      .slice(0, limit);
    for (const item of due) {
      item.status = "leased";
      item.leaseUntil = now + leaseMs;
      Object.assign(item, { attemptCount: item.attemptCount + 1 });
      item.operatorRetryRemaining = 0;
    }
    return due.map(({ status: _status, nextAttemptAt: _next, leaseUntil: _lease, ...item }) => ({ ...item }));
  }

  async markOutboxDelivered(id: string): Promise<void> {
    const item = this.outbox.get(id);
    if (item !== undefined) item.status = "sent";
  }

  async rescheduleOutbox(id: string, nextAttemptAt: Date, _errorCode: string, terminal: boolean): Promise<void> {
    const item = this.outbox.get(id);
    if (item === undefined) return;
    item.status = terminal ? "dead" : "retry";
    item.nextAttemptAt = nextAttemptAt.getTime();
    item.leaseUntil = 0;
  }

  async markOutboxAmbiguous(id: string, errorCode: string): Promise<void> {
    const item = this.outbox.get(id);
    if (item !== undefined) {
      item.status = "ambiguous";
      item.leaseUntil = 0;
      this.addQuarantine(item, errorCode);
    }
  }

  private addQuarantine(item: MemoryOutbox, reasonCode: string): void {
    const key = `${item.installationId}\0${item.conversationId}`;
    const ids = this.quarantinedConversations.get(key) ?? new Set<string>();
    ids.add(item.id);
    this.quarantinedConversations.set(key, ids);
    if (!this.quarantineMetadata.has(item.id)) {
      this.quarantineMetadata.set(item.id, buildQuarantineMetadata(item, reasonCode));
    }
  }

  async reconcileQuarantine(input: QuarantineResolutionInput): Promise<void> {
    const key = `${input.installationId}\0${input.conversationId}`;
    const ids = this.quarantinedConversations.get(key);
    if (ids === undefined || !ids.has(input.outboxId)) throw new Error("Quarantined delivery was not found.");
    const item = this.outbox.get(input.outboxId);
    if (item !== undefined && (
      item.installationId !== input.installationId || item.conversationId !== input.conversationId || item.status !== "ambiguous"
    )) throw new Error("Quarantined delivery does not match the requested conversation.");
    if (input.resolution === "retry") {
      if (item === undefined) throw new Error("Quarantined payload has expired and cannot be retried.");
      item.status = "retry";
      Object.assign(item, { attemptCount: 100 });
      item.operatorRetryRemaining = 1;
      item.nextAttemptAt = Date.now();
      item.leaseUntil = 0;
    } else if (item !== undefined) {
      item.status = "sent";
    }
    ids.delete(input.outboxId);
    this.quarantineMetadata.delete(input.outboxId);
    if (ids.size === 0) this.quarantinedConversations.delete(key);
  }

  async listQuarantines(filter: { readonly installationId?: string; readonly conversationId?: string } = {}): Promise<readonly QuarantineRecord[]> {
    const output: QuarantineRecord[] = [];
    for (const [key, ids] of this.quarantinedConversations) {
      const separator = key.indexOf("\0");
      const installationId = key.slice(0, separator);
      const conversationId = key.slice(separator + 1);
      if (filter.installationId !== undefined && filter.installationId !== installationId) continue;
      if (filter.conversationId !== undefined && filter.conversationId !== conversationId) continue;
      for (const outboxId of ids) {
        const metadata = this.quarantineMetadata.get(outboxId);
        output.push({
          installationId,
          conversationId,
          outboxId,
          reasonCode: metadata?.reasonCode ?? "ambiguous_delivery",
          createdAt: metadata?.createdAt ?? new Date(0).toISOString(),
          payloadAvailable: this.outbox.has(outboxId),
          operationKind: metadata?.operationKind ?? null,
          eventKey: metadata?.eventKey ?? null,
          guardEventId: metadata?.guardEventId ?? null,
          zendeskDeliveryKey: metadata?.zendeskDeliveryKey ?? null,
          zendeskFirstMessageId: metadata?.zendeskFirstMessageId ?? null,
          handoffReason: metadata?.handoffReason ?? null,
          zendeskReleaseKey: metadata?.zendeskReleaseKey ?? null,
        });
      }
    }
    return output;
  }

  async deliverOutboxFenced(
    item: OutboxItem,
    execute: () => Promise<"delivered" | "ownership_lost">,
  ): Promise<"delivered" | "ownership_lost" | "stale"> {
    const key = `${item.installationId}\0${item.conversationId}`;
    return this.withConversationLock(key, async () => {
      const stored = this.outbox.get(item.id);
      const currentEvent = this.conversationState.get(key)?.eventId;
      if (stored?.status !== "leased" || item.guardEventId === null || currentEvent !== item.guardEventId) {
        if (stored?.status === "leased") stored.status = "dead";
        return "stale";
      }
      const outcome = await execute();
      stored.status = "sent";
      return outcome;
    });
  }

  async cleanup(retentionBefore: Date): Promise<CleanupCounts> {
    let inbox = 0;
    let outbox = 0;
    let choices = 0;
    for (const [key, item] of this.deliveries) {
      if ((item.status === "completed" || item.status === "dead") && item.completedAt !== null && item.completedAt < retentionBefore.getTime()) {
        this.deliveries.delete(key);
        inbox += 1;
      }
    }
    for (const [key, item] of this.outbox) {
      if ((item.status === "sent" || item.status === "dead" || item.status === "ambiguous") && item.createdAt < retentionBefore.getTime()) {
        this.outbox.delete(key);
        this.eventKeys.delete(`${item.installationId}\0${item.eventKey}`);
        outbox += 1;
      }
    }
    for (const [key, item] of this.choices) {
      if (item.expiresAtMs <= Date.now()) {
        this.choices.delete(key);
        choices += 1;
      }
    }
    let events = 0;
    for (const [key, item] of this.events) {
      if (item.status === "completed" && item.completedAt !== null && item.completedAt < retentionBefore.getTime()) {
        this.events.delete(key);
        events += 1;
      }
    }
    let conversations = 0;
    for (const [key, state] of this.conversationState) {
      if (state.updatedAtMs >= retentionBefore.getTime()) continue;
      const separator = key.indexOf("\0");
      const installationId = key.slice(0, separator);
      const conversationId = key.slice(separator + 1);
      const hasLiveOutbox = [...this.outbox.values()].some((item) =>
        item.installationId === installationId && item.conversationId === conversationId &&
        (item.status === "pending" || item.status === "retry" || item.status === "leased" || item.status === "ambiguous"));
      const hasQuarantine = this.quarantinedConversations.has(key);
      const claim = this.events.get(`${installationId}\0${state.eventId}`);
      if (hasLiveOutbox || hasQuarantine || claim !== undefined && claim.status !== "completed") continue;
      this.conversationState.delete(key);
      conversations += 1;
    }
    return { inbox, outbox, choices, events, conversations };
  }

  async purgeInstallation(installationId: string): Promise<void> {
    const prefix = `${installationId}\0`;
    for (const key of [...this.deliveries.keys()]) if (key.startsWith(prefix)) this.deliveries.delete(key);
    for (const [key, item] of [...this.outbox]) if (item.installationId === installationId) this.outbox.delete(key);
    for (const key of [...this.eventKeys]) if (key.startsWith(prefix)) this.eventKeys.delete(key);
    for (const key of [...this.choices.keys()]) if (key.startsWith(prefix)) this.choices.delete(key);
    for (const key of [...this.events.keys()]) if (key.startsWith(prefix)) this.events.delete(key);
    for (const key of [...this.conversationState.keys()]) if (key.startsWith(prefix)) this.conversationState.delete(key);
    for (const key of [...this.quarantinedConversations.keys()]) if (key.startsWith(prefix)) this.quarantinedConversations.delete(key);
    for (const [key, item] of this.quarantineMetadata) if (item.installationId === installationId) this.quarantineMetadata.delete(key);
  }

  async close(): Promise<void> {
    this.available = false;
  }

  snapshot(): { readonly outbox: readonly Readonly<MemoryOutbox>[]; readonly deliveryCount: number; readonly conversationStateCount: number; readonly quarantineCount: number } {
    return {
      outbox: [...this.outbox.values()].map((item) => ({ ...item })),
      deliveryCount: this.deliveries.size,
      conversationStateCount: this.conversationState.size,
      quarantineCount: this.quarantinedConversations.size,
    };
  }
}

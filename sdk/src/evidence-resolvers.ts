import {
  type WordlessAccountAccessEvidence,
  type WordlessChargeEvidence,
  type WordlessEvidence,
  type WordlessFulfillmentEvidence,
  type WordlessJsonValue,
  type WordlessShipmentEvidence,
} from "./server.js";

/**
 * Wordless evidence resolvers
 * ============================
 * This module is a NORMALIZER, not a detector: it turns friendlier,
 * provider-shaped source records into the exact, strictly typed
 * `WordlessEvidence[]` the `/v1/chat/assist` contract and the channel
 * adapters consume. It never inspects two records against each other to
 * decide whether something is wrong (duplicate charge, late delivery,
 * wrong item, account lockout) — the Wordless engine's detectors do that
 * once the evidence lands. This module's only job is: validate strictly,
 * normalize vocabulary, and emit read-only typed evidence.
 */

const ISO_INSTANT_PATTERN = /T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/u;
const AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const MAX_IDENTIFIER_LENGTH = 256;

export class EvidenceResolverError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message);
    this.name = "EvidenceResolverError";
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: options.cause,
        writable: true,
      });
    }
  }
}

/* -------------------------------------------------------------------------
 * Source record input types (friendlier than the strict evidence types)
 * ---------------------------------------------------------------------- */

export interface ChargeRecord {
  readonly ref: string;
  readonly occurredAt: string;
  readonly amount: string | number;
  readonly currency: string;
  readonly status: string;
  readonly orderRef?: string | null;
  /** When true, `amount` is treated as an integer count of minor currency units (e.g. cents). */
  readonly minorUnits?: boolean;
}

export interface ShipmentRecord {
  readonly ref: string;
  readonly occurredAt: string;
  readonly orderRef: string;
  readonly status: string;
  readonly expectedDeliveryAt?: string | null;
}

export interface FulfillmentRecord {
  readonly ref: string;
  readonly occurredAt: string;
  readonly orderRef: string;
  readonly orderedSku: string;
  readonly deliveredSku: string;
  /** When omitted, derived from whether `orderedSku` equals `deliveredSku`. */
  readonly status?: string;
}

export interface AccountAccessRecord {
  readonly ref: string;
  readonly occurredAt: string;
  readonly accountRef: string;
  readonly status: string;
  /** Defaults to 0 when omitted. */
  readonly failedAttempts?: number;
}

type ChargeStatus = WordlessChargeEvidence["status"];
type ShipmentStatus = WordlessShipmentEvidence["status"];
type FulfillmentStatus = WordlessFulfillmentEvidence["status"];
type AccountAccessStatus = WordlessAccountAccessEvidence["status"];

const CHARGE_STATUSES: readonly ChargeStatus[] = [
  "captured",
  "completed",
  "paid",
  "posted",
  "succeeded",
];
const SHIPMENT_STATUSES: readonly ShipmentStatus[] = [
  "cancelled",
  "delayed",
  "delivered",
  "in_transit",
  "late",
  "lost",
  "missing",
  "overdue",
  "returned",
  "shipped",
];
const FULFILLMENT_STATUSES: readonly FulfillmentStatus[] = [
  "delivered",
  "incorrect_item",
  "mismatched",
  "wrong_item",
];
const ACCOUNT_ACCESS_STATUSES: readonly AccountAccessStatus[] = [
  "active",
  "blocked",
  "locked",
  "locked_out",
  "unlocked",
];

/* -------------------------------------------------------------------------
 * Default status vocabulary maps (keys are normalized: lower-cased, with
 * spaces/hyphens collapsed to a single underscore). Every allowed enum
 * value is present as an identity entry, plus common provider synonyms.
 * ---------------------------------------------------------------------- */

const DEFAULT_CHARGE_STATUS_MAP: Readonly<Record<string, ChargeStatus>> = Object.freeze({
  captured: "captured",
  complete: "completed",
  completed: "completed",
  paid: "paid",
  posted: "posted",
  settled: "posted",
  succeeded: "succeeded",
  success: "succeeded",
});

const DEFAULT_SHIPMENT_STATUS_MAP: Readonly<Record<string, ShipmentStatus>> = Object.freeze({
  cancelled: "cancelled",
  canceled: "cancelled",
  delayed: "delayed",
  delivered: "delivered",
  in_transit: "in_transit",
  out_for_delivery: "in_transit",
  late: "late",
  lost: "lost",
  missing: "missing",
  overdue: "overdue",
  returned: "returned",
  shipped: "shipped",
});

const DEFAULT_FULFILLMENT_STATUS_MAP: Readonly<Record<string, FulfillmentStatus>> = Object.freeze({
  delivered: "delivered",
  incorrect: "incorrect_item",
  incorrect_item: "incorrect_item",
  mismatch: "mismatched",
  mismatched: "mismatched",
  wrong_item: "wrong_item",
});

const DEFAULT_ACCOUNT_ACCESS_STATUS_MAP: Readonly<Record<string, AccountAccessStatus>> = Object.freeze({
  active: "active",
  blocked: "blocked",
  locked: "locked",
  locked_out: "locked_out",
  lockout: "locked_out",
  ok: "active",
  open: "active",
  reset: "unlocked",
  unlocked: "unlocked",
});

/* -------------------------------------------------------------------------
 * Low-level validation helpers, mirroring the discipline in zendesk.ts.
 * ---------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, maxLength = MAX_IDENTIFIER_LENGTH): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim()
  ) {
    throw new EvidenceResolverError(
      `${label} must be a non-empty, trimmed string of at most ${maxLength} characters.`,
    );
  }
  return value;
}

function optionalOrderRef(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requiredString(value, label);
}

function optionalMetadata(
  value: unknown,
  label: string,
): Readonly<Record<string, WordlessJsonValue>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new EvidenceResolverError(`${label} must be a plain object.`);
  }
  return Object.freeze({ ...value }) as Readonly<Record<string, WordlessJsonValue>>;
}

function requiredTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value)) ||
    !ISO_INSTANT_PATTERN.test(value)
  ) {
    throw new EvidenceResolverError(`${label} must be an ISO-8601 instant with a timezone.`);
  }
  return value;
}

function optionalTimestamp(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requiredTimestamp(value, label);
}

function normalizeCurrency(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new EvidenceResolverError(`${label} must be a string.`);
  }
  const upper = value.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(upper)) {
    throw new EvidenceResolverError(`${label} must be a 3-letter ISO-4217 currency code.`);
  }
  return upper;
}

function normalizeAmount(value: unknown, minorUnits: boolean, label: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!AMOUNT_PATTERN.test(trimmed)) {
      throw new EvidenceResolverError(`${label} must be a decimal amount string.`);
    }
    return trimmed;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new EvidenceResolverError(`${label} must be a finite, non-negative number.`);
    }
    const dollars = minorUnits ? value / 100 : value;
    return dollars.toFixed(2);
  }
  throw new EvidenceResolverError(`${label} must be a string or number.`);
}

function normalizeFailedAttempts(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new EvidenceResolverError("failedAttempts must be a non-negative integer.");
  }
  return value;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

function normalizeStatus<T extends string>(
  value: unknown,
  defaultMap: Readonly<Record<string, T>>,
  override: Readonly<Record<string, T>> | undefined,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EvidenceResolverError(`${label} must be a non-empty string.`);
  }
  const token = normalizeToken(value);
  let mapped: T | undefined = defaultMap[token];
  if (override !== undefined) {
    for (const [overrideKey, overrideValue] of Object.entries(override)) {
      if (normalizeToken(overrideKey) === token) {
        mapped = overrideValue;
      }
    }
  }
  if (mapped === undefined || !(allowed as readonly string[]).includes(mapped)) {
    throw new EvidenceResolverError(`${label} "${value}" is not a recognized status.`);
  }
  return mapped;
}

function normalizeList<T>(value: T | readonly T[]): readonly unknown[] {
  return (Array.isArray(value) ? value : [value]) as readonly unknown[];
}

/* -------------------------------------------------------------------------
 * Charge
 * ---------------------------------------------------------------------- */

export interface ResolveChargeOptions {
  readonly statusMap?: Readonly<Record<string, ChargeStatus>>;
}

function resolveCharge(value: unknown, statusMap: Readonly<Record<string, ChargeStatus>> | undefined): WordlessChargeEvidence {
  if (!isRecord(value)) {
    throw new EvidenceResolverError("Charge record must be an object.");
  }
  const ref = requiredString(value.ref, "Charge ref");
  const occurredAt = requiredTimestamp(value.occurredAt, "Charge occurredAt");
  const currency = normalizeCurrency(value.currency, "Charge currency");
  const minorUnits = value.minorUnits === true;
  const amount = normalizeAmount(value.amount, minorUnits, "Charge amount");
  const status = normalizeStatus(
    value.status,
    DEFAULT_CHARGE_STATUS_MAP,
    statusMap,
    CHARGE_STATUSES,
    "Charge status",
  );
  const orderRef = optionalOrderRef(value.orderRef, "Charge orderRef");
  return Object.freeze({
    type: "charge" as const,
    ref,
    occurred_at: occurredAt,
    ...(orderRef === undefined ? {} : { order_ref: orderRef }),
    amount,
    currency,
    status,
  });
}

/** Validate and normalize one or more charge source records into strict Wordless evidence. */
export function resolveChargeEvidence(
  records: ChargeRecord | readonly ChargeRecord[],
  opts?: ResolveChargeOptions,
): readonly WordlessChargeEvidence[] {
  return Object.freeze(
    normalizeList(records).map((record) => resolveCharge(record, opts?.statusMap)),
  );
}

/* -------------------------------------------------------------------------
 * Shipment
 * ---------------------------------------------------------------------- */

export interface ResolveShipmentOptions {
  readonly statusMap?: Readonly<Record<string, ShipmentStatus>>;
  /**
   * OPT-IN, off by default. When true and a shipment is still in progress
   * (`in_transit`/`shipped`) and `expectedDeliveryAt` is strictly before
   * `observedAt`, the emitted status is upgraded to `"overdue"`. This is
   * the one derived signal this module produces; every other field is a
   * direct, validated pass-through of the source record. Requires
   * `observedAt` to be supplied alongside it.
   */
  readonly deriveOverdueFromExpectedDelivery?: boolean;
  /** Required when `deriveOverdueFromExpectedDelivery` is true. */
  readonly observedAt?: string;
}

const STILL_IN_PROGRESS_SHIPMENT_STATUSES: ReadonlySet<ShipmentStatus> = new Set([
  "in_transit",
  "shipped",
]);

function resolveShipment(value: unknown, opts: ResolveShipmentOptions | undefined): WordlessShipmentEvidence {
  if (!isRecord(value)) {
    throw new EvidenceResolverError("Shipment record must be an object.");
  }
  const ref = requiredString(value.ref, "Shipment ref");
  const occurredAt = requiredTimestamp(value.occurredAt, "Shipment occurredAt");
  const orderRef = requiredString(value.orderRef, "Shipment orderRef");
  let status = normalizeStatus(
    value.status,
    DEFAULT_SHIPMENT_STATUS_MAP,
    opts?.statusMap,
    SHIPMENT_STATUSES,
    "Shipment status",
  );
  const expectedDeliveryAt = optionalTimestamp(value.expectedDeliveryAt, "Shipment expectedDeliveryAt");
  if (opts?.deriveOverdueFromExpectedDelivery === true) {
    if (opts.observedAt === undefined) {
      throw new EvidenceResolverError(
        "deriveOverdueFromExpectedDelivery requires observedAt to be supplied.",
      );
    }
    const observedAtMs = Date.parse(requiredTimestamp(opts.observedAt, "observedAt"));
    if (
      STILL_IN_PROGRESS_SHIPMENT_STATUSES.has(status) &&
      expectedDeliveryAt !== undefined &&
      expectedDeliveryAt !== null &&
      Date.parse(expectedDeliveryAt) < observedAtMs
    ) {
      status = "overdue";
    }
  }
  return Object.freeze({
    type: "shipment" as const,
    ref,
    occurred_at: occurredAt,
    order_ref: orderRef,
    status,
    ...(expectedDeliveryAt === undefined ? {} : { expected_delivery_at: expectedDeliveryAt }),
  });
}

/** Validate and normalize one or more shipment source records into strict Wordless evidence. */
export function resolveShipmentEvidence(
  records: ShipmentRecord | readonly ShipmentRecord[],
  opts?: ResolveShipmentOptions,
): readonly WordlessShipmentEvidence[] {
  return Object.freeze(normalizeList(records).map((record) => resolveShipment(record, opts)));
}

/* -------------------------------------------------------------------------
 * Fulfillment
 * ---------------------------------------------------------------------- */

export interface ResolveFulfillmentOptions {
  readonly statusMap?: Readonly<Record<string, FulfillmentStatus>>;
}

function resolveFulfillment(
  value: unknown,
  statusMap: Readonly<Record<string, FulfillmentStatus>> | undefined,
): WordlessFulfillmentEvidence {
  if (!isRecord(value)) {
    throw new EvidenceResolverError("Fulfillment record must be an object.");
  }
  const ref = requiredString(value.ref, "Fulfillment ref");
  const occurredAt = requiredTimestamp(value.occurredAt, "Fulfillment occurredAt");
  const orderRef = requiredString(value.orderRef, "Fulfillment orderRef");
  const orderedSku = requiredString(value.orderedSku, "Fulfillment orderedSku");
  const deliveredSku = requiredString(value.deliveredSku, "Fulfillment deliveredSku");
  const status: FulfillmentStatus =
    value.status === undefined
      ? orderedSku === deliveredSku
        ? "delivered"
        : "mismatched"
      : normalizeStatus(
          value.status,
          DEFAULT_FULFILLMENT_STATUS_MAP,
          statusMap,
          FULFILLMENT_STATUSES,
          "Fulfillment status",
        );
  return Object.freeze({
    type: "fulfillment" as const,
    ref,
    occurred_at: occurredAt,
    order_ref: orderRef,
    ordered_sku: orderedSku,
    delivered_sku: deliveredSku,
    status,
  });
}

/** Validate and normalize one or more fulfillment source records into strict Wordless evidence. */
export function resolveFulfillmentEvidence(
  records: FulfillmentRecord | readonly FulfillmentRecord[],
  opts?: ResolveFulfillmentOptions,
): readonly WordlessFulfillmentEvidence[] {
  return Object.freeze(
    normalizeList(records).map((record) => resolveFulfillment(record, opts?.statusMap)),
  );
}

/* -------------------------------------------------------------------------
 * Account access
 * ---------------------------------------------------------------------- */

export interface ResolveAccountAccessOptions {
  readonly statusMap?: Readonly<Record<string, AccountAccessStatus>>;
}

function resolveAccountAccess(
  value: unknown,
  statusMap: Readonly<Record<string, AccountAccessStatus>> | undefined,
): WordlessAccountAccessEvidence {
  if (!isRecord(value)) {
    throw new EvidenceResolverError("AccountAccess record must be an object.");
  }
  const ref = requiredString(value.ref, "AccountAccess ref");
  const occurredAt = requiredTimestamp(value.occurredAt, "AccountAccess occurredAt");
  const accountRef = requiredString(value.accountRef, "AccountAccess accountRef");
  const status = normalizeStatus(
    value.status,
    DEFAULT_ACCOUNT_ACCESS_STATUS_MAP,
    statusMap,
    ACCOUNT_ACCESS_STATUSES,
    "AccountAccess status",
  );
  const failedAttempts = normalizeFailedAttempts(value.failedAttempts);
  return Object.freeze({
    type: "account_access" as const,
    ref,
    occurred_at: occurredAt,
    account_ref: accountRef,
    status,
    failed_attempts: failedAttempts,
  });
}

/** Validate and normalize one or more account-access source records into strict Wordless evidence. */
export function resolveAccountAccessEvidence(
  records: AccountAccessRecord | readonly AccountAccessRecord[],
  opts?: ResolveAccountAccessOptions,
): readonly WordlessAccountAccessEvidence[] {
  return Object.freeze(
    normalizeList(records).map((record) => resolveAccountAccess(record, opts?.statusMap)),
  );
}

/* -------------------------------------------------------------------------
 * Snapshot composer
 * ---------------------------------------------------------------------- */

export type EvidenceDropReason = "future_state";

export interface EvidenceStatusMaps {
  readonly charge?: Readonly<Record<string, ChargeStatus>>;
  readonly shipment?: Readonly<Record<string, ShipmentStatus>>;
  readonly fulfillment?: Readonly<Record<string, FulfillmentStatus>>;
  readonly accountAccess?: Readonly<Record<string, AccountAccessStatus>>;
}

export interface BuildEvidenceSnapshotInput {
  /** Timezone-aware instant when this evidence snapshot was read. */
  readonly observedAt: string;
  readonly charges?: ChargeRecord | readonly ChargeRecord[];
  readonly shipments?: ShipmentRecord | readonly ShipmentRecord[];
  readonly fulfillments?: FulfillmentRecord | readonly FulfillmentRecord[];
  readonly accountAccess?: AccountAccessRecord | readonly AccountAccessRecord[];
  /**
   * How to handle a resolved item whose `occurred_at` is strictly after
   * `observedAt` (future-state, per the evidence-contract rule "only facts
   * at or before observed_at"). Defaults to `"drop"`.
   */
  readonly futureStatePolicy?: "drop" | "reject";
  /** Called for every item dropped under the default `"drop"` policy. */
  readonly onDropped?: (item: WordlessEvidence, reason: EvidenceDropReason) => void;
  /** See `ResolveShipmentOptions.deriveOverdueFromExpectedDelivery`. Off by default. */
  readonly deriveOverdueFromExpectedDelivery?: boolean;
  readonly statusMaps?: EvidenceStatusMaps;
}

function compareEvidence(a: WordlessEvidence, b: WordlessEvidence): number {
  const timeDiff = Date.parse(a.occurred_at) - Date.parse(b.occurred_at);
  if (timeDiff !== 0) return timeDiff;
  if (a.ref < b.ref) return -1;
  if (a.ref > b.ref) return 1;
  return 0;
}

/**
 * Resolve every provided bucket of source records into strict Wordless
 * evidence, enforce the "only facts at or before observed_at" rule, and
 * return a deterministically ordered, frozen snapshot. This composer does
 * NOT detect duplicate charges, late deliveries, wrong items, or account
 * lockouts — it only normalizes and orders. The Wordless engine's
 * detectors run against the returned evidence.
 */
export function buildEvidenceSnapshot(input: BuildEvidenceSnapshotInput): readonly WordlessEvidence[] {
  if (!isRecord(input)) {
    throw new EvidenceResolverError("buildEvidenceSnapshot input must be an object.");
  }
  const observedAt = requiredTimestamp(input.observedAt, "observedAt");
  const futureStatePolicy = input.futureStatePolicy ?? "drop";
  if (futureStatePolicy !== "drop" && futureStatePolicy !== "reject") {
    throw new EvidenceResolverError('futureStatePolicy must be "drop" or "reject".');
  }
  if (input.onDropped !== undefined && typeof input.onDropped !== "function") {
    throw new EvidenceResolverError("onDropped must be a function.");
  }

  const chargeStatusMap = input.statusMaps?.charge;
  const shipmentStatusMap = input.statusMaps?.shipment;
  const fulfillmentStatusMap = input.statusMaps?.fulfillment;
  const accountAccessStatusMap = input.statusMaps?.accountAccess;

  const charges: readonly WordlessEvidence[] =
    input.charges === undefined
      ? []
      : resolveChargeEvidence(input.charges, {
          ...(chargeStatusMap === undefined ? {} : { statusMap: chargeStatusMap }),
        });
  const shipments: readonly WordlessEvidence[] =
    input.shipments === undefined
      ? []
      : resolveShipmentEvidence(input.shipments, {
          ...(shipmentStatusMap === undefined ? {} : { statusMap: shipmentStatusMap }),
          ...(input.deriveOverdueFromExpectedDelivery === undefined
            ? {}
            : { deriveOverdueFromExpectedDelivery: input.deriveOverdueFromExpectedDelivery }),
          observedAt,
        });
  const fulfillments: readonly WordlessEvidence[] =
    input.fulfillments === undefined
      ? []
      : resolveFulfillmentEvidence(input.fulfillments, {
          ...(fulfillmentStatusMap === undefined ? {} : { statusMap: fulfillmentStatusMap }),
        });
  const accountAccess: readonly WordlessEvidence[] =
    input.accountAccess === undefined
      ? []
      : resolveAccountAccessEvidence(input.accountAccess, {
          ...(accountAccessStatusMap === undefined ? {} : { statusMap: accountAccessStatusMap }),
        });

  const observedAtMs = Date.parse(observedAt);
  const kept: WordlessEvidence[] = [];
  for (const item of [...charges, ...shipments, ...fulfillments, ...accountAccess]) {
    if (Date.parse(item.occurred_at) > observedAtMs) {
      if (futureStatePolicy === "reject") {
        throw new EvidenceResolverError(
          `Evidence "${item.ref}" occurs after observedAt (future-state).`,
        );
      }
      input.onDropped?.(item, "future_state");
      continue;
    }
    kept.push(item);
  }
  kept.sort(compareEvidence);
  return Object.freeze(kept.map((item) => Object.freeze(item)));
}

/* -------------------------------------------------------------------------
 * Channel plug-in convenience
 * ---------------------------------------------------------------------- */

export interface ResolveAccountEvidenceInput extends BuildEvidenceSnapshotInput {
  /** Stable company-side account identifier, not a display name or email address. */
  readonly customerId: string;
  readonly metadata?: Readonly<Record<string, WordlessJsonValue>>;
}

export interface ResolvedAccountEvidence {
  /** Set only after authenticating the caller's user/account link. */
  readonly authenticated: true;
  readonly customerId: string;
  readonly observedAt: string;
  readonly evidence: readonly WordlessEvidence[];
  readonly metadata?: Readonly<Record<string, WordlessJsonValue>>;
}

/**
 * Same buckets as `buildEvidenceSnapshot`, plus `customerId` and optional
 * `metadata`. The returned shape is structurally exactly what the
 * WhatsApp/Slack/Zendesk channel adapters' `resolveAuthenticatedAccount`
 * must return, so a host can wire this in one line.
 */
export function resolveAccountEvidence(
  input: ResolveAccountEvidenceInput,
): Readonly<ResolvedAccountEvidence> {
  if (!isRecord(input)) {
    throw new EvidenceResolverError("resolveAccountEvidence input must be an object.");
  }
  const customerId = requiredString(input.customerId, "customerId", 512);
  const evidence = buildEvidenceSnapshot(input);
  const observedAt = requiredTimestamp(input.observedAt, "observedAt");
  const metadata = optionalMetadata(input.metadata, "metadata");
  return Object.freeze({
    authenticated: true as const,
    customerId,
    observedAt,
    evidence,
    ...(metadata === undefined ? {} : { metadata }),
  });
}

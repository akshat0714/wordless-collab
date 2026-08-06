import type {
  AccountAccessRecord,
  ChargeRecord,
  FulfillmentRecord,
  ShipmentRecord,
} from "./evidence-resolvers.js";

/**
 * Wordless provider connectors
 * =============================
 * This module is a SHAPE MAPPER, not a validator and not a detector: it
 * converts documented provider object shapes (a Stripe charge, a Shopify
 * fulfillment/order, a carrier tracking update, an auth lockout event, a
 * return/RMA line) into the friendlier source-record types that
 * `@wordless/sdk/evidence-resolvers` accepts. It never calls a provider
 * API, takes no credentials, and does not perform final evidence
 * validation — the resolver remains the single strict-validation
 * boundary; a host still pipes this module's output through it.
 *
 * A connector throws `ConnectorError` only when the provider object is
 * MALFORMED (not an object, or missing an id/timestamp/reference the
 * mapper depends on). A well-formed provider object that simply isn't
 * evidence-relevant (an unsuccessful charge, an untracked fulfillment, a
 * pre-transit label, an ordinary login, a return whose SKUs match) is
 * skipped by returning `null` — that is expected, not an error. Plural
 * mappers drop `null`s and return a frozen array.
 */

export class ConnectorError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message);
    this.name = "ConnectorError";
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
 * Small shared helpers (mirroring the isRecord idiom in evidence-resolvers.ts
 * and zendesk.ts).
 * ---------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Converts a provider unix-SECONDS timestamp to an ISO-8601 instant. */
function unixSecondsToIso(value: unknown, label: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConnectorError(`${label} must be a finite unix-seconds number.`);
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    throw new ConnectorError(`${label} is not a valid timestamp.`);
  }
  return date.toISOString();
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

function requiredNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConnectorError(`${label} is required and must be a non-empty string.`);
  }
  return value;
}

/** Accepts a documented provider id that may be a string or number (e.g. Shopify's numeric ids). */
function requiredIdString(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new ConnectorError(`${label} is required and must be a non-empty string or number.`);
}

function optionalIdString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/* -------------------------------------------------------------------------
 * Stripe → charge (duplicate-charge family)
 * ---------------------------------------------------------------------- */

export interface FromStripeChargeOptions {
  /** Key looked up in `charge.metadata` to resolve the order reference. Defaults to `"order_id"`. */
  readonly orderRefKey?: string;
}

const STRIPE_EVIDENCE_RELEVANT_STATUS = "succeeded";

function resolveStripeOrderRef(charge: Record<string, unknown>, orderRefKey: string): string | undefined {
  const metadata = charge.metadata;
  if (!isRecord(metadata)) return undefined;
  const value = metadata[orderRefKey];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Maps a Stripe Charge object to a `ChargeRecord`. Only a captured
 * (`status: "succeeded"`) charge is evidence of a possible duplicate
 * charge, so any other documented status (`"pending"`, `"failed"`)
 * returns `null` rather than throwing.
 */
export function fromStripeCharge(
  charge: unknown,
  opts?: FromStripeChargeOptions,
): ChargeRecord | null {
  if (!isRecord(charge)) {
    throw new ConnectorError("Stripe charge must be an object.");
  }
  const ref = requiredIdString(charge.id, "Stripe charge.id");
  const amount = charge.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new ConnectorError("Stripe charge.amount must be a finite number (minor units).");
  }
  const currency = requiredNonEmptyString(charge.currency, "Stripe charge.currency");
  const occurredAt = unixSecondsToIso(charge.created, "Stripe charge.created");

  if (charge.status !== STRIPE_EVIDENCE_RELEVANT_STATUS) {
    return null;
  }

  const orderRefKey = opts?.orderRefKey ?? "order_id";
  const orderRef = resolveStripeOrderRef(charge, orderRefKey);

  return Object.freeze({
    ref,
    occurredAt,
    amount,
    minorUnits: true,
    currency,
    status: "succeeded",
    ...(orderRef === undefined ? {} : { orderRef }),
  });
}

/** Maps each Stripe Charge, drops non-evidence-relevant charges, and freezes the result. */
export function fromStripeCharges(
  charges: readonly unknown[],
  opts?: FromStripeChargeOptions,
): readonly ChargeRecord[] {
  const mapped: ChargeRecord[] = [];
  for (const charge of charges) {
    const record = fromStripeCharge(charge, opts);
    if (record !== null) mapped.push(record);
  }
  return Object.freeze(mapped);
}

/* -------------------------------------------------------------------------
 * Shopify → shipment (late-delivery family)
 * ---------------------------------------------------------------------- */

export interface FromShopifyFulfillmentOptions {
  /** Used when the fulfillment object itself has no `order_id`. */
  readonly orderRef?: string;
}

const SHOPIFY_SHIPMENT_STATUS_MAP: Readonly<Record<string, string>> = Object.freeze({
  attempted_delivery: "delayed",
  confirmed: "shipped",
  delivered: "delivered",
  failure: "lost",
  in_transit: "in_transit",
  out_for_delivery: "in_transit",
  picked_up: "shipped",
  ready_for_pickup: "shipped",
});

/**
 * Maps a Shopify Fulfillment object to a `ShipmentRecord`. Not every
 * fulfillment carries tracking (`shipment_status` may be absent or an
 * unrecognized value) — that is expected and returns `null` rather than
 * throwing.
 */
export function fromShopifyFulfillment(
  fulfillment: unknown,
  opts?: FromShopifyFulfillmentOptions,
): ShipmentRecord | null {
  if (!isRecord(fulfillment)) {
    throw new ConnectorError("Shopify fulfillment must be an object.");
  }
  const ref = requiredIdString(fulfillment.id, "Shopify fulfillment.id");
  const updatedAt = requiredNonEmptyString(fulfillment.updated_at, "Shopify fulfillment.updated_at");

  const orderRef = optionalIdString(fulfillment.order_id) ?? opts?.orderRef;
  if (orderRef === undefined) {
    throw new ConnectorError(
      "Shopify fulfillment has no order_id and no opts.orderRef was provided.",
    );
  }

  const shipmentStatusRaw = fulfillment.shipment_status;
  if (typeof shipmentStatusRaw !== "string") {
    return null;
  }
  const mapped = SHOPIFY_SHIPMENT_STATUS_MAP[shipmentStatusRaw];
  if (mapped === undefined) {
    return null;
  }

  const expectedDeliveryAtRaw = fulfillment.estimated_delivery_at ?? fulfillment.estimated_delivery;
  const expectedDeliveryAt = typeof expectedDeliveryAtRaw === "string" ? expectedDeliveryAtRaw : undefined;

  return Object.freeze({
    ref,
    occurredAt: updatedAt,
    orderRef,
    status: mapped,
    ...(expectedDeliveryAt === undefined ? {} : { expectedDeliveryAt }),
  });
}

/** Maps every fulfillment on a Shopify Order, using the order's `id` as the shared order reference. */
export function fromShopifyOrder(order: unknown): readonly ShipmentRecord[] {
  if (!isRecord(order)) {
    throw new ConnectorError("Shopify order must be an object.");
  }
  const orderRef = requiredIdString(order.id, "Shopify order.id");
  const fulfillments = order.fulfillments;
  if (fulfillments === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(fulfillments)) {
    throw new ConnectorError("Shopify order.fulfillments must be an array.");
  }
  const mapped: ShipmentRecord[] = [];
  for (const fulfillment of fulfillments) {
    const record = fromShopifyFulfillment(fulfillment, { orderRef });
    if (record !== null) mapped.push(record);
  }
  return Object.freeze(mapped);
}

/* -------------------------------------------------------------------------
 * Generic carrier tracking → shipment (provider-neutral)
 * ---------------------------------------------------------------------- */

const TRACKING_PRE_TRANSIT_TOKENS: ReadonlySet<string> = new Set(["pre_transit", "label_created"]);

const TRACKING_STATUS_MAP: Readonly<Record<string, string>> = Object.freeze({
  available_for_pickup: "shipped",
  delayed: "delayed",
  delivered: "delivered",
  exception: "lost",
  in_transit: "in_transit",
  out_for_delivery: "in_transit",
  returned: "returned",
});

/**
 * Maps a provider-neutral carrier tracking update — `{ id, orderRef,
 * status, updatedAt, estimatedDeliveryAt? }` — to a `ShipmentRecord`.
 * Pre-transit/label-only statuses aren't evidence of a shipment in
 * progress yet, so they return `null` rather than throwing.
 */
export function fromTrackingUpdate(update: unknown): ShipmentRecord | null {
  if (!isRecord(update)) {
    throw new ConnectorError("Tracking update must be an object.");
  }
  const ref = requiredNonEmptyString(update.id, "Tracking update.id");
  const orderRef = requiredNonEmptyString(update.orderRef, "Tracking update.orderRef");
  const occurredAt = requiredNonEmptyString(update.updatedAt, "Tracking update.updatedAt");
  const statusRaw = requiredNonEmptyString(update.status, "Tracking update.status");

  const token = normalizeToken(statusRaw);
  if (TRACKING_PRE_TRANSIT_TOKENS.has(token)) {
    return null;
  }
  const mapped = TRACKING_STATUS_MAP[token];
  if (mapped === undefined) {
    return null;
  }

  const estimatedDeliveryAtRaw = update.estimatedDeliveryAt;
  const expectedDeliveryAt = typeof estimatedDeliveryAtRaw === "string" ? estimatedDeliveryAtRaw : undefined;

  return Object.freeze({
    ref,
    occurredAt,
    orderRef,
    status: mapped,
    ...(expectedDeliveryAt === undefined ? {} : { expectedDeliveryAt }),
  });
}

/* -------------------------------------------------------------------------
 * Generic auth lockout → account_access (account-lock family)
 * ---------------------------------------------------------------------- */

const LOCKOUT_NOT_RELEVANT_TOKENS: ReadonlySet<string> = new Set(["active"]);

const LOCKOUT_STATUS_MAP: Readonly<Record<string, string>> = Object.freeze({
  blocked: "blocked",
  locked: "locked",
  locked_out: "locked_out",
  lockout: "locked_out",
  reset: "unlocked",
  suspended: "blocked",
  unlocked: "unlocked",
});

/**
 * Maps a provider-neutral auth event — `{ id, accountRef, status,
 * occurredAt, failedAttempts? }` — to an `AccountAccessRecord`. An
 * ordinary successful-login event (`status: "active"`) isn't evidence of
 * an account lock, so it returns `null` rather than throwing.
 */
export function fromLockoutEvent(event: unknown): AccountAccessRecord | null {
  if (!isRecord(event)) {
    throw new ConnectorError("Lockout event must be an object.");
  }
  const ref = requiredNonEmptyString(event.id, "Lockout event.id");
  const accountRef = requiredNonEmptyString(event.accountRef, "Lockout event.accountRef");
  const occurredAt = requiredNonEmptyString(event.occurredAt, "Lockout event.occurredAt");
  const statusRaw = requiredNonEmptyString(event.status, "Lockout event.status");

  const token = normalizeToken(statusRaw);
  if (LOCKOUT_NOT_RELEVANT_TOKENS.has(token)) {
    return null;
  }
  const mapped = LOCKOUT_STATUS_MAP[token];
  if (mapped === undefined) {
    return null;
  }

  const failedAttemptsRaw = event.failedAttempts;
  const failedAttempts = typeof failedAttemptsRaw === "number" ? failedAttemptsRaw : undefined;

  return Object.freeze({
    ref,
    occurredAt,
    accountRef,
    status: mapped,
    ...(failedAttempts === undefined ? {} : { failedAttempts }),
  });
}

/* -------------------------------------------------------------------------
 * Return/RMA → fulfillment (wrong-item family)
 * ---------------------------------------------------------------------- */

/**
 * Maps a normalized return/exchange line — `{ id, orderRef, orderedSku,
 * deliveredSku, occurredAt, reason? }` — to a `FulfillmentRecord`. A
 * return whose ordered and delivered SKUs match isn't a wrong-item
 * signal, so it returns `null` rather than throwing.
 */
export function fromReturnLine(line: unknown): FulfillmentRecord | null {
  if (!isRecord(line)) {
    throw new ConnectorError("Return line must be an object.");
  }
  const ref = requiredNonEmptyString(line.id, "Return line.id");
  const orderRef = requiredNonEmptyString(line.orderRef, "Return line.orderRef");
  const orderedSku = requiredNonEmptyString(line.orderedSku, "Return line.orderedSku");
  const deliveredSku = requiredNonEmptyString(line.deliveredSku, "Return line.deliveredSku");
  const occurredAt = requiredNonEmptyString(line.occurredAt, "Return line.occurredAt");

  if (orderedSku === deliveredSku) {
    return null;
  }

  return Object.freeze({
    ref,
    occurredAt,
    orderRef,
    orderedSku,
    deliveredSku,
  });
}

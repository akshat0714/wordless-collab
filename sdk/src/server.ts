import { createHash, createHmac } from "node:crypto";

import {
  parseEvidenceSummary,
  parseSuggestionPolicy,
  parseSuggestionResponse,
  SuggestionValidationError,
  type WordlessEvidenceSummary,
  type WordlessSuggestionLinks,
  type WordlessSuggestionPolicy,
  type WordlessSuggestionResponse,
} from "./index.js";

const SUGGESTIONS_PATH = "/v1/suggestions";
const CHAT_ASSIST_PATH = "/v1/chat/assist";
const API_KEY_PATTERN =
  /^wl_live_[A-Za-z0-9][A-Za-z0-9_-]{1,31}\.[A-Za-z0-9_-]{24,128}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const SUGGESTION_ID_PATTERN = /^sg_[0-9a-f]{32}$/u;
const FEEDBACK_ID_PATTERN = /^fb_[0-9a-f]{32}$/u;
const DETECTOR_ID_PATTERN = /^[a-z][a-z0-9_]{1,48}$/u;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_RETRY_DELAY_MS = 200;
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RETRY_DELAY_MS = 2_000;

export type WordlessJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly WordlessJsonValue[]
  | { readonly [key: string]: WordlessJsonValue };

export interface WordlessUtterance {
  readonly sent_at: string;
  readonly text: string;
}

interface WordlessEvidenceBase {
  readonly ref: string;
  readonly occurred_at: string;
}

export interface WordlessChargeEvidence extends WordlessEvidenceBase {
  readonly type: "charge";
  readonly order_ref?: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly status: "captured" | "completed" | "paid" | "posted" | "succeeded";
}

export interface WordlessShipmentEvidence extends WordlessEvidenceBase {
  readonly type: "shipment";
  readonly order_ref: string;
  readonly status:
    | "cancelled"
    | "delayed"
    | "delivered"
    | "in_transit"
    | "late"
    | "lost"
    | "missing"
    | "overdue"
    | "returned"
    | "shipped";
  readonly expected_delivery_at?: string | null;
}

export interface WordlessFulfillmentEvidence extends WordlessEvidenceBase {
  readonly type: "fulfillment";
  readonly order_ref: string;
  readonly ordered_sku: string;
  readonly delivered_sku: string;
  readonly status: "delivered" | "incorrect_item" | "mismatched" | "wrong_item";
}

export interface WordlessAccountAccessEvidence extends WordlessEvidenceBase {
  readonly type: "account_access";
  readonly account_ref: string;
  readonly status: "active" | "blocked" | "locked" | "locked_out" | "unlocked";
  readonly failed_attempts: number;
}

export type WordlessEvidence =
  | WordlessChargeEvidence
  | WordlessShipmentEvidence
  | WordlessFulfillmentEvidence
  | WordlessAccountAccessEvidence;

export interface WordlessSuggestionRequest {
  readonly schema_version: 1;
  readonly external_event_id: string;
  readonly observed_at: string;
  readonly channel: "email" | "chat" | "phone" | "form" | "web";
  readonly customer_external_id: string;
  readonly utterance: WordlessUtterance;
  readonly evidence: readonly WordlessEvidence[];
  readonly source_system: string;
  readonly metadata: Readonly<Record<string, WordlessJsonValue>>;
}

export interface WordlessChatMessage {
  readonly sent_at: string;
  /** May be empty only when assistance_mode is show_choices. */
  readonly text: string;
}

export interface WordlessChatAssistRequest {
  readonly schema_version: 1;
  readonly external_event_id: string;
  readonly observed_at: string;
  readonly channel: "email" | "chat" | "phone" | "form" | "web";
  readonly customer_external_id: string;
  readonly message: WordlessChatMessage;
  readonly assistance_mode: "auto" | "show_choices";
  readonly evidence: readonly WordlessEvidence[];
  readonly source_system: string;
  readonly metadata: Readonly<Record<string, WordlessJsonValue>>;
}

export interface WordlessChatIntegrationDirective {
  readonly host_action: "show_wordless" | "continue_host_bot";
  readonly render_mode: "choices" | "message" | "none";
}

export interface WordlessChatChoice {
  readonly id: string;
  readonly label: string;
  readonly reply: string;
  readonly detector_id: string | null;
  readonly evidence: readonly WordlessEvidenceSummary[];
}

export type WordlessChatAssistReason =
  | "no_relevant_evidence"
  | "below_confidence_floor"
  | "insufficient_context";

export type WordlessChatSelectionBasis =
  | "evidence_and_message"
  | "explicit_evidence_choices"
  | "contextual_evidence_choices"
  | "grounded_state"
  | "none";

export interface WordlessChatAssistResponse {
  readonly schema_version: 1;
  readonly suggestion_id: string;
  readonly status: "completed";
  readonly outcome:
    | "clarification_choices"
    | "grounded_reply"
    | "clarifying_fallback";
  readonly integration: WordlessChatIntegrationDirective;
  readonly message: string | null;
  readonly choices: readonly WordlessChatChoice[];
  readonly detector_id: string | null;
  readonly evidence: readonly WordlessEvidenceSummary[];
  readonly reason: WordlessChatAssistReason | null;
  readonly selection_basis: WordlessChatSelectionBasis;
  readonly review_required: true;
  readonly read_only: true;
  readonly processing_ms: number;
  readonly redaction_entity_counts: Readonly<Record<string, number>>;
  readonly policy: WordlessSuggestionPolicy;
  readonly links: WordlessSuggestionLinks;
}

export type WordlessFeedbackRequest =
  | {
      readonly schema_version: 1;
      readonly outcome: "confirmed";
      readonly selected_detector_id: string;
      readonly actor: "customer" | "agent";
    }
  | {
      readonly schema_version: 1;
      readonly outcome: "none";
      readonly selected_detector_id: null;
      readonly actor: "customer" | "agent";
    };

export interface WordlessFeedbackResponse {
  readonly schema_version: 1;
  readonly feedback_id: string;
  readonly suggestion_id: string;
  readonly recorded: true;
  readonly outcome: "confirmed" | "none";
  readonly selected_detector_id: string | null;
  readonly actor: "customer" | "agent";
  readonly recorded_at: string;
}

export interface WordlessRequestOptions {
  /** A stable key for this logical operation. It must be reused with the same payload. */
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface WordlessClientOptions {
  /** Origin only. HTTPS is required unless a narrowly scoped HTTP exception applies. */
  readonly baseUrl: string;
  /**
   * Explicitly permit HTTP to an RFC1918/link-local address or single-label service name.
   * Intended only for a trusted private network such as an internal container network.
   */
  readonly allowPrivateHttp?: boolean;
  readonly apiKey: string;
  readonly signingSecret: string;
  /** Per-attempt timeout. One safe retry may make total wall time longer. */
  readonly timeoutMs?: number;
  /** Maximum decompressed response bytes accepted from the API. */
  readonly maxResponseBytes?: number;
  /** Delay before the one automatic retry. */
  readonly retryDelayMs?: number;
  /** Injectable fetch implementation for controlled runtimes and tests. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface WordlessClient {
  readonly baseUrl: string;
  assist(
    request: WordlessChatAssistRequest,
    options: WordlessRequestOptions,
  ): Promise<WordlessChatAssistResponse>;
  suggest(
    request: WordlessSuggestionRequest,
    options: WordlessRequestOptions,
  ): Promise<WordlessSuggestionResponse>;
  recordFeedback(
    suggestionId: string,
    feedback: WordlessFeedbackRequest,
    options: WordlessRequestOptions,
  ): Promise<WordlessFeedbackResponse>;
}

export class WordlessSdkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "WordlessSdkError";
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: cause,
        writable: true,
      });
    }
  }
}

export class WordlessConfigurationError extends WordlessSdkError {
  constructor(message: string) {
    super(message);
    this.name = "WordlessConfigurationError";
  }
}

export class WordlessRequestError extends WordlessSdkError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "WordlessRequestError";
  }
}

export class WordlessRequestAbortedError extends WordlessSdkError {
  constructor() {
    super("The Wordless request was aborted by the caller.");
    this.name = "WordlessRequestAbortedError";
  }
}

export class WordlessTimeoutError extends WordlessSdkError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, cause?: unknown) {
    super(`The Wordless request exceeded the ${timeoutMs} ms per-attempt timeout.`, cause);
    this.name = "WordlessTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class WordlessNetworkError extends WordlessSdkError {
  constructor(cause?: unknown) {
    super("The Wordless API could not be reached.", cause);
    this.name = "WordlessNetworkError";
  }
}

export class WordlessResponseError extends WordlessSdkError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "WordlessResponseError";
  }
}

export class WordlessApiError extends WordlessSdkError {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  /** Server-supplied safe message, present only when the error envelope validates. */
  readonly serverMessage: string | null;

  constructor(options: {
    status: number;
    code: string | null;
    requestId: string | null;
    retryable: boolean;
    retryAfterMs: number | null;
    serverMessage: string | null;
  }) {
    const suffix = options.code === null ? "" : ` (${options.code})`;
    super(`The Wordless API returned HTTP ${options.status}${suffix}.`);
    this.name = "WordlessApiError";
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.serverMessage = options.serverMessage;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
  ErrorType: typeof WordlessRequestError | typeof WordlessResponseError,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new ErrorType(`${label} does not match the exact versioned contract.`);
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function allowedAndRequiredKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  if (
    Object.keys(value).some((key) => !allowedSet.has(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new WordlessRequestError(`${label} does not match the exact versioned contract.`);
  }
}

function validatePositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
  maximum: number,
  allowZero = false,
): number {
  const resolved = value ?? fallback;
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new WordlessConfigurationError(
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return resolved;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  return (
    octets.length === 4 &&
    octets.every((part) => /^(?:0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255) &&
    Number(octets[0]) === 127
  );
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  if (isLoopbackHost(host)) return true;
  if (/^f[cd][0-9a-f:]*$/u.test(host) || /^fe[89ab][0-9a-f:]*$/u.test(host)) return true;
  if (!host.includes(".") && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(host)) return true;
  const octets = host.split(".");
  if (
    octets.length !== 4 ||
    !octets.every((part) => /^(?:0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255)
  ) return false;
  const first = Number(octets[0]);
  const second = Number(octets[1]);
  return first === 10 || first === 127 || first === 192 && second === 168 ||
    first === 172 && second >= 16 && second <= 31 || first === 169 && second === 254;
}

function normalizeBaseUrl(value: string, allowPrivateHttp = false): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    [...value].some((character) => character.charCodeAt(0) < 0x20) ||
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+\/?$/u.test(value)
  ) {
    throw new WordlessConfigurationError("baseUrl must be a trimmed API origin.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new WordlessConfigurationError("baseUrl must be a valid HTTP(S) API origin.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WordlessConfigurationError("baseUrl must use HTTP or HTTPS.");
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new WordlessConfigurationError(
      "baseUrl must be an origin without credentials, a path, query, or fragment.",
    );
  }
  if (
    parsed.protocol !== "https:" &&
    !isLoopbackHost(parsed.hostname) &&
    !(allowPrivateHttp && isPrivateHost(parsed.hostname))
  ) {
    throw new WordlessConfigurationError(
      "baseUrl must use HTTPS unless the host is loopback or private HTTP is explicitly enabled.",
    );
  }
  return parsed.origin;
}

function validateCredentials(apiKey: string, signingSecret: string): void {
  if (typeof apiKey !== "string" || !API_KEY_PATTERN.test(apiKey)) {
    throw new WordlessConfigurationError("apiKey does not match the Wordless live-key format.");
  }
  if (
    typeof signingSecret !== "string" ||
    signingSecret.trim().length === 0
  ) {
    throw new WordlessConfigurationError("signingSecret must contain 32–256 characters.");
  }
  const secretLength = Array.from(signingSecret).length;
  if (
    secretLength < 32 ||
    secretLength > 256
  ) {
    throw new WordlessConfigurationError("signingSecret must contain 32–256 characters.");
  }
}

function validateIdempotencyKey(value: string): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new WordlessRequestError(
      "idempotencyKey must contain 16–128 allowed characters and begin with a letter or number.",
    );
  }
  return value;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new WordlessRequestError("Request JSON cannot contain a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new WordlessRequestError("Request values must be JSON-compatible.");
  }
  if (ancestors.has(value)) {
    throw new WordlessRequestError("Request JSON cannot contain a cycle.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new WordlessRequestError("Request JSON cannot contain sparse arrays.");
        }
        items.push(canonicalJson(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new WordlessRequestError("Request JSON must contain plain objects only.");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new WordlessRequestError("Request JSON cannot contain symbol keys.");
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function serializeRequest(value: unknown): string {
  const body = canonicalJson(value);
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw new WordlessRequestError("The serialized request exceeds the 1 MiB API maximum.");
  }
  return body;
}

function stringLength(value: string): number {
  return Array.from(value).length;
}

function requestString(
  value: unknown,
  label: string,
  options: { pattern?: RegExp; minimum?: number; maximum: number; trimmed?: boolean },
): string {
  const minimum = options.minimum ?? 1;
  if (
    typeof value !== "string" ||
    stringLength(value) < minimum ||
    stringLength(value) > options.maximum ||
    (options.trimmed !== false && value !== value.trim()) ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    throw new WordlessRequestError(`${label} is invalid.`);
  }
  return value;
}

const AWARE_ISO_TIMESTAMP_PATTERN =
  /^(?<year>[0-9]{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12][0-9]|3[01])T(?<hour>[01][0-9]|2[0-3]):(?<minute>[0-5][0-9])(?::(?<second>[0-5][0-9])(?:\.(?<fraction>[0-9]+))?)?(?<zone>Z|(?<offsetSign>[+-])(?<offsetHour>[01][0-9]|2[0-3]):(?<offsetMinute>[0-5][0-9]))$/u;

interface ParsedAwareTimestamp {
  readonly milliseconds: number;
  readonly instantKey: string;
}

function parseAwareTimestamp(value: unknown, label: string): ParsedAwareTimestamp {
  const timestamp = requestString(value, label, { maximum: 64, pattern: AWARE_ISO_TIMESTAMP_PATTERN });
  const match = AWARE_ISO_TIMESTAMP_PATTERN.exec(timestamp);
  if (match?.groups === undefined) {
    throw new WordlessRequestError(`${label} must be a timezone-aware ISO timestamp.`);
  }
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ];
  if (year === 0 || daysInMonth === undefined || day > daysInMonth) {
    throw new WordlessRequestError(`${label} must be a timezone-aware ISO timestamp.`);
  }
  const hour = Number(match.groups.hour);
  const minute = Number(match.groups.minute);
  const second = Number(match.groups.second ?? "0");
  const offsetMinutes =
    match.groups.zone === "Z"
      ? 0
      : (match.groups.offsetSign === "-" ? -1 : 1) *
        (Number(match.groups.offsetHour) * 60 + Number(match.groups.offsetMinute));
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  const epochSeconds = BigInt(Math.trunc(local.getTime() / 1_000) - offsetMinutes * 60);
  // Pydantic/Python datetimes retain at most six fractional digits and
  // truncate additional request precision before response serialization.
  const fraction = (match.groups.fraction ?? "")
    .padEnd(6, "0")
    .slice(0, 6)
    .replace(/0+$/u, "");
  const milliseconds = Number(epochSeconds) * 1_000 +
    (fraction.length === 0 ? 0 : Number(`0.${fraction}`) * 1_000);
  if (!Number.isFinite(milliseconds)) {
    throw new WordlessRequestError(`${label} must be a timezone-aware ISO timestamp.`);
  }
  return { milliseconds, instantKey: `${epochSeconds}:${fraction}` };
}

function requestTimestamp(value: unknown, label: string): number {
  return parseAwareTimestamp(value, label).milliseconds;
}

function validateReference(value: unknown, label: string, nullable = false): void {
  if (nullable && value === null) return;
  requestString(value, label, { maximum: 128, pattern: REFERENCE_PATTERN });
}

function validateChargeAmount(value: unknown, label: string): void {
  const amount = requestString(value, label, { maximum: 32 });
  const match = /^[+]?(?:(?:([0-9]+)(?:\.([0-9]*))?)|(?:\.([0-9]+)))(?:[eE]([+-]?[0-9]+))?$/u.exec(
    amount,
  );
  if (match === null) throw new WordlessRequestError(`${label} must be a positive decimal string.`);
  const digits = `${match[1] ?? ""}${match[2] ?? ""}${match[3] ?? ""}`;
  const fractionalDigits = (match[2] ?? match[3] ?? "").length;
  const exponent = match[4] === undefined ? 0 : Number(match[4]);
  if (
    !/[1-9]/u.test(digits) ||
    Number.isNaN(exponent) ||
    exponent - fractionalDigits < -2
  ) {
    throw new WordlessRequestError(
      `${label} must be positive with at most two decimal places.`,
    );
  }
}

function validateEvidence(
  value: unknown,
  index: number,
  observedAt: number,
  references: Set<string>,
): void {
  const label = `evidence[${index}]`;
  if (!isRecord(value)) throw new WordlessRequestError(`${label} must be an object.`);
  const requiredBase = ["occurred_at", "ref", "type"];
  const ref = requestString(value.ref, `${label}.ref`, {
    maximum: 128,
    pattern: REFERENCE_PATTERN,
  });
  if (references.has(ref)) {
    throw new WordlessRequestError("Evidence refs must be unique within a request.");
  }
  references.add(ref);
  const occurredAt = requestTimestamp(value.occurred_at, `${label}.occurred_at`);
  if (occurredAt > observedAt) {
    throw new WordlessRequestError(`${label}.occurred_at cannot be after observed_at.`);
  }

  switch (value.type) {
    case "charge": {
      allowedAndRequiredKeys(
        value,
        [...requiredBase, "amount", "currency", "order_ref", "status"],
        [...requiredBase, "amount", "currency", "status"],
        label,
      );
      if (Object.prototype.hasOwnProperty.call(value, "order_ref")) {
        validateReference(value.order_ref, `${label}.order_ref`, true);
      }
      validateChargeAmount(value.amount, `${label}.amount`);
      requestString(value.currency, `${label}.currency`, {
        maximum: 3,
        minimum: 3,
        pattern: /^[A-Z]{3}$/u,
      });
      if (!new Set(["captured", "completed", "paid", "posted", "succeeded"]).has(value.status as string)) {
        throw new WordlessRequestError(`${label}.status is invalid for charge evidence.`);
      }
      return;
    }
    case "shipment": {
      allowedAndRequiredKeys(
        value,
        [...requiredBase, "expected_delivery_at", "order_ref", "status"],
        [...requiredBase, "order_ref", "status"],
        label,
      );
      validateReference(value.order_ref, `${label}.order_ref`);
      if (
        Object.prototype.hasOwnProperty.call(value, "expected_delivery_at") &&
        value.expected_delivery_at !== null
      ) {
        requestTimestamp(value.expected_delivery_at, `${label}.expected_delivery_at`);
      }
      if (
        !new Set([
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
        ]).has(value.status as string)
      ) {
        throw new WordlessRequestError(`${label}.status is invalid for shipment evidence.`);
      }
      return;
    }
    case "fulfillment": {
      allowedAndRequiredKeys(
        value,
        [...requiredBase, "delivered_sku", "ordered_sku", "order_ref", "status"],
        [...requiredBase, "delivered_sku", "ordered_sku", "order_ref", "status"],
        label,
      );
      validateReference(value.order_ref, `${label}.order_ref`);
      validateReference(value.ordered_sku, `${label}.ordered_sku`);
      validateReference(value.delivered_sku, `${label}.delivered_sku`);
      if (!new Set(["delivered", "incorrect_item", "mismatched", "wrong_item"]).has(value.status as string)) {
        throw new WordlessRequestError(`${label}.status is invalid for fulfillment evidence.`);
      }
      return;
    }
    case "account_access": {
      allowedAndRequiredKeys(
        value,
        [...requiredBase, "account_ref", "failed_attempts", "status"],
        [...requiredBase, "account_ref", "failed_attempts", "status"],
        label,
      );
      validateReference(value.account_ref, `${label}.account_ref`);
      if (
        !Number.isSafeInteger(value.failed_attempts) ||
        (value.failed_attempts as number) < 0 ||
        (value.failed_attempts as number) > 1_000
      ) {
        throw new WordlessRequestError(`${label}.failed_attempts must be an integer from 0 through 1000.`);
      }
      if (!new Set(["active", "blocked", "locked", "locked_out", "unlocked"]).has(value.status as string)) {
        throw new WordlessRequestError(`${label}.status is invalid for account-access evidence.`);
      }
      return;
    }
    default:
      throw new WordlessRequestError(`${label}.type is not a supported evidence discriminator.`);
  }
}

function validateSuggestionEnvelope(value: unknown): asserts value is WordlessSuggestionRequest {
  if (!isRecord(value)) {
    throw new WordlessRequestError("Suggestion request must be an object.");
  }
  exactKeys(
    value,
    [
      "channel",
      "customer_external_id",
      "evidence",
      "external_event_id",
      "metadata",
      "observed_at",
      "schema_version",
      "source_system",
      "utterance",
    ],
    "Suggestion request",
    WordlessRequestError,
  );
  if (value.schema_version !== 1) {
    throw new WordlessRequestError("Suggestion request has an invalid versioned envelope.");
  }
  requestString(value.external_event_id, "external_event_id", {
    maximum: 128,
    pattern: REFERENCE_PATTERN,
  });
  const observedAt = requestTimestamp(value.observed_at, "observed_at");
  if (!new Set(["email", "chat", "phone", "form", "web"]).has(value.channel as string)) {
    throw new WordlessRequestError("channel is invalid.");
  }
  requestString(value.customer_external_id, "customer_external_id", { maximum: 512 });
  requestString(value.source_system, "source_system", {
    maximum: 64,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u,
  });
  if (!isRecord(value.utterance)) {
    throw new WordlessRequestError("utterance must be an object.");
  }
  exactKeys(value.utterance, ["sent_at", "text"], "utterance", WordlessRequestError);
  const sentAt = requestTimestamp(value.utterance.sent_at, "utterance.sent_at");
  requestString(value.utterance.text, "utterance.text", { maximum: 4_000 });
  if (sentAt > observedAt) {
    throw new WordlessRequestError("utterance.sent_at cannot be after observed_at.");
  }
  if (!Array.isArray(value.evidence) || value.evidence.length > 100) {
    throw new WordlessRequestError("evidence must be an array of at most 100 records.");
  }
  const references = new Set<string>();
  value.evidence.forEach((item, index) => validateEvidence(item, index, observedAt, references));
  if (!isRecord(value.metadata) || Object.keys(value.metadata).length > 50) {
    throw new WordlessRequestError("metadata must be an object with at most 50 keys.");
  }
  for (const key of Object.keys(value.metadata)) {
    requestString(key, "metadata key", { maximum: 64 });
  }
  canonicalJson(value.metadata);
}

function validateChatAssistEnvelope(value: unknown): asserts value is WordlessChatAssistRequest {
  if (!isRecord(value)) {
    throw new WordlessRequestError("Chat-assist request must be an object.");
  }
  exactKeys(
    value,
    [
      "assistance_mode",
      "channel",
      "customer_external_id",
      "evidence",
      "external_event_id",
      "message",
      "metadata",
      "observed_at",
      "schema_version",
      "source_system",
    ],
    "Chat-assist request",
    WordlessRequestError,
  );
  if (value.schema_version !== 1) {
    throw new WordlessRequestError("Chat-assist request has an invalid versioned envelope.");
  }
  requestString(value.external_event_id, "external_event_id", {
    maximum: 128,
    pattern: REFERENCE_PATTERN,
  });
  const observedAt = requestTimestamp(value.observed_at, "observed_at");
  if (!new Set(["email", "chat", "phone", "form", "web"]).has(value.channel as string)) {
    throw new WordlessRequestError("channel is invalid.");
  }
  requestString(value.customer_external_id, "customer_external_id", { maximum: 512 });
  requestString(value.source_system, "source_system", {
    maximum: 64,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u,
  });
  if (value.assistance_mode !== "auto" && value.assistance_mode !== "show_choices") {
    throw new WordlessRequestError("assistance_mode is invalid.");
  }
  if (!isRecord(value.message)) {
    throw new WordlessRequestError("message must be an object.");
  }
  exactKeys(value.message, ["sent_at", "text"], "message", WordlessRequestError);
  const sentAt = requestTimestamp(value.message.sent_at, "message.sent_at");
  if (typeof value.message.text !== "string" || stringLength(value.message.text) > 4_000) {
    throw new WordlessRequestError("message.text must be a string of at most 4000 characters.");
  }
  if (value.message.text !== value.message.text.trim()) {
    throw new WordlessRequestError("message.text must be trimmed.");
  }
  if (value.message.text.length === 0 && value.assistance_mode !== "show_choices") {
    throw new WordlessRequestError(
      "An empty message.text requires assistance_mode show_choices.",
    );
  }
  if (sentAt > observedAt) {
    throw new WordlessRequestError("message.sent_at cannot be after observed_at.");
  }
  if (!Array.isArray(value.evidence) || value.evidence.length > 100) {
    throw new WordlessRequestError("evidence must be an array of at most 100 records.");
  }
  const references = new Set<string>();
  value.evidence.forEach((item, index) => validateEvidence(item, index, observedAt, references));
  if (!isRecord(value.metadata) || Object.keys(value.metadata).length > 50) {
    throw new WordlessRequestError("metadata must be an object with at most 50 keys.");
  }
  for (const key of Object.keys(value.metadata)) {
    requestString(key, "metadata key", { maximum: 64 });
  }
  canonicalJson(value.metadata);
}

function validateFeedbackRequest(value: unknown): asserts value is WordlessFeedbackRequest {
  if (!isRecord(value)) {
    throw new WordlessRequestError("Feedback request must be an object.");
  }
  exactKeys(
    value,
    ["actor", "outcome", "schema_version", "selected_detector_id"],
    "Feedback request",
    WordlessRequestError,
  );
  if (
    value.schema_version !== 1 ||
    (value.actor !== "customer" && value.actor !== "agent") ||
    (value.outcome !== "confirmed" && value.outcome !== "none") ||
    (value.outcome === "confirmed" &&
      (typeof value.selected_detector_id !== "string" ||
        !DETECTOR_ID_PATTERN.test(value.selected_detector_id))) ||
    (value.outcome === "none" && value.selected_detector_id !== null)
  ) {
    throw new WordlessRequestError("Feedback request has an invalid versioned contract.");
  }
}

function requiredResponseString(
  value: Record<string, unknown>,
  key: string,
  pattern?: RegExp,
): string {
  const item = value[key];
  if (
    typeof item !== "string" ||
    item.length === 0 ||
    item !== item.trim() ||
    (pattern !== undefined && !pattern.test(item))
  ) {
    throw new WordlessResponseError(`Feedback response field ${key} is invalid.`);
  }
  return item;
}

/** Validate a feedback response before it reaches application code. */
export function parseFeedbackResponse(
  value: unknown,
  expectedSuggestionId?: string,
): WordlessFeedbackResponse {
  if (!isRecord(value)) {
    throw new WordlessResponseError("Feedback response must be an object.");
  }
  exactKeys(
    value,
    [
      "actor",
      "feedback_id",
      "outcome",
      "recorded",
      "recorded_at",
      "schema_version",
      "selected_detector_id",
      "suggestion_id",
    ],
    "Feedback response",
    WordlessResponseError,
  );
  const feedbackId = requiredResponseString(value, "feedback_id", FEEDBACK_ID_PATTERN);
  const suggestionId = requiredResponseString(value, "suggestion_id", SUGGESTION_ID_PATTERN);
  const recordedAt = requiredResponseString(value, "recorded_at");
  const timestamp = Date.parse(recordedAt);
  if (
    value.schema_version !== 1 ||
    value.recorded !== true ||
    (value.actor !== "customer" && value.actor !== "agent") ||
    (value.outcome !== "confirmed" && value.outcome !== "none") ||
    !Number.isFinite(timestamp) ||
    !/T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(recordedAt) ||
    (expectedSuggestionId !== undefined && suggestionId !== expectedSuggestionId) ||
    (value.outcome === "confirmed" &&
      (typeof value.selected_detector_id !== "string" ||
        !DETECTOR_ID_PATTERN.test(value.selected_detector_id))) ||
    (value.outcome === "none" && value.selected_detector_id !== null)
  ) {
    throw new WordlessResponseError("Feedback response does not match the requested operation.");
  }
  return {
    schema_version: 1,
    feedback_id: feedbackId,
    suggestion_id: suggestionId,
    recorded: true,
    outcome: value.outcome,
    selected_detector_id: value.selected_detector_id,
    actor: value.actor,
    recorded_at: recordedAt,
  } as WordlessFeedbackResponse;
}

function responseChatString(
  value: unknown,
  label: string,
  maximum: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    stringLength(value) > maximum ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new WordlessResponseError(`${label} is invalid.`);
  }
  return value;
}

function parseChatEvidence(value: unknown, label: string): readonly WordlessEvidenceSummary[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new WordlessResponseError(`${label} must contain at most 20 evidence records.`);
  }
  try {
    return value.map((item, index) => parseEvidenceSummary(item, index));
  } catch (cause) {
    if (cause instanceof SuggestionValidationError) {
      throw new WordlessResponseError(`${label} is invalid.`, cause);
    }
    throw cause;
  }
}

function evidenceMatches(
  first: readonly WordlessEvidenceSummary[],
  second: readonly WordlessEvidenceSummary[],
): boolean {
  return (
    first.length === second.length &&
    first.every((item, index) => {
      const other = second[index];
      return (
        other !== undefined &&
        item.ref === other.ref &&
        item.source === other.source &&
        item.kind === other.kind &&
        item.input_index === other.input_index &&
        item.occurred_at === other.occurred_at &&
        item.provenance === other.provenance
      );
    })
  );
}

/** Validate an untrusted v1 chat-assist response before host code receives it. */
export function parseChatAssistResponse(value: unknown): WordlessChatAssistResponse {
  if (!isRecord(value)) {
    throw new WordlessResponseError("Chat-assist response must be an object.");
  }
  exactKeys(
    value,
    [
      "choices",
      "detector_id",
      "evidence",
      "integration",
      "links",
      "message",
      "outcome",
      "policy",
      "processing_ms",
      "read_only",
      "reason",
      "redaction_entity_counts",
      "review_required",
      "schema_version",
      "selection_basis",
      "status",
      "suggestion_id",
    ],
    "Chat-assist response",
    WordlessResponseError,
  );
  if (value.schema_version !== 1 || value.status !== "completed") {
    throw new WordlessResponseError("Chat-assist response version or status is invalid.");
  }
  const suggestionId = responseChatString(
    value.suggestion_id,
    "suggestion_id",
    35,
    SUGGESTION_ID_PATTERN,
  );
  if (
    value.outcome !== "clarification_choices" &&
    value.outcome !== "grounded_reply" &&
    value.outcome !== "clarifying_fallback"
  ) {
    throw new WordlessResponseError("Chat-assist outcome is invalid.");
  }
  if (!isRecord(value.integration)) {
    throw new WordlessResponseError("Chat-assist integration directive must be an object.");
  }
  exactKeys(
    value.integration,
    ["host_action", "render_mode"],
    "Chat-assist integration directive",
    WordlessResponseError,
  );
  if (
    (value.integration.host_action !== "show_wordless" &&
      value.integration.host_action !== "continue_host_bot") ||
    (value.integration.render_mode !== "choices" &&
      value.integration.render_mode !== "message" &&
      value.integration.render_mode !== "none") ||
    (value.integration.host_action === "continue_host_bot" &&
      value.integration.render_mode !== "none") ||
    (value.integration.host_action === "show_wordless" &&
      value.integration.render_mode === "none")
  ) {
    throw new WordlessResponseError("Chat-assist integration directive is invalid.");
  }
  const message =
    value.message === null
      ? null
      : responseChatString(value.message, "Chat-assist message", 500);
  if (!Array.isArray(value.choices) || value.choices.length > 3) {
    throw new WordlessResponseError("Chat-assist choices must contain at most three items.");
  }
  const choiceIds = new Set<string>();
  const choices = value.choices.map((item, index): WordlessChatChoice => {
    if (!isRecord(item)) {
      throw new WordlessResponseError(`Chat-assist choice ${index + 1} must be an object.`);
    }
    exactKeys(
      item,
      ["detector_id", "evidence", "id", "label", "reply"],
      `Chat-assist choice ${index + 1}`,
      WordlessResponseError,
    );
    const id = responseChatString(item.id, "Chat-assist choice id", 49, DETECTOR_ID_PATTERN);
    if (choiceIds.has(id)) {
      throw new WordlessResponseError(`Chat-assist choice id ${id} is duplicated.`);
    }
    choiceIds.add(id);
    const detectorId =
      item.detector_id === null
        ? null
        : responseChatString(
            item.detector_id,
            "Chat-assist choice detector_id",
            49,
            DETECTOR_ID_PATTERN,
          );
    const evidence = parseChatEvidence(item.evidence, `Chat-assist choice ${id} evidence`);
    if ((detectorId === null) !== (evidence.length === 0)) {
      throw new WordlessResponseError(
        "A detector-backed chat choice must cite evidence, and an unbacked choice cannot cite it.",
      );
    }
    return {
      id,
      label: responseChatString(item.label, "Chat-assist choice label", 72),
      reply: responseChatString(item.reply, "Chat-assist choice reply", 240),
      detector_id: detectorId,
      evidence,
    };
  });
  const detectorId =
    value.detector_id === null
      ? null
      : responseChatString(value.detector_id, "Chat-assist detector_id", 49, DETECTOR_ID_PATTERN);
  const evidence = parseChatEvidence(value.evidence, "Chat-assist evidence");
  if (
    value.reason !== null &&
    value.reason !== "no_relevant_evidence" &&
    value.reason !== "below_confidence_floor" &&
    value.reason !== "insufficient_context"
  ) {
    throw new WordlessResponseError("Chat-assist reason is invalid.");
  }
  if (
    value.selection_basis !== "evidence_and_message" &&
    value.selection_basis !== "explicit_evidence_choices" &&
    value.selection_basis !== "contextual_evidence_choices" &&
    value.selection_basis !== "grounded_state" &&
    value.selection_basis !== "none"
  ) {
    throw new WordlessResponseError("Chat-assist selection_basis is invalid.");
  }
  if (value.review_required !== true || value.read_only !== true) {
    throw new WordlessResponseError("Chat-assist safety policy is invalid.");
  }
  if (
    !Number.isSafeInteger(value.processing_ms) ||
    (value.processing_ms as number) < 0
  ) {
    throw new WordlessResponseError("Chat-assist processing_ms is invalid.");
  }
  if (!isRecord(value.redaction_entity_counts)) {
    throw new WordlessResponseError("Chat-assist redaction_entity_counts must be an object.");
  }
  const redactionEntityCounts: Record<string, number> = {};
  for (const [name, count] of Object.entries(value.redaction_entity_counts)) {
    if (
      name.length === 0 ||
      name !== name.trim() ||
      stringLength(name) > 64 ||
      !Number.isSafeInteger(count) ||
      (count as number) < 0
    ) {
      throw new WordlessResponseError("Chat-assist redaction entity counts are invalid.");
    }
    redactionEntityCounts[name] = count as number;
  }
  let policy: WordlessSuggestionPolicy;
  try {
    policy = parseSuggestionPolicy(value.policy);
  } catch (cause) {
    if (cause instanceof SuggestionValidationError) {
      throw new WordlessResponseError("Chat-assist policy is invalid.", cause);
    }
    throw cause;
  }
  if (!isRecord(value.links)) {
    throw new WordlessResponseError("Chat-assist links must be an object.");
  }
  exactKeys(value.links, ["events", "feedback", "self"], "Chat-assist links", WordlessResponseError);
  const base = `/v1/suggestions/${suggestionId}`;
  const links: WordlessSuggestionLinks = {
    self: responseChatString(value.links.self, "Chat-assist self link", 256),
    events: responseChatString(value.links.events, "Chat-assist events link", 256),
    feedback: responseChatString(value.links.feedback, "Chat-assist feedback link", 256),
  };
  if (
    links.self !== base ||
    links.events !== `${base}/events` ||
    links.feedback !== `${base}/feedback`
  ) {
    throw new WordlessResponseError("Chat-assist links do not match the suggestion id.");
  }

  if (value.outcome === "clarification_choices") {
    const supported = choices.filter((choice) => choice.detector_id !== null);
    if (
      value.integration.host_action !== "show_wordless" ||
      value.integration.render_mode !== "choices" ||
      message === null ||
      choices.length < 2 ||
      detectorId === null ||
      evidence.length === 0 ||
      value.reason !== null ||
      (value.selection_basis !== "explicit_evidence_choices" &&
        value.selection_basis !== "contextual_evidence_choices" &&
        value.selection_basis !== "evidence_and_message") ||
      supported.length < 1 ||
      supported.length > 2 ||
      !choices.some((choice) => choice.detector_id === null) ||
      supported[0]?.detector_id !== detectorId ||
      !evidenceMatches(supported[0]?.evidence ?? [], evidence)
    ) {
      throw new WordlessResponseError("Chat-assist clarification choices are inconsistent.");
    }
  } else if (value.outcome === "grounded_reply") {
    if (
      value.integration.host_action !== "show_wordless" ||
      value.integration.render_mode !== "message" ||
      message === null ||
      choices.length !== 0 ||
      evidence.length === 0 ||
      value.reason !== null ||
      value.selection_basis !== "grounded_state" ||
      detectorId !== null
    ) {
      throw new WordlessResponseError("Chat-assist grounded reply is inconsistent.");
    }
  } else if (
    detectorId !== null ||
    evidence.length !== 0 ||
    value.reason === null ||
    value.selection_basis !== "none" ||
    (value.integration.host_action === "continue_host_bot"
      ? message !== null || choices.length !== 0
      : value.integration.render_mode === "choices"
        ? message === null || choices.length < 2 || choices.length > 3 ||
          choices.some((choice) => choice.detector_id !== null || choice.evidence.length !== 0)
        : value.integration.render_mode === "message"
          ? message === null || choices.length !== 0
          : true)
  ) {
    throw new WordlessResponseError("Chat-assist fallback is inconsistent.");
  }

  return {
    schema_version: 1,
    suggestion_id: suggestionId,
    status: "completed",
    outcome: value.outcome,
    integration: {
      host_action: value.integration.host_action,
      render_mode: value.integration.render_mode,
    },
    message,
    choices,
    detector_id: detectorId,
    evidence,
    reason: value.reason,
    selection_basis: value.selection_basis,
    review_required: true,
    read_only: true,
    processing_ms: value.processing_ms as number,
    redaction_entity_counts: redactionEntityCounts,
    policy,
    links,
  };
}

/**
 * Create a deterministic, API-valid key from durable source identifiers.
 * Use a different namespace for suggestions and feedback.
 */
export function createIdempotencyKey(namespace: string, ...stableParts: readonly string[]): string {
  if (
    typeof namespace !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/u.test(namespace) ||
    stableParts.length === 0 ||
    stableParts.some((part) => typeof part !== "string")
  ) {
    throw new WordlessRequestError(
      "createIdempotencyKey needs a 1–63 character namespace and at least one string part.",
    );
  }
  const hash = createHash("sha256");
  hash.update("wordless-idempotency-v1\0", "utf8");
  for (const part of stableParts) {
    const bytes = Buffer.from(part, "utf8");
    hash.update(String(bytes.length), "ascii");
    hash.update(":", "ascii");
    hash.update(bytes);
    hash.update("\0", "ascii");
  }
  return `${namespace}-${hash.digest("hex")}`;
}

function canonicalSignature(
  timestamp: string,
  path: string,
  idempotencyKey: string,
  body: string,
  signingSecret: string,
): string {
  const prefix = `v1:${timestamp}\nPOST\n${path}\n${idempotencyKey}\n`;
  return createHmac("sha256", Buffer.from(signingSecret, "utf8"))
    .update(Buffer.from(prefix, "utf8"))
    .update(Buffer.from(body, "utf8"))
    .digest("hex");
}

async function readBoundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^[0-9]+$/u.test(contentLength)) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > maximum) {
      throw new WordlessResponseError(`Wordless response exceeded ${maximum} bytes.`);
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the size error even if cancellation itself fails.
      }
      throw new WordlessResponseError(`Wordless response exceeded ${maximum} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function readBoundedText(response: Response, maximum: number): Promise<string> {
  const bytes = await readBoundedBytes(response, maximum);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new WordlessResponseError("Wordless response was not valid UTF-8.", cause);
  }
}

async function readJson(response: Response, maximum: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    contentType === undefined ||
    (contentType !== "application/json" && !contentType.endsWith("+json"))
  ) {
    throw new WordlessResponseError("Wordless response did not use a JSON content type.");
  }
  const text = await readBoundedText(response, maximum);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new WordlessResponseError("Wordless response was not valid JSON.", cause);
  }
}

function safeRequestId(value: string | null): string | null {
  return value !== null && /^req_[0-9a-f]{24}$/u.test(value) ? value : null;
}

function retryAfterMilliseconds(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (value === null) return null;
  let milliseconds: number;
  if (/^[0-9]+(?:\.[0-9]+)?$/u.test(value)) {
    milliseconds = Number(value) * 1_000;
  } else {
    milliseconds = Date.parse(value) - Date.now();
  }
  if (!Number.isFinite(milliseconds)) return null;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Math.round(milliseconds)));
}

async function apiError(response: Response, maximum: number): Promise<WordlessApiError> {
  const text = await readBoundedText(response, maximum);
  let code: string | null = null;
  let serverMessage: string | null = null;
  let envelopeRequestId: string | null = null;
  try {
    const value = JSON.parse(text) as unknown;
    if (
      isRecord(value) &&
      hasExactKeys(value, ["error"]) &&
      isRecord(value.error) &&
      hasExactKeys(value.error, ["code", "message", "request_id"]) &&
      typeof value.error.code === "string" &&
      /^[a-z][a-z0-9_]{1,63}$/u.test(value.error.code) &&
      typeof value.error.message === "string" &&
      value.error.message.length >= 1 &&
      value.error.message.length <= 300 &&
      !/[\u0000-\u001f\u007f]/u.test(value.error.message) &&
      typeof value.error.request_id === "string" &&
      /^req_[0-9a-f]{24}$/u.test(value.error.request_id)
    ) {
      code = value.error.code;
      serverMessage = value.error.message;
      envelopeRequestId = value.error.request_id;
    }
  } catch {
    // Non-JSON upstream failures retain only their status code.
  }
  const retryable =
    [408, 425, 429, 500, 502, 503, 504].includes(response.status) ||
    (response.status === 409 && code === "suggestion_in_progress");
  return new WordlessApiError({
    status: response.status,
    code,
    requestId:
      safeRequestId(response.headers.get("x-wordless-request-id")) ?? envelopeRequestId,
    retryable,
    retryAfterMs: retryAfterMilliseconds(response),
    serverMessage,
  });
}

function wait(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new WordlessRequestAbortedError());
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new WordlessRequestAbortedError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function expectedEvidenceBinding(evidence: WordlessEvidence): {
  readonly source: string;
  readonly kind: string;
  readonly provenance: "exported";
  readonly instantKey: string;
} {
  let source: string;
  let kind: string;
  switch (evidence.type) {
    case "charge":
      source = "billing";
      kind = "charge";
      break;
    case "shipment":
      source = "shipping";
      kind = "shipment";
      break;
    case "fulfillment":
      source = "orders";
      kind = "fulfillment";
      break;
    case "account_access":
      source = "authentication";
      kind = "account";
      break;
  }
  return {
    source,
    kind,
    provenance: "exported",
    instantKey: parseAwareTimestamp(evidence.occurred_at, "evidence.occurred_at").instantKey,
  };
}

function assertEvidenceBindings(
  summaries: readonly WordlessEvidenceSummary[],
  submitted: readonly WordlessEvidence[],
  label: string,
): void {
  for (const summary of summaries) {
    const evidence = submitted[summary.input_index];
    if (evidence === undefined) {
      throw new WordlessResponseError(`${label} does not map to the submitted request.`);
    }
    const expected = expectedEvidenceBinding(evidence);
    let responseInstant: string;
    try {
      responseInstant = parseAwareTimestamp(
        summary.occurred_at,
        `${label} occurred_at`,
      ).instantKey;
    } catch (cause) {
      throw new WordlessResponseError(`${label} has an invalid occurred_at binding.`, cause);
    }
    if (
      summary.source !== expected.source ||
      summary.kind !== expected.kind ||
      summary.provenance !== expected.provenance ||
      responseInstant !== expected.instantKey
    ) {
      throw new WordlessResponseError(
        `${label} does not match the submitted evidence at input_index ${summary.input_index}.`,
      );
    }
  }
}

/** Create a credential-holding Node client. Never construct this object in browser code. */
export function createWordlessClient(options: WordlessClientOptions): WordlessClient {
  if (!isRecord(options)) {
    throw new WordlessConfigurationError("Client options must be an object.");
  }
  if (options.allowPrivateHttp !== undefined && typeof options.allowPrivateHttp !== "boolean") {
    throw new WordlessConfigurationError("allowPrivateHttp must be a boolean.");
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl, options.allowPrivateHttp);
  const apiKey = options.apiKey;
  const signingSecret = options.signingSecret;
  validateCredentials(apiKey, signingSecret);
  const timeoutMs = validatePositiveInteger(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    120_000,
  );
  const maxResponseBytes = validatePositiveInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
    4_194_304,
  );
  const retryDelayMs = validatePositiveInteger(
    options.retryDelayMs,
    DEFAULT_RETRY_DELAY_MS,
    "retryDelayMs",
    MAX_RETRY_DELAY_MS,
    true,
  );
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new WordlessConfigurationError("This Node runtime does not provide fetch.");
  }

  const post = async <T>(
    path: string,
    payload: unknown,
    requestOptions: WordlessRequestOptions,
    parse: (value: unknown) => T,
  ): Promise<T> => {
    if (!isRecord(requestOptions)) {
      throw new WordlessRequestError("Request options must include an idempotencyKey.");
    }
    const idempotencyKey = validateIdempotencyKey(requestOptions.idempotencyKey);
    const signal = requestOptions.signal;
    const body = serializeRequest(payload);

    const attempt = async (): Promise<T> => {
      if (isAborted(signal)) {
        throw new WordlessRequestAbortedError();
      }
      const controller = new AbortController();
      let timeoutFired = false;
      const abort = (): void => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        timeoutFired = true;
        controller.abort();
      }, timeoutMs);
      try {
        const timestamp = String(Math.floor(Date.now() / 1_000));
        const signature = canonicalSignature(
          timestamp,
          path,
          idempotencyKey,
          body,
          signingSecret,
        );
        const response = await fetchImplementation(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
            "X-Wordless-Signature": `v1=${signature}`,
            "X-Wordless-Timestamp": timestamp,
          },
          body,
          redirect: "error",
          signal: controller.signal,
        });
        if (response.redirected) {
          await response.body?.cancel();
          throw new WordlessResponseError("Wordless API redirects are not allowed.");
        }
        if (!response.ok) throw await apiError(response, maxResponseBytes);
        const value = await readJson(response, maxResponseBytes);
        try {
          return parse(value);
        } catch (cause) {
          if (cause instanceof WordlessResponseError) throw cause;
          throw new WordlessResponseError(
            "Wordless response did not match the versioned API contract.",
            cause,
          );
        }
      } catch (cause) {
        if (isAborted(signal)) {
          throw new WordlessRequestAbortedError();
        }
        if (timeoutFired) throw new WordlessTimeoutError(timeoutMs, cause);
        if (cause instanceof WordlessSdkError) throw cause;
        throw new WordlessNetworkError(cause);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    };

    for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
      try {
        return await attempt();
      } catch (cause) {
        const retryable =
          cause instanceof WordlessNetworkError ||
          cause instanceof WordlessTimeoutError ||
          (cause instanceof WordlessApiError && cause.retryable);
        if (!retryable || attemptNumber === 1) throw cause;
        const delay =
          cause instanceof WordlessApiError && cause.retryAfterMs !== null
            ? cause.retryAfterMs
            : retryDelayMs;
        await wait(delay, signal);
      }
    }
    throw new WordlessNetworkError();
  };

  const client: WordlessClient = {
    baseUrl,
    async assist(
      request: WordlessChatAssistRequest,
      requestOptions: WordlessRequestOptions,
    ) {
      validateChatAssistEnvelope(request);
      return post(CHAT_ASSIST_PATH, request, requestOptions, (value) => {
        const response = parseChatAssistResponse(value);
        assertEvidenceBindings(response.evidence, request.evidence, "Chat-assist evidence");
        for (const choice of response.choices) {
          assertEvidenceBindings(
            choice.evidence,
            request.evidence,
            `Chat-assist choice ${choice.id} evidence`,
          );
        }
        return response;
      });
    },
    async suggest(
      request: WordlessSuggestionRequest,
      requestOptions: WordlessRequestOptions,
    ) {
      validateSuggestionEnvelope(request);
      return post(SUGGESTIONS_PATH, request, requestOptions, (value) => {
        const response = parseSuggestionResponse(value);
        for (const candidate of response.candidates) {
          assertEvidenceBindings(
            candidate.evidence,
            request.evidence,
            `Suggestion candidate ${candidate.id} evidence`,
          );
        }
        return response;
      });
    },
    async recordFeedback(
      suggestionId: string,
      feedback: WordlessFeedbackRequest,
      requestOptions: WordlessRequestOptions,
    ) {
      if (typeof suggestionId !== "string" || !SUGGESTION_ID_PATTERN.test(suggestionId)) {
        throw new WordlessRequestError("suggestionId does not match the Wordless API contract.");
      }
      validateFeedbackRequest(feedback);
      const path = `${SUGGESTIONS_PATH}/${suggestionId}/feedback`;
      return post(path, feedback, requestOptions, (value) => {
        const response = parseFeedbackResponse(value, suggestionId);
        if (
          response.outcome !== feedback.outcome ||
          response.selected_detector_id !== feedback.selected_detector_id ||
          response.actor !== feedback.actor
        ) {
          throw new WordlessResponseError(
            "Feedback response does not match the submitted decision.",
          );
        }
        return response;
      });
    },
  };
  return Object.freeze(client);
}

export interface WordlessSupportMessageInput {
  /** Durable ID from the host system. It is hashed before becoming an API key. */
  readonly messageId: string;
  readonly customerId: string;
  readonly text: string;
  readonly sentAt: string;
  /** Defaults to sentAt. All evidence must exist at or before this time. */
  readonly observedAt?: string;
  readonly channel?: "email" | "chat" | "phone" | "form" | "web";
  readonly evidence?: readonly WordlessEvidence[];
  readonly metadata?: Readonly<Record<string, WordlessJsonValue>>;
  /** Universal customer preference. It must not be inferred from a diagnosis. */
  readonly showChoices?: boolean;
}

export interface WordlessSupportProcessOptions {
  /** Override only when the host already persists its own stable operation key. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface WordlessSupportChoice {
  readonly id: string;
  readonly label: string;
  /** Plain text the host may send after this choice is selected. */
  readonly reply: string;
  /** Null means the choice does not confirm a Wordless detector. */
  readonly detectorId: string | null;
  readonly evidenceIndexes: readonly number[];
}

interface WordlessSupportTurnBase {
  readonly suggestionId: string;
  readonly reviewRequired: true;
  readonly readOnly: true;
  readonly processingMs: number;
}

export interface WordlessClarificationChoicesTurn extends WordlessSupportTurnBase {
  readonly kind: "clarification_choices";
  readonly hostAction: "show_wordless";
  readonly renderMode: "choices";
  readonly message: string;
  readonly choices: readonly WordlessSupportChoice[];
  readonly detectorId: string;
  readonly evidenceIndexes: readonly number[];
  readonly reason: null;
}

export interface WordlessGroundedReplyTurn extends WordlessSupportTurnBase {
  readonly kind: "grounded_reply";
  readonly hostAction: "show_wordless";
  readonly renderMode: "message";
  readonly message: string;
  readonly choices: readonly WordlessSupportChoice[];
  readonly detectorId: string | null;
  readonly evidenceIndexes: readonly number[];
  readonly reason: null;
}

export type WordlessClarifyingFallbackTurn = WordlessSupportTurnBase &
  (
    | {
        readonly kind: "clarifying_fallback";
        readonly hostAction: "continue_host_bot";
        readonly renderMode: "none";
        readonly message: null;
        readonly choices: readonly WordlessSupportChoice[];
        readonly detectorId: null;
        readonly evidenceIndexes: readonly number[];
        readonly reason: WordlessChatAssistReason;
      }
    | {
        readonly kind: "clarifying_fallback";
        readonly hostAction: "show_wordless";
        readonly renderMode: "message" | "choices";
        readonly message: string;
        readonly choices: readonly WordlessSupportChoice[];
        readonly detectorId: null;
        readonly evidenceIndexes: readonly number[];
        readonly reason: WordlessChatAssistReason;
      }
  );

export type WordlessSupportChatTurn =
  | WordlessClarificationChoicesTurn
  | WordlessGroundedReplyTurn
  | WordlessClarifyingFallbackTurn;

export interface WordlessSupportConfirmation {
  readonly suggestionId: string;
  /** Use the selected evidence choice's detectorId; null records an explicit “none.” */
  readonly selectedDetectorId: string | null;
  readonly actor: "customer" | "agent";
  /** Durable ID for this human decision, not a random retry ID. */
  readonly decisionId: string;
}

export interface WordlessSupportChatbotOptions {
  readonly client: WordlessClient;
  readonly sourceSystem: string;
  readonly defaultChannel?: "email" | "chat" | "phone" | "form" | "web";
}

export interface WordlessSupportChatbot {
  processMessage(
    input: WordlessSupportMessageInput,
    options?: WordlessSupportProcessOptions,
  ): Promise<WordlessSupportChatTurn>;
  recordConfirmation(
    confirmation: WordlessSupportConfirmation,
    options?: WordlessSupportProcessOptions,
  ): Promise<WordlessFeedbackResponse>;
}

function evidenceIndexes(evidence: readonly WordlessEvidenceSummary[]): readonly number[] {
  return Object.freeze(evidence.map((item) => item.input_index));
}

/** Map a validated service response into framework-neutral host-chat instructions. */
export function mapChatAssistToHostTurn(
  value: unknown,
): WordlessSupportChatTurn {
  const response = parseChatAssistResponse(value);
  const base = {
    suggestionId: response.suggestion_id,
    reviewRequired: true as const,
    readOnly: true as const,
    processingMs: response.processing_ms,
  };
  if (response.outcome === "clarification_choices") {
    if (
      response.integration.host_action !== "show_wordless" ||
      response.integration.render_mode !== "choices" ||
      response.message === null ||
      response.detector_id === null
    ) {
      throw new WordlessResponseError("Validated clarification response was internally inconsistent.");
    }
    return Object.freeze({
      ...base,
      kind: "clarification_choices" as const,
      hostAction: "show_wordless" as const,
      renderMode: "choices" as const,
      message: response.message,
      choices: Object.freeze(response.choices.map((choice) => Object.freeze({
        id: choice.id,
        label: choice.label,
        reply: choice.reply,
        detectorId: choice.detector_id,
        evidenceIndexes: evidenceIndexes(choice.evidence),
      }))),
      detectorId: response.detector_id,
      evidenceIndexes: evidenceIndexes(response.evidence),
      reason: null,
    });
  }
  if (response.outcome === "grounded_reply") {
    if (
      response.integration.host_action !== "show_wordless" ||
      response.integration.render_mode !== "message" ||
      response.message === null
    ) {
      throw new WordlessResponseError("Validated grounded reply was internally inconsistent.");
    }
    return Object.freeze({
      ...base,
      kind: "grounded_reply" as const,
      hostAction: "show_wordless" as const,
      renderMode: "message" as const,
      message: response.message,
      choices: Object.freeze([]),
      detectorId: response.detector_id,
      evidenceIndexes: evidenceIndexes(response.evidence),
      reason: null,
    });
  }
  if (response.reason === null) {
    throw new WordlessResponseError("Validated fallback did not include a reason.");
  }
  if (response.integration.host_action === "continue_host_bot") {
    return Object.freeze({
      ...base,
      kind: "clarifying_fallback" as const,
      hostAction: "continue_host_bot" as const,
      renderMode: "none" as const,
      message: null,
      choices: Object.freeze([]),
      detectorId: null,
      evidenceIndexes: Object.freeze([]),
      reason: response.reason,
    });
  }
  if (
    response.message === null ||
    (response.integration.render_mode !== "message" &&
      response.integration.render_mode !== "choices")
  ) {
    throw new WordlessResponseError("Validated visible fallback was internally inconsistent.");
  }
  return Object.freeze({
    ...base,
    kind: "clarifying_fallback" as const,
    hostAction: "show_wordless" as const,
    renderMode: response.integration.render_mode,
    message: response.message,
    choices: Object.freeze(response.choices.map((choice) => Object.freeze({
      id: choice.id,
      label: choice.label,
      reply: choice.reply,
      detectorId: choice.detector_id,
      evidenceIndexes: evidenceIndexes(choice.evidence),
    }))),
    detectorId: null,
    evidenceIndexes: Object.freeze([]),
    reason: response.reason,
  });
}

function validateSupportProcessOptions(
  value: WordlessSupportProcessOptions | undefined,
): WordlessSupportProcessOptions {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new WordlessRequestError("Support process options must be an object.");
  }
  allowedAndRequiredKeys(value, ["idempotencyKey", "signal"], [], "Support process options");
  if (
    Object.prototype.hasOwnProperty.call(value, "signal") &&
    value.signal !== undefined &&
    !(value.signal instanceof AbortSignal)
  ) {
    throw new WordlessRequestError("Support process signal must be an AbortSignal.");
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "idempotencyKey") &&
    value.idempotencyKey !== undefined
  ) {
    validateIdempotencyKey(value.idempotencyKey as string);
  }
  return value;
}

/**
 * Add evidence-first assistance to an existing support bot without taking over
 * ordinary messages. Secrets stay inside the supplied Node-only client.
 */
export function createSupportChatbotAdapter(
  options: WordlessSupportChatbotOptions,
): WordlessSupportChatbot {
  if (!isRecord(options)) {
    throw new WordlessConfigurationError("Support chatbot options must be an object.");
  }
  allowedAndRequiredKeys(
    options,
    ["client", "defaultChannel", "sourceSystem"],
    ["client", "sourceSystem"],
    "Support chatbot options",
  );
  if (
    !isRecord(options.client) ||
    typeof options.client.assist !== "function" ||
    typeof options.client.recordFeedback !== "function"
  ) {
    throw new WordlessConfigurationError("client must be a Wordless Node client.");
  }
  if (
    typeof options.sourceSystem !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(options.sourceSystem)
  ) {
    throw new WordlessConfigurationError("sourceSystem is invalid.");
  }
  const defaultChannel = options.defaultChannel ?? "chat";
  if (!new Set(["email", "chat", "phone", "form", "web"]).has(defaultChannel)) {
    throw new WordlessConfigurationError("defaultChannel is invalid.");
  }
  const client = options.client;
  const sourceSystem = options.sourceSystem;

  return Object.freeze({
    async processMessage(
      input: WordlessSupportMessageInput,
      processOptions?: WordlessSupportProcessOptions,
    ): Promise<WordlessSupportChatTurn> {
      if (!isRecord(input)) {
        throw new WordlessRequestError("Support message input must be an object.");
      }
      allowedAndRequiredKeys(
        input,
        [
          "channel",
          "customerId",
          "evidence",
          "messageId",
          "metadata",
          "observedAt",
          "sentAt",
          "showChoices",
          "text",
        ],
        ["customerId", "messageId", "sentAt", "text"],
        "Support message input",
      );
      const validatedOptions = validateSupportProcessOptions(processOptions);
      const messageId = requestString(input.messageId, "messageId", { maximum: 512 });
      const customerId = requestString(input.customerId, "customerId", { maximum: 512 });
      if (input.showChoices !== undefined && typeof input.showChoices !== "boolean") {
        throw new WordlessRequestError("showChoices must be a boolean.");
      }
      const request: WordlessChatAssistRequest = {
        schema_version: 1,
        external_event_id: createIdempotencyKey(
          "chat-event",
          sourceSystem,
          customerId,
          messageId,
        ),
        observed_at: input.observedAt ?? input.sentAt,
        channel: input.channel ?? defaultChannel,
        customer_external_id: customerId,
        message: {
          sent_at: input.sentAt,
          text: input.text,
        },
        assistance_mode: input.showChoices === true ? "show_choices" : "auto",
        evidence: input.evidence ?? [],
        source_system: sourceSystem,
        metadata: input.metadata ?? {},
      };
      const requestOptions: WordlessRequestOptions = {
        idempotencyKey:
          validatedOptions.idempotencyKey ??
          createIdempotencyKey("chat-assist", sourceSystem, customerId, messageId),
        ...(validatedOptions.signal === undefined ? {} : { signal: validatedOptions.signal }),
      };
      const response = await client.assist(request, requestOptions);
      return mapChatAssistToHostTurn(response);
    },

    async recordConfirmation(
      confirmation: WordlessSupportConfirmation,
      processOptions?: WordlessSupportProcessOptions,
    ): Promise<WordlessFeedbackResponse> {
      if (!isRecord(confirmation)) {
        throw new WordlessRequestError("Support confirmation must be an object.");
      }
      exactKeys(
        confirmation,
        ["actor", "decisionId", "selectedDetectorId", "suggestionId"],
        "Support confirmation",
        WordlessRequestError,
      );
      const validatedOptions = validateSupportProcessOptions(processOptions);
      const decisionId = requestString(confirmation.decisionId, "decisionId", { maximum: 512 });
      if (confirmation.actor !== "customer" && confirmation.actor !== "agent") {
        throw new WordlessRequestError("Support confirmation actor is invalid.");
      }
      if (
        confirmation.selectedDetectorId !== null &&
        (typeof confirmation.selectedDetectorId !== "string" ||
          !DETECTOR_ID_PATTERN.test(confirmation.selectedDetectorId))
      ) {
        throw new WordlessRequestError("Support confirmation detector is invalid.");
      }
      const feedback: WordlessFeedbackRequest =
        confirmation.selectedDetectorId === null
          ? {
              schema_version: 1,
              outcome: "none",
              selected_detector_id: null,
              actor: confirmation.actor,
            }
          : {
              schema_version: 1,
              outcome: "confirmed",
              selected_detector_id: confirmation.selectedDetectorId,
              actor: confirmation.actor,
            };
      return client.recordFeedback(
        confirmation.suggestionId,
        feedback,
        {
          idempotencyKey:
            validatedOptions.idempotencyKey ??
            createIdempotencyKey(
              "chat-feedback",
              sourceSystem,
              confirmation.suggestionId,
              decisionId,
            ),
          ...(validatedOptions.signal === undefined ? {} : { signal: validatedOptions.signal }),
        },
      );
    },
  });
}

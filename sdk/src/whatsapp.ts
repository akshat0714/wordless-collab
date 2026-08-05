import { createHmac, timingSafeEqual } from "node:crypto";

export class WhatsAppIntegrationError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message);
    this.name = "WhatsAppIntegrationError";
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", { configurable: true, value: options.cause, writable: true });
    }
  }
}

export class WhatsAppWebhookValidationError extends WhatsAppIntegrationError {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppWebhookValidationError";
  }
}

export function verifyWhatsAppSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (typeof rawBody !== "string" || typeof signatureHeader !== "string") return false;
  if (!signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  const expected = createHmac("sha256", Buffer.from(appSecret, "utf8")).update(rawBody, "utf8").digest("hex");
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

export function verifyWhatsAppSubscription(
  query: { readonly mode: string | null; readonly token: string | null; readonly challenge: string | null },
  verifyToken: string,
): string {
  if (query.mode !== "subscribe") throw new WhatsAppWebhookValidationError("Unexpected hub.mode.");
  const provided = Buffer.from(query.token ?? "", "utf8");
  const expected = Buffer.from(verifyToken, "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new WhatsAppWebhookValidationError("hub.verify_token mismatch.");
  }
  if (typeof query.challenge !== "string" || query.challenge.length === 0) {
    throw new WhatsAppWebhookValidationError("Missing hub.challenge.");
  }
  return query.challenge;
}

const MAX_ENTRIES = 50;
const MAX_CHANGES = 50;
const MAX_MESSAGES = 50;
const MAX_TEXT_LENGTH = 4_000;

export interface WhatsAppInboundMessage {
  readonly phoneNumberId: string;
  readonly waId: string;
  readonly messageId: string;
  readonly receivedAt: string;
  readonly type: "text" | "button_reply";
  readonly text: string | null;
  readonly buttonPayload: string | null;
}

export type WhatsAppParsedEntry =
  | { readonly kind: "message"; readonly inbound: WhatsAppInboundMessage }
  | { readonly kind: "ignored"; readonly reason: "status" | "unsupported_type" | "wrong_number"; readonly messageId: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function isoFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{1,15}$/u.test(value)) return null;
  const ms = Number.parseInt(value, 10) * 1_000;
  if (!Number.isSafeInteger(ms)) return null;
  return new Date(ms).toISOString();
}

export function parseWhatsAppEnvelope(
  value: unknown,
  expectedPhoneNumberId: string,
): readonly WhatsAppParsedEntry[] {
  if (!isRecord(value) || !Array.isArray(value.entry) || value.entry.length > MAX_ENTRIES) {
    throw new WhatsAppWebhookValidationError("WhatsApp webhook envelope is invalid.");
  }
  const results: WhatsAppParsedEntry[] = [];
  for (const entry of value.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    if (entry.changes.length > MAX_CHANGES) {
      throw new WhatsAppWebhookValidationError("Too many WhatsApp changes in one webhook entry.");
    }
    for (const change of entry.changes) {
      if (!isRecord(change) || change.field !== "messages" || !isRecord(change.value)) continue;
      const val = change.value;
      const metadata = isRecord(val.metadata) ? val.metadata : {};
      const phoneNumberId = optionalString(metadata.phone_number_id, 128);
      if (phoneNumberId !== expectedPhoneNumberId) {
        results.push({ kind: "ignored", reason: "wrong_number", messageId: null });
        continue;
      }
      if (Array.isArray(val.statuses) && val.statuses.length > 0) {
        results.push({ kind: "ignored", reason: "status", messageId: null });
      }
      if (!Array.isArray(val.messages)) continue;
      if (val.messages.length > MAX_MESSAGES) {
        throw new WhatsAppWebhookValidationError("Too many WhatsApp messages in one webhook.");
      }
      const contacts = Array.isArray(val.contacts) ? val.contacts : [];
      const firstWaId = contacts.length > 0 && isRecord(contacts[0]) ? optionalString(contacts[0].wa_id, 128) : null;
      for (const message of val.messages) {
        if (!isRecord(message)) continue;
        const messageId = optionalString(message.id, 256);
        const receivedAt = isoFromUnixSeconds(message.timestamp);
        const waId = optionalString(message.from, 128) ?? firstWaId;
        if (messageId === null || receivedAt === null || waId === null) {
          throw new WhatsAppWebhookValidationError("WhatsApp message is missing required fields.");
        }
        if (message.type === "text" && isRecord(message.text)) {
          results.push({ kind: "message", inbound: Object.freeze({
            phoneNumberId, waId, messageId, receivedAt, type: "text",
            text: optionalString(message.text.body, MAX_TEXT_LENGTH) ?? "", buttonPayload: null,
          }) });
        } else if (
          message.type === "interactive" && isRecord(message.interactive) &&
          message.interactive.type === "button_reply" && isRecord(message.interactive.button_reply)
        ) {
          const payload = optionalString(message.interactive.button_reply.id, 256);
          if (payload === null) { results.push({ kind: "ignored", reason: "unsupported_type", messageId }); continue; }
          results.push({ kind: "message", inbound: Object.freeze({
            phoneNumberId, waId, messageId, receivedAt, type: "button_reply", text: null, buttonPayload: payload,
          }) });
        } else {
          results.push({ kind: "ignored", reason: "unsupported_type", messageId });
        }
      }
    }
  }
  return Object.freeze(results);
}

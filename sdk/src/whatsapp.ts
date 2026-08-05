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

// sdk/src/slack.ts
import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export class SlackIntegrationError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message);
    this.name = "SlackIntegrationError";
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", { configurable: true, value: options.cause, writable: true });
    }
  }
}
export class SlackWebhookValidationError extends SlackIntegrationError {
  constructor(message: string) { super(message); this.name = "SlackWebhookValidationError"; }
}

export function verifySlackSignature(
  rawBody: string,
  headers: { readonly signature: string | null; readonly timestamp: string | null },
  signingSecret: string,
  now: () => Date,
): boolean {
  if (typeof rawBody !== "string" || typeof headers.signature !== "string" || typeof headers.timestamp !== "string") return false;
  if (!/^\d{1,15}$/u.test(headers.timestamp)) return false;
  const nowSeconds = Math.floor(now().getTime() / 1_000);
  if (Math.abs(nowSeconds - Number.parseInt(headers.timestamp, 10)) > MAX_TIMESTAMP_SKEW_SECONDS) return false;
  const expected = "v0=" + createHmac("sha256", Buffer.from(signingSecret, "utf8"))
    .update(`v0:${headers.timestamp}:${rawBody}`, "utf8").digest("hex");
  const providedBuf = Buffer.from(headers.signature, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

export function verifySlackUrlVerification(parsedBody: unknown): string | null {
  if (typeof parsedBody !== "object" || parsedBody === null) return null;
  const body = parsedBody as Record<string, unknown>;
  if (body.type !== "url_verification") return null;
  if (typeof body.challenge !== "string" || body.challenge.length === 0) {
    throw new SlackWebhookValidationError("Missing Slack url_verification challenge.");
  }
  return body.challenge;
}

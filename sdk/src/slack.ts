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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

const MAX_ACTIONS = 25;

export interface SlackInboundMessage {
  readonly teamId: string; readonly channelId: string; readonly userId: string;
  readonly messageTs: string; readonly text: string;
}
export interface SlackInboundAction {
  readonly teamId: string; readonly channelId: string; readonly userId: string;
  readonly actionTs: string; readonly responseUrl: string | null; readonly value: string;
}

export function parseSlackMessageEvent(parsedBody: unknown, selfBotUserId: string): SlackInboundMessage | { readonly ignored: "not_a_user_message" } {
  if (!isRecord(parsedBody) || parsedBody.type !== "event_callback" || !isRecord(parsedBody.event)) return { ignored: "not_a_user_message" };
  const event = parsedBody.event;
  if (event.type !== "message" || event.bot_id !== undefined || event.subtype !== undefined) return { ignored: "not_a_user_message" };
  const teamId = str(parsedBody.team_id, 64);
  const channelId = str(event.channel, 64);
  const userId = str(event.user, 64);
  const messageTs = str(event.ts, 64);
  const text = typeof event.text === "string" ? event.text.slice(0, 4_000) : "";
  if (teamId === null || channelId === null || userId === null || messageTs === null || userId === selfBotUserId) {
    return { ignored: "not_a_user_message" };
  }
  return Object.freeze({ teamId, channelId, userId, messageTs, text });
}

export function parseSlackBlockActions(parsedPayload: unknown): SlackInboundAction | { readonly ignored: "not_a_button_action" } {
  if (!isRecord(parsedPayload) || parsedPayload.type !== "block_actions" || !Array.isArray(parsedPayload.actions)) return { ignored: "not_a_button_action" };
  if (parsedPayload.actions.length > MAX_ACTIONS) return { ignored: "not_a_button_action" };
  const action = parsedPayload.actions.find((a) => isRecord(a) && a.type === "button");
  if (!isRecord(action)) return { ignored: "not_a_button_action" };
  const team = isRecord(parsedPayload.team) ? str(parsedPayload.team.id, 64) : null;
  const user = isRecord(parsedPayload.user) ? str(parsedPayload.user.id, 64) : null;
  const channel = isRecord(parsedPayload.channel) ? str(parsedPayload.channel.id, 64) : null;
  const value = str(action.value, 2_000);
  const actionTs = str(action.action_ts, 64) ?? str(parsedPayload.action_ts as unknown, 64) ?? "0";
  if (team === null || user === null || channel === null || value === null) return { ignored: "not_a_button_action" };
  return Object.freeze({ teamId: team, channelId: channel, userId: user, actionTs, responseUrl: str(parsedPayload.response_url, 1_024), value });
}

// sdk/src/slack.ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  classifyChoiceFeedback, createSignedChoicePayload, detectHumanRequest,
  isShowChoicesRequest, verifySignedChoicePayload, type ChoiceFeedback,
} from "./channel-support.js";
import {
  WordlessSdkError, type WordlessEvidence, type WordlessJsonValue,
  type WordlessSupportChatbot, type WordlessSupportChatTurn,
} from "./server.js";

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

export type SlackJsonValue =
  | null | boolean | number | string
  | readonly SlackJsonValue[]
  | { readonly [key: string]: SlackJsonValue };

export const SLACK_SHOW_CHOICES_LABEL = "I don't know what to say";
const SLACK_MAX_BUTTONS = 3;
const SLACK_MAX_BUTTON_TEXT = 75;
const SLACK_MAX_BUTTON_VALUE = 2_000;

export interface SlackPostMessageRequest { readonly method: "POST"; readonly path: "/chat.postMessage"; readonly body: SlackJsonValue; }
export interface SlackPendingChoice {
  readonly payload: string; readonly id: string; readonly label: string; readonly reply: string;
  readonly detectorId: string | null; readonly feedback: ChoiceFeedback; readonly evidenceIndexes: readonly number[];
}
export interface SlackPendingChoiceSet {
  readonly teamId: string; readonly channelId: string; readonly userId: string; readonly suggestionId: string;
  readonly sourceMessageTs: string; readonly nonce: string; readonly issuedAt: string; readonly expiresAt: string;
  readonly choices: readonly SlackPendingChoice[];
}

export function buildSlackPostMessage(
  inbound: { readonly teamId: string; readonly channelId: string; readonly userId: string; readonly messageTs: string },
  turn: WordlessSupportChatTurn,
  signingSecret: string,
  nonce: string,
  issuedAtSeconds: number,
  expiresAtSeconds: number,
): { readonly request: SlackPostMessageRequest; readonly pendingChoices: SlackPendingChoiceSet | null } {
  if (turn.message === null) throw new SlackIntegrationError("A visible Slack turn must contain a message.");
  const path = "/chat.postMessage" as const;
  if (turn.renderMode !== "choices" || turn.choices.length === 0) {
    return Object.freeze({ request: Object.freeze({ method: "POST" as const, path, body: Object.freeze({ channel: inbound.channelId, text: turn.message }) }), pendingChoices: null });
  }
  if (turn.choices.length > SLACK_MAX_BUTTONS) throw new SlackIntegrationError(`Slack channel supports at most ${SLACK_MAX_BUTTONS} buttons.`);
  const pending: SlackPendingChoice[] = [];
  const elements = turn.choices.map((choice) => {
    const feedback = classifyChoiceFeedback(turn.kind, choice.detectorId);
    const payload = createSignedChoicePayload({
      bindingParts: [inbound.teamId, inbound.channelId, inbound.userId],
      suggestionId: turn.suggestionId, choiceId: choice.id, detectorId: choice.detectorId,
      feedback, issuedAtSeconds, expiresAtSeconds, nonce, signingSecret,
    });
    if (payload.length > SLACK_MAX_BUTTON_VALUE) throw new SlackIntegrationError("Slack button value exceeds 2000 characters.");
    const label = choice.detectorId === null ? SLACK_SHOW_CHOICES_LABEL : choice.label;
    if (label.length > SLACK_MAX_BUTTON_TEXT) throw new SlackIntegrationError(`Slack button text exceeds ${SLACK_MAX_BUTTON_TEXT} characters.`);
    pending.push(Object.freeze({ payload, id: choice.id, label, reply: choice.reply, detectorId: choice.detectorId, feedback, evidenceIndexes: choice.evidenceIndexes }));
    return Object.freeze({ type: "button", action_id: choice.id, text: Object.freeze({ type: "plain_text", text: label }), value: payload });
  });
  const body: SlackJsonValue = Object.freeze({
    channel: inbound.channelId, text: turn.message,
    blocks: Object.freeze([
      Object.freeze({ type: "section", text: Object.freeze({ type: "mrkdwn", text: turn.message }) }),
      Object.freeze({ type: "actions", elements: Object.freeze(elements) }),
    ]),
  });
  const pendingChoices: SlackPendingChoiceSet = Object.freeze({
    teamId: inbound.teamId, channelId: inbound.channelId, userId: inbound.userId, suggestionId: turn.suggestionId,
    sourceMessageTs: inbound.messageTs, nonce,
    issuedAt: new Date(issuedAtSeconds * 1_000).toISOString(), expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
    choices: Object.freeze(pending),
  });
  return Object.freeze({ request: Object.freeze({ method: "POST" as const, path, body }), pendingChoices });
}

const S_DEFAULT_TTL_MS = 30 * 60 * 1_000;
const S_MAX_TTL_MS = 24 * 60 * 60 * 1_000;

export interface SlackAuthenticatedAccount {
  readonly authenticated: true; readonly customerId: string; readonly observedAt: string;
  readonly evidence: readonly WordlessEvidence[]; readonly metadata?: Readonly<Record<string, WordlessJsonValue>>;
}
export interface SlackChoiceResolveInput {
  readonly teamId: string; readonly channelId: string; readonly userId: string; readonly payload: string;
  readonly selectionActionTs: string; readonly nonce: string;
}
export interface SlackResolvedChoice {
  readonly suggestionId: string; readonly choiceId: string; readonly detectorId: string | null;
  readonly reply: string; readonly feedback: ChoiceFeedback;
}
export interface SlackChoiceStore {
  save(set: SlackPendingChoiceSet): Promise<void>;
  resolve(input: SlackChoiceResolveInput): Promise<SlackResolvedChoice | null>;
}

export type SlackContinueReason = "account_not_authenticated" | "wordless_unavailable" | "continue_host_bot" | "choice_replayed";
interface SlackResultBase { readonly deduplicationKey: string; }
export interface SlackPostMessageResult extends SlackResultBase {
  readonly kind: "post_message"; readonly request: SlackPostMessageRequest; readonly pendingChoices: SlackPendingChoiceSet | null;
  readonly wordless: { readonly suggestionId: string; readonly outcome: WordlessSupportChatTurn["kind"]; readonly evidenceIndexes: readonly number[]; };
}
export interface SlackContinueResult extends SlackResultBase { readonly kind: "continue"; readonly reason: SlackContinueReason; }
export interface SlackHandoffResult extends SlackResultBase { readonly kind: "handoff"; readonly reason: "human_requested"; }
export interface SlackIgnoredResult { readonly kind: "ignored"; readonly reason: "not_a_user_message" | "not_a_button_action"; }
export type SlackResult = SlackPostMessageResult | SlackContinueResult | SlackHandoffResult | SlackIgnoredResult;
export type SlackEventOutcome = { readonly kind: "url_verification"; readonly challenge: string } | { readonly kind: "result"; readonly result: SlackResult } | { readonly kind: "ignored" };

export interface SlackAdapterOptions {
  readonly chatbot: WordlessSupportChatbot;
  readonly signingSecret: string;
  readonly choiceSigningSecret: string;
  readonly selfBotUserId: string;
  readonly resolveAuthenticatedAccount: (inbound: SlackInboundMessage) => Promise<SlackAuthenticatedAccount | null>;
  readonly choiceStore: SlackChoiceStore;
  readonly humanHandoff?: { readonly enabled: boolean };
  readonly accountResolutionFailureMode?: "throw" | "continue";
  readonly choiceTtlMs?: number;
  readonly now?: () => Date;
  readonly onWordlessError?: (error: WordlessSdkError, inbound: SlackInboundMessage) => void;
  readonly onAccountResolutionError?: (error: unknown, inbound: SlackInboundMessage) => void;
  readonly onFeedbackError?: (error: unknown, inbound: SlackInboundAction) => void;
}

export interface SlackAdapter {
  processEvent(rawBody: string, headers: { readonly signature: string | null; readonly timestamp: string | null }): Promise<SlackEventOutcome>;
  processInteraction(rawBody: string, headers: { readonly signature: string | null; readonly timestamp: string | null }): Promise<SlackResult>;
}

export function createSlackAdapter(options: SlackAdapterOptions): SlackAdapter {
  const ttl = options.choiceTtlMs ?? S_DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > S_MAX_TTL_MS) throw new SlackIntegrationError("choiceTtlMs must be between one minute and 24 hours.");
  const now = options.now ?? (() => new Date());
  const humanEnabled = options.humanHandoff?.enabled === true;

  async function onMessage(inbound: SlackInboundMessage): Promise<SlackResult> {
    if (humanEnabled && detectHumanRequest(inbound.text)) {
      return Object.freeze({ kind: "handoff" as const, deduplicationKey: inbound.messageTs, reason: "human_requested" as const });
    }
    let account: SlackAuthenticatedAccount | null;
    try { account = await options.resolveAuthenticatedAccount(inbound); }
    catch (error) {
      if ((options.accountResolutionFailureMode ?? "throw") === "continue") { options.onAccountResolutionError?.(error, inbound); return Object.freeze({ kind: "continue" as const, deduplicationKey: inbound.messageTs, reason: "account_not_authenticated" as const }); }
      throw error;
    }
    if (account === null) return Object.freeze({ kind: "continue" as const, deduplicationKey: inbound.messageTs, reason: "account_not_authenticated" as const });
    let turn: WordlessSupportChatTurn;
    try {
      turn = await options.chatbot.processMessage({ messageId: inbound.messageTs, customerId: account.customerId, text: inbound.text,
        sentAt: new Date(Math.floor(Number.parseFloat(inbound.messageTs) * 1_000)).toISOString(), observedAt: account.observedAt, channel: "chat",
        evidence: account.evidence, showChoices: isShowChoicesRequest(inbound.text, false),
        ...(account.metadata !== undefined ? { metadata: account.metadata } : {}) });
    } catch (error) {
      if (error instanceof WordlessSdkError) { options.onWordlessError?.(error, inbound); return Object.freeze({ kind: "continue" as const, deduplicationKey: inbound.messageTs, reason: "wordless_unavailable" as const }); }
      throw error;
    }
    if (turn.hostAction === "continue_host_bot") return Object.freeze({ kind: "continue" as const, deduplicationKey: inbound.messageTs, reason: "continue_host_bot" as const });
    const issuedAtSeconds = Math.floor(now().getTime() / 1_000);
    const expiresAtSeconds = issuedAtSeconds + Math.ceil(ttl / 1_000);
    const { request, pendingChoices } = buildSlackPostMessage(inbound, turn, options.choiceSigningSecret, randomBytes(12).toString("base64url"), issuedAtSeconds, expiresAtSeconds);
    if (pendingChoices !== null) await options.choiceStore.save(pendingChoices);
    return Object.freeze({ kind: "post_message" as const, deduplicationKey: inbound.messageTs, request, pendingChoices,
      wordless: Object.freeze({ suggestionId: turn.suggestionId, outcome: turn.kind, evidenceIndexes: turn.evidenceIndexes }) });
  }

  return Object.freeze({
    async processEvent(rawBody: string, headers: { readonly signature: string | null; readonly timestamp: string | null }): Promise<SlackEventOutcome> {
      if (!verifySlackSignature(rawBody, headers, options.signingSecret, now)) throw new SlackWebhookValidationError("Slack signature is invalid.");
      let parsed: unknown; try { parsed = JSON.parse(rawBody); } catch { throw new SlackWebhookValidationError("Slack event body is not valid JSON."); }
      const challenge = verifySlackUrlVerification(parsed);
      if (challenge !== null) return Object.freeze({ kind: "url_verification" as const, challenge });
      const message = parseSlackMessageEvent(parsed, options.selfBotUserId);
      if ("ignored" in message) return Object.freeze({ kind: "ignored" as const });
      return Object.freeze({ kind: "result" as const, result: await onMessage(message) });
    },
    async processInteraction(rawBody: string, headers: { readonly signature: string | null; readonly timestamp: string | null }): Promise<SlackResult> {
      if (!verifySlackSignature(rawBody, headers, options.signingSecret, now)) throw new SlackWebhookValidationError("Slack signature is invalid.");
      const params = new URLSearchParams(rawBody);
      const raw = params.get("payload");
      if (raw === null) throw new SlackWebhookValidationError("Slack interaction is missing a payload.");
      let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new SlackWebhookValidationError("Slack interaction payload is not valid JSON."); }
      const action = parseSlackBlockActions(parsed);
      if ("ignored" in action) return Object.freeze({ kind: "ignored" as const, reason: "not_a_button_action" as const });
      const verified = verifySignedChoicePayload({ payload: action.value, bindingParts: [action.teamId, action.channelId, action.userId], signingSecret: options.choiceSigningSecret, nowSeconds: Math.floor(now().getTime() / 1_000) });
      if (verified === null) return Object.freeze({ kind: "continue" as const, deduplicationKey: action.actionTs, reason: "choice_replayed" as const });
      const resolved = await options.choiceStore.resolve({ teamId: action.teamId, channelId: action.channelId, userId: action.userId, payload: action.value, selectionActionTs: action.actionTs, nonce: verified.nonce });
      if (resolved === null) return Object.freeze({ kind: "continue" as const, deduplicationKey: action.actionTs, reason: "choice_replayed" as const });
      try { await options.chatbot.recordConfirmation({ suggestionId: resolved.suggestionId, selectedDetectorId: resolved.detectorId, actor: "customer", decisionId: action.actionTs }); }
      catch (error) { options.onFeedbackError?.(error, action); }
      const request: SlackPostMessageRequest = Object.freeze({ method: "POST" as const, path: "/chat.postMessage" as const, body: Object.freeze({ channel: action.channelId, text: resolved.reply.length > 0 ? resolved.reply : "Thanks — noted." }) });
      return Object.freeze({ kind: "post_message" as const, deduplicationKey: action.actionTs, request, pendingChoices: null,
        wordless: Object.freeze({ suggestionId: resolved.suggestionId, outcome: "clarification_choices" as const, evidenceIndexes: Object.freeze([]) }) });
    },
  });
}

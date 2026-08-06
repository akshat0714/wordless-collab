import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  classifyChoiceFeedback,
  createSignedChoicePayload,
  detectHumanRequest,
  isShowChoicesRequest,
  verifySignedChoicePayload,
  type ChoiceFeedback,
} from "./channel-support.js";
import {
  WordlessSdkError,
  type WordlessEvidence,
  type WordlessJsonValue,
  type WordlessSupportChatbot,
  type WordlessSupportChatTurn,
  type WordlessSupportChoice,
} from "./server.js";

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
        results.push(Object.freeze({ kind: "ignored", reason: "wrong_number", messageId: null }));
        continue;
      }
      if (Array.isArray(val.statuses) && val.statuses.length > 0) {
        results.push(Object.freeze({ kind: "ignored", reason: "status", messageId: null }));
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
          results.push(Object.freeze({ kind: "message", inbound: Object.freeze({
            phoneNumberId, waId, messageId, receivedAt, type: "text",
            text: optionalString(message.text.body, MAX_TEXT_LENGTH) ?? "", buttonPayload: null,
          }) }));
        } else if (
          message.type === "interactive" && isRecord(message.interactive) &&
          message.interactive.type === "button_reply" && isRecord(message.interactive.button_reply)
        ) {
          const payload = optionalString(message.interactive.button_reply.id, 256);
          if (payload === null) { results.push(Object.freeze({ kind: "ignored", reason: "unsupported_type", messageId })); continue; }
          results.push(Object.freeze({ kind: "message", inbound: Object.freeze({
            phoneNumberId, waId, messageId, receivedAt, type: "button_reply", text: null, buttonPayload: payload,
          }) }));
        } else {
          results.push(Object.freeze({ kind: "ignored", reason: "unsupported_type", messageId }));
        }
      }
    }
  }
  return Object.freeze(results);
}

export type WhatsAppJsonValue =
  | null | boolean | number | string
  | readonly WhatsAppJsonValue[]
  | { readonly [key: string]: WhatsAppJsonValue };

export const WHATSAPP_SHOW_CHOICES_LABEL = "Not sure what to say";
const MAX_BUTTON_TITLE = 20;
const MAX_BUTTONS = 3;
const MAX_BUTTON_ID = 256;

export interface WhatsAppSendRequest {
  readonly method: "POST";
  readonly path: string;
  readonly body: WhatsAppJsonValue;
}

export interface WhatsAppPendingChoice {
  readonly payload: string;
  readonly id: string;
  readonly label: string;
  readonly reply: string;
  readonly detectorId: string | null;
  readonly feedback: ChoiceFeedback;
  readonly evidenceIndexes: readonly number[];
}

export interface WhatsAppPendingChoiceSet {
  readonly phoneNumberId: string;
  readonly waId: string;
  readonly suggestionId: string;
  readonly sourceMessageId: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly choices: readonly WhatsAppPendingChoice[];
}

function buttonTitle(choice: WordlessSupportChoice): string {
  const label = choice.detectorId === null ? WHATSAPP_SHOW_CHOICES_LABEL : choice.label;
  if (label.length > MAX_BUTTON_TITLE) {
    throw new WhatsAppIntegrationError(
      `WhatsApp reply-button title must be at most ${MAX_BUTTON_TITLE} characters: "${label}".`,
    );
  }
  return label;
}

function textBody(waId: string, text: string): WhatsAppJsonValue {
  return Object.freeze({
    messaging_product: "whatsapp", recipient_type: "individual", to: waId,
    type: "text", text: Object.freeze({ body: text, preview_url: false }),
  });
}

export function buildWhatsAppSendRequest(
  inbound: WhatsAppInboundMessage,
  turn: WordlessSupportChatTurn,
  signingSecret: string,
  nonce: string,
  issuedAtSeconds: number,
  expiresAtSeconds: number,
): { readonly request: WhatsAppSendRequest; readonly pendingChoices: WhatsAppPendingChoiceSet | null } {
  if (turn.message === null) {
    throw new WhatsAppIntegrationError("A visible WhatsApp turn must contain a message.");
  }
  const path = `/${encodeURIComponent(inbound.phoneNumberId)}/messages`;
  if (turn.renderMode !== "choices" || turn.choices.length === 0) {
    return Object.freeze({ request: Object.freeze({ method: "POST" as const, path, body: textBody(inbound.waId, turn.message) }), pendingChoices: null });
  }
  if (turn.choices.length > MAX_BUTTONS) {
    throw new WhatsAppIntegrationError(`WhatsApp supports at most ${MAX_BUTTONS} reply buttons.`);
  }
  const pending: WhatsAppPendingChoice[] = [];
  const buttons = turn.choices.map((choice) => {
    const feedback = classifyChoiceFeedback(turn.kind, choice.detectorId);
    const payload = createSignedChoicePayload({
      bindingParts: [inbound.phoneNumberId, inbound.waId],
      suggestionId: turn.suggestionId, choiceId: choice.id, detectorId: choice.detectorId,
      feedback, issuedAtSeconds, expiresAtSeconds, nonce, signingSecret,
    });
    if (payload.length > MAX_BUTTON_ID) {
      throw new WhatsAppIntegrationError("WhatsApp reply-button id exceeds 256 characters.");
    }
    const title = buttonTitle(choice);
    pending.push(Object.freeze({
      payload, id: choice.id, label: title, reply: choice.reply,
      detectorId: choice.detectorId, feedback, evidenceIndexes: choice.evidenceIndexes,
    }));
    return Object.freeze({ type: "reply", reply: Object.freeze({ id: payload, title }) });
  });
  const body: WhatsAppJsonValue = Object.freeze({
    messaging_product: "whatsapp", recipient_type: "individual", to: inbound.waId,
    type: "interactive",
    interactive: Object.freeze({
      type: "button",
      body: Object.freeze({ text: turn.message }),
      action: Object.freeze({ buttons: Object.freeze(buttons) }),
    }),
  });
  const pendingChoices: WhatsAppPendingChoiceSet = Object.freeze({
    phoneNumberId: inbound.phoneNumberId, waId: inbound.waId, suggestionId: turn.suggestionId,
    sourceMessageId: inbound.messageId, nonce,
    issuedAt: new Date(issuedAtSeconds * 1_000).toISOString(),
    expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
    choices: Object.freeze(pending),
  });
  return Object.freeze({ request: Object.freeze({ method: "POST" as const, path, body }), pendingChoices });
}

const DEFAULT_CHOICE_TTL_MS = 30 * 60 * 1_000;
const MAX_CHOICE_TTL_MS = 24 * 60 * 60 * 1_000;

export interface WhatsAppAuthenticatedAccount {
  readonly authenticated: true;
  readonly customerId: string;
  readonly observedAt: string;
  readonly evidence: readonly WordlessEvidence[];
  readonly metadata?: Readonly<Record<string, WordlessJsonValue>>;
}

export interface WhatsAppChoiceResolveInput {
  readonly phoneNumberId: string;
  readonly waId: string;
  readonly payload: string;
  readonly selectionMessageId: string;
  readonly selectionReceivedAt: string;
  readonly nonce: string;
}

export interface WhatsAppResolvedChoice {
  readonly suggestionId: string;
  readonly choiceId: string;
  readonly detectorId: string | null;
  readonly reply: string;
  readonly feedback: ChoiceFeedback;
}

export interface WhatsAppChoiceStore {
  save(set: WhatsAppPendingChoiceSet): Promise<void>;
  resolve(input: WhatsAppChoiceResolveInput): Promise<WhatsAppResolvedChoice | null>;
}

export type WhatsAppContinueReason =
  | "account_not_authenticated" | "wordless_unavailable" | "continue_host_bot" | "choice_replayed";

interface WhatsAppResultBase { readonly inbound: WhatsAppInboundMessage; readonly deduplicationKey: string; }

export interface WhatsAppPostMessageResult extends WhatsAppResultBase {
  readonly kind: "post_message";
  readonly request: WhatsAppSendRequest;
  readonly pendingChoices: WhatsAppPendingChoiceSet | null;
  readonly wordless: { readonly suggestionId: string; readonly outcome: WordlessSupportChatTurn["kind"]; readonly evidenceIndexes: readonly number[]; };
}
export interface WhatsAppContinueResult extends WhatsAppResultBase { readonly kind: "continue"; readonly reason: WhatsAppContinueReason; }
export interface WhatsAppHandoffResult extends WhatsAppResultBase { readonly kind: "handoff"; readonly reason: "human_requested"; }
export interface WhatsAppIgnoredResult { readonly kind: "ignored"; readonly reason: "status" | "unsupported_type" | "wrong_number"; readonly messageId: string | null; }
export type WhatsAppResult = WhatsAppPostMessageResult | WhatsAppContinueResult | WhatsAppHandoffResult | WhatsAppIgnoredResult;

export interface WhatsAppCloudAdapterOptions {
  readonly chatbot: WordlessSupportChatbot;
  readonly appSecret: string;
  readonly phoneNumberId: string;
  readonly choiceSigningSecret: string;
  readonly resolveAuthenticatedAccount: (inbound: WhatsAppInboundMessage) => Promise<WhatsAppAuthenticatedAccount | null>;
  readonly choiceStore: WhatsAppChoiceStore;
  readonly humanHandoff?: { readonly enabled: boolean };
  readonly accountResolutionFailureMode?: "throw" | "continue";
  readonly choiceTtlMs?: number;
  readonly now?: () => Date;
  readonly onWordlessError?: (error: WordlessSdkError, inbound: WhatsAppInboundMessage) => void;
  readonly onAccountResolutionError?: (error: unknown, inbound: WhatsAppInboundMessage) => void;
  readonly onFeedbackError?: (error: unknown, inbound: WhatsAppInboundMessage) => void;
}

export interface WhatsAppCloudAdapter {
  processWebhook(rawBody: string, signatureHeader: string | null): Promise<readonly WhatsAppResult[]>;
}

function randomNonce(): string {
  // A per-choice-set random value; not time-derived, so it does not violate the injected-clock rule.
  return randomBytes(12).toString("base64url");
}

export function createWhatsAppCloudAdapter(options: WhatsAppCloudAdapterOptions): WhatsAppCloudAdapter {
  const ttl = options.choiceTtlMs ?? DEFAULT_CHOICE_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > MAX_CHOICE_TTL_MS) {
    throw new WhatsAppIntegrationError("choiceTtlMs must be between one minute and 24 hours.");
  }
  const now = options.now ?? (() => new Date());
  const humanEnabled = options.humanHandoff?.enabled === true;

  async function handleTextMessage(inbound: WhatsAppInboundMessage): Promise<WhatsAppResult> {
    if (humanEnabled && inbound.text !== null && detectHumanRequest(inbound.text)) {
      return Object.freeze({ kind: "handoff" as const, inbound, deduplicationKey: inbound.messageId, reason: "human_requested" as const });
    }
    let account: WhatsAppAuthenticatedAccount | null;
    try {
      account = await options.resolveAuthenticatedAccount(inbound);
    } catch (error) {
      if ((options.accountResolutionFailureMode ?? "throw") === "continue") {
        options.onAccountResolutionError?.(error, inbound);
        return Object.freeze({ kind: "continue" as const, inbound, deduplicationKey: inbound.messageId, reason: "account_not_authenticated" as const });
      }
      throw error;
    }
    if (account === null) {
      return Object.freeze({ kind: "continue" as const, inbound, deduplicationKey: inbound.messageId, reason: "account_not_authenticated" as const });
    }
    let turn: WordlessSupportChatTurn;
    try {
      turn = await options.chatbot.processMessage({
        messageId: inbound.messageId, customerId: account.customerId, text: inbound.text ?? "",
        sentAt: inbound.receivedAt, observedAt: account.observedAt, channel: "chat",
        evidence: account.evidence,
        showChoices: isShowChoicesRequest(inbound.text, false),
        ...(account.metadata !== undefined ? { metadata: account.metadata } : {}),
      });
    } catch (error) {
      if (error instanceof WordlessSdkError) {
        options.onWordlessError?.(error, inbound);
        return Object.freeze({ kind: "continue" as const, inbound, deduplicationKey: inbound.messageId, reason: "wordless_unavailable" as const });
      }
      throw error;
    }
    if (turn.hostAction === "continue_host_bot") {
      return Object.freeze({ kind: "continue" as const, inbound, deduplicationKey: inbound.messageId, reason: "continue_host_bot" as const });
    }
    const issuedAtSeconds = Math.floor(now().getTime() / 1_000);
    const expiresAtSeconds = issuedAtSeconds + Math.ceil(ttl / 1_000);
    const { request, pendingChoices } = buildWhatsAppSendRequest(inbound, turn, options.choiceSigningSecret, randomNonce(), issuedAtSeconds, expiresAtSeconds);
    if (pendingChoices !== null) await options.choiceStore.save(pendingChoices);
    return Object.freeze({ kind: "post_message" as const, inbound, deduplicationKey: inbound.messageId, request, pendingChoices,
      wordless: Object.freeze({ suggestionId: turn.suggestionId, outcome: turn.kind, evidenceIndexes: turn.evidenceIndexes }) });
  }

  async function handleButtonReply(inbound: WhatsAppInboundMessage): Promise<WhatsAppResult> {
    const payload = inbound.buttonPayload!;
    const verified = verifySignedChoicePayload({
      payload, bindingParts: [inbound.phoneNumberId, inbound.waId],
      signingSecret: options.choiceSigningSecret, nowSeconds: Math.floor(now().getTime() / 1_000),
    });
    if (verified === null) {
      return Object.freeze({ kind: "continue" as const, inbound, deduplicationKey: inbound.messageId, reason: "choice_replayed" as const });
    }
    const resolved = await options.choiceStore.resolve({
      phoneNumberId: inbound.phoneNumberId, waId: inbound.waId, payload,
      selectionMessageId: inbound.messageId, selectionReceivedAt: inbound.receivedAt, nonce: verified.nonce,
    });
    if (resolved === null) {
      return Object.freeze({ kind: "continue" as const, inbound, deduplicationKey: inbound.messageId, reason: "choice_replayed" as const });
    }
    try {
      await options.chatbot.recordConfirmation({
        suggestionId: resolved.suggestionId, selectedDetectorId: resolved.detectorId,
        actor: "customer", decisionId: inbound.messageId,
      });
    } catch (error) {
      options.onFeedbackError?.(error, inbound);
    }
    const request: WhatsAppSendRequest = Object.freeze({ method: "POST" as const,
      path: `/${encodeURIComponent(inbound.phoneNumberId)}/messages`,
      body: textBody(inbound.waId, resolved.reply.length > 0 ? resolved.reply : "Thanks — noted.") });
    return Object.freeze({ kind: "post_message" as const, inbound, deduplicationKey: inbound.messageId, request, pendingChoices: null,
      wordless: Object.freeze({ suggestionId: resolved.suggestionId, outcome: "clarification_choices" as const, evidenceIndexes: Object.freeze([]) }) });
  }

  return Object.freeze({
    async processWebhook(rawBody: string, signatureHeader: string | null): Promise<readonly WhatsAppResult[]> {
      if (!verifyWhatsAppSignature(rawBody, signatureHeader, options.appSecret)) {
        throw new WhatsAppWebhookValidationError("WhatsApp webhook signature is invalid.");
      }
      let parsedBody: unknown;
      try { parsedBody = JSON.parse(rawBody); } catch { throw new WhatsAppWebhookValidationError("WhatsApp webhook body is not valid JSON."); }
      const entries = parseWhatsAppEnvelope(parsedBody, options.phoneNumberId);
      const results: WhatsAppResult[] = [];
      for (const entry of entries) {
        if (entry.kind === "ignored") { results.push(entry); continue; }
        results.push(entry.inbound.type === "text" ? await handleTextMessage(entry.inbound) : await handleButtonReply(entry.inbound));
      }
      return Object.freeze(results);
    },
  });
}

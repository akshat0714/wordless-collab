// sdk/tests/whatsapp.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseWhatsAppEnvelope,
  verifyWhatsAppSignature,
  verifyWhatsAppSubscription,
  WhatsAppWebhookValidationError,
} from "../src/whatsapp.js";
import { buildWhatsAppSendRequest, WHATSAPP_SHOW_CHOICES_LABEL } from "../src/whatsapp.js";
import { WhatsAppIntegrationError } from "../src/whatsapp.js";
import { createWhatsAppCloudAdapter } from "../src/whatsapp.js";
import type { WhatsAppChoiceStore, WhatsAppPendingChoiceSet, WhatsAppResolvedChoice } from "../src/whatsapp.js";
import type { WordlessSupportChatTurn } from "../src/server.js";
import { WordlessSdkError } from "../src/server.js";

const APP_SECRET = "meta-app-secret-000000000000000000";
function sign(body: string): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex");
}

describe("verifyWhatsAppSignature", () => {
  it("accepts a correct signature and rejects wrong/absent ones", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    expect(verifyWhatsAppSignature(body, sign(body), APP_SECRET)).toBe(true);
    expect(verifyWhatsAppSignature(body, "sha256=deadbeef", APP_SECRET)).toBe(false);
    expect(verifyWhatsAppSignature(body, null, APP_SECRET)).toBe(false);
    expect(verifyWhatsAppSignature(body + " ", sign(body), APP_SECRET)).toBe(false);
  });
});

describe("verifyWhatsAppSubscription", () => {
  it("echoes the challenge on a valid subscribe and throws otherwise", () => {
    expect(verifyWhatsAppSubscription({ mode: "subscribe", token: "vt", challenge: "42" }, "vt")).toBe("42");
    expect(() => verifyWhatsAppSubscription({ mode: "subscribe", token: "bad", challenge: "42" }, "vt")).toThrow(WhatsAppWebhookValidationError);
    expect(() => verifyWhatsAppSubscription({ mode: "unsubscribe", token: "vt", challenge: "42" }, "vt")).toThrow(WhatsAppWebhookValidationError);
  });
});

const PN = "111222333";
function textEnvelope(body: string) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "e1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "1555", phone_number_id: PN },
      contacts: [{ wa_id: "15551230000" }],
      messages: [{ from: "15551230000", id: "wamid.1", timestamp: "1700000000", type: "text", text: { body } }],
    } }] }],
  };
}

describe("parseWhatsAppEnvelope", () => {
  it("parses a text message", () => {
    const parsed = parseWhatsAppEnvelope(textEnvelope("where is my order"), PN);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ kind: "message", inbound: {
      phoneNumberId: PN, waId: "15551230000", messageId: "wamid.1",
      receivedAt: "2023-11-14T22:13:20.000Z", type: "text", text: "where is my order", buttonPayload: null,
    } });
  });

  it("parses an interactive button_reply", () => {
    const env = textEnvelope("x");
    env.entry[0]!.changes[0]!.value.messages[0] = { from: "15551230000", id: "wamid.2", timestamp: "1700000000",
      type: "interactive", interactive: { type: "button_reply", button_reply: { id: "wl2.sg.x", title: "Yes" } } } as any;
    const parsed = parseWhatsAppEnvelope(env, PN);
    expect(parsed[0]).toMatchObject({ kind: "message", inbound: { type: "button_reply", buttonPayload: "wl2.sg.x", text: null } });
  });

  it("ignores delivery statuses, unsupported types, and wrong phone numbers", () => {
    const status = { object: "whatsapp_business_account", entry: [{ id: "e", changes: [{ field: "messages", value: {
      metadata: { phone_number_id: PN }, statuses: [{ id: "wamid.s", status: "delivered" }] } }] }] };
    expect(parseWhatsAppEnvelope(status, PN)[0]).toMatchObject({ kind: "ignored", reason: "status" });

    const image = textEnvelope("x");
    image.entry[0]!.changes[0]!.value.messages[0] = { from: "1", id: "wamid.i", timestamp: "1700000000", type: "image", image: {} } as any;
    expect(parseWhatsAppEnvelope(image, PN)[0]).toMatchObject({ kind: "ignored", reason: "unsupported_type" });

    expect(parseWhatsAppEnvelope(textEnvelope("x"), "999")[0]).toMatchObject({ kind: "ignored", reason: "wrong_number" });
  });

  it("bounds the number of changes processed per entry", () => {
    const change = { field: "messages", value: {
      metadata: { phone_number_id: PN }, statuses: [{ id: "wamid.s", status: "delivered" }],
    } };
    const withinBound = { object: "whatsapp_business_account", entry: [{ id: "e", changes: Array(50).fill(change) }] };
    expect(() => parseWhatsAppEnvelope(withinBound, PN)).not.toThrow();

    const overBound = { object: "whatsapp_business_account", entry: [{ id: "e", changes: Array(51).fill(change) }] };
    expect(() => parseWhatsAppEnvelope(overBound, PN)).toThrow(WhatsAppWebhookValidationError);
  });
});

const INBOUND = { phoneNumberId: "111", waId: "1555", messageId: "wamid.1",
  receivedAt: "2023-11-14T22:13:20.000Z", type: "text", text: "charged twice", buttonPayload: null } as const;
const SIG = "sig-secret-000000000000000000000000";
const SUG = "sg_" + "b".repeat(32);

function turnBase(kind: WordlessSupportChatTurn["kind"]) {
  return { suggestionId: SUG, reviewRequired: true, readOnly: true, processingMs: 5, kind } as const;
}

describe("buildWhatsAppSendRequest", () => {
  it("maps a grounded_reply to a text message", () => {
    const turn = { ...turnBase("grounded_reply"), hostAction: "show_wordless", renderMode: "message",
      message: "Your last charge was $20 on Tuesday.", choices: [], detectorId: null, evidenceIndexes: [0], reason: null } as any;
    const { request, pendingChoices } = buildWhatsAppSendRequest(INBOUND, turn, SIG, "nonceAA", 1000, 2000);
    expect(request.path).toBe("/111/messages");
    expect((request.body as any).type).toBe("text");
    expect((request.body as any).text.body).toContain("last charge");
    expect(pendingChoices).toBeNull();
  });

  it("maps clarification_choices to interactive buttons with the short show-choices label", () => {
    const turn = { ...turnBase("clarification_choices"), hostAction: "show_wordless", renderMode: "choices",
      message: "Did you mean:", detectorId: "duplicate_charge", evidenceIndexes: [0], reason: null,
      choices: [
        { id: "c1", label: "A duplicate charge", reply: "I think I was charged twice.", detectorId: "duplicate_charge", evidenceIndexes: [0] },
        { id: "c2", label: "I don't know what to say", reply: "", detectorId: null, evidenceIndexes: [] },
      ] } as any;
    const { request, pendingChoices } = buildWhatsAppSendRequest(INBOUND, turn, SIG, "nonceAA", 1000, 2000);
    const buttons = (request.body as any).interactive.action.buttons;
    expect(buttons).toHaveLength(2);
    expect(buttons[0].reply.title).toBe("A duplicate charge");
    expect(buttons[1].reply.title).toBe(WHATSAPP_SHOW_CHOICES_LABEL);
    expect(buttons[0].reply.id.startsWith("wl2.")).toBe(true);
    expect(pendingChoices?.choices).toHaveLength(2);
  });

  it("raises on an over-long detector label", () => {
    const turn = { ...turnBase("clarification_choices"), hostAction: "show_wordless", renderMode: "choices",
      message: "Did you mean:", detectorId: "duplicate_charge", evidenceIndexes: [0], reason: null,
      choices: [
        { id: "c1", label: "This label is definitely longer than twenty", reply: "x", detectorId: "duplicate_charge", evidenceIndexes: [0] },
        { id: "c2", label: "I don't know what to say", reply: "", detectorId: null, evidenceIndexes: [] },
      ] } as any;
    expect(() => buildWhatsAppSendRequest(INBOUND, turn, SIG, "nonceAA", 1000, 2000)).toThrow(WhatsAppIntegrationError);
  });
});

const APP = "meta-app-secret-000000000000000000";
function signBody(b: string) { return "sha256=" + createHmac("sha256", APP).update(b, "utf8").digest("hex"); }
const FIXED = () => new Date("2023-11-14T22:13:30.000Z");

function memoryStore(): WhatsAppChoiceStore {
  const sets = new Map<string, WhatsAppPendingChoiceSet>();
  const consumed = new Map<string, WhatsAppResolvedChoice>();
  return {
    async save(set) { for (const c of set.choices) sets.set(`${set.phoneNumberId}:${set.waId}:${c.payload}`, set); },
    async resolve(input) {
      const key = `${input.phoneNumberId}:${input.waId}:${input.payload}`;
      const set = sets.get(key);
      if (!set) return consumed.get(input.selectionMessageId) ?? null;
      const choice = set.choices.find((c) => c.payload === input.payload)!;
      const resolved: WhatsAppResolvedChoice = { suggestionId: set.suggestionId, choiceId: choice.id,
        detectorId: choice.detectorId, reply: choice.reply, feedback: choice.feedback };
      sets.delete(key); consumed.set(input.selectionMessageId, resolved);
      return resolved;
    },
  };
}

function clarifyChatbot() {
  return {
    async processMessage() {
      return { kind: "clarification_choices", hostAction: "show_wordless", renderMode: "choices",
        suggestionId: "sg_" + "c".repeat(32), reviewRequired: true, readOnly: true, processingMs: 3,
        message: "Did you mean:", detectorId: "duplicate_charge", evidenceIndexes: [0], reason: null,
        choices: [
          { id: "c1", label: "A duplicate charge", reply: "I was charged twice.", detectorId: "duplicate_charge", evidenceIndexes: [0] },
          { id: "c2", label: "x", reply: "", detectorId: null, evidenceIndexes: [] },
        ] } as any;
    },
    async recordConfirmation() { return { feedback_id: "fb_" + "0".repeat(32), recorded: true } as any; },
  };
}

const account = { authenticated: true as const, customerId: "acct_42",
  observedAt: "2023-11-14T22:13:25.000Z", evidence: [] };

function textWebhook(body: string) {
  return JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "e1", changes: [{ field: "messages", value: {
    metadata: { phone_number_id: "111" }, contacts: [{ wa_id: "1555" }],
    messages: [{ from: "1555", id: "wamid.text", timestamp: "1700000000", type: "text", text: { body } }] } }] }] });
}

describe("createWhatsAppCloudAdapter", () => {
  it("posts clarification buttons for a supportable message", async () => {
    const store = memoryStore();
    const adapter = createWhatsAppCloudAdapter({ chatbot: clarifyChatbot() as any, appSecret: APP, phoneNumberId: "111",
      choiceSigningSecret: "sig-secret-000000000000000000000000", resolveAuthenticatedAccount: async () => account,
      choiceStore: store, now: FIXED });
    const raw = textWebhook("charged twice");
    const [result] = await adapter.processWebhook(raw, signBody(raw));
    expect(result!.kind).toBe("post_message");
    expect((result as any).request.body.type).toBe("interactive");
  });

  it("rejects a bad signature", async () => {
    const adapter = createWhatsAppCloudAdapter({ chatbot: clarifyChatbot() as any, appSecret: APP, phoneNumberId: "111",
      choiceSigningSecret: "sig-secret-000000000000000000000000", resolveAuthenticatedAccount: async () => account,
      choiceStore: memoryStore(), now: FIXED });
    await expect(adapter.processWebhook(textWebhook("x"), "sha256=bad")).rejects.toThrow(
      WhatsAppWebhookValidationError,
    );
  });

  it("continues the host bot when the account is unauthenticated", async () => {
    const adapter = createWhatsAppCloudAdapter({ chatbot: clarifyChatbot() as any, appSecret: APP, phoneNumberId: "111",
      choiceSigningSecret: "sig-secret-000000000000000000000000", resolveAuthenticatedAccount: async () => null,
      choiceStore: memoryStore(), now: FIXED });
    const raw = textWebhook("charged twice");
    const [result] = await adapter.processWebhook(raw, signBody(raw));
    expect(result).toMatchObject({ kind: "continue", reason: "account_not_authenticated" });
  });

  it("continues safely on a Wordless error", async () => {
    const failing = { processMessage: async () => { throw new WordlessSdkError("boom"); },
      recordConfirmation: async () => ({}) } as any;
    const errors: unknown[] = [];
    const adapter = createWhatsAppCloudAdapter({ chatbot: failing, appSecret: APP, phoneNumberId: "111",
      choiceSigningSecret: "sig-secret-000000000000000000000000", resolveAuthenticatedAccount: async () => account,
      choiceStore: memoryStore(), now: FIXED, onWordlessError: (e) => errors.push(e) });
    const raw = textWebhook("charged twice");
    const [result] = await adapter.processWebhook(raw, signBody(raw));
    expect(result).toMatchObject({ kind: "continue", reason: "wordless_unavailable" });
    expect(errors).toHaveLength(1);
  });

  it("resolves a tapped button once and records confirmation", async () => {
    const store = memoryStore();
    const recorded: unknown[] = [];
    const chatbot = { ...clarifyChatbot(), recordConfirmation: async (c: unknown) => { recorded.push(c); return {} as any; } };
    const adapter = createWhatsAppCloudAdapter({ chatbot: chatbot as any, appSecret: APP, phoneNumberId: "111",
      choiceSigningSecret: "sig-secret-000000000000000000000000", resolveAuthenticatedAccount: async () => account,
      choiceStore: store, now: FIXED });
    const raw = textWebhook("charged twice");
    const [posted] = await adapter.processWebhook(raw, signBody(raw));
    const payload = (posted as any).request.body.interactive.action.buttons[0].reply.id as string;
    const tap = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "e", changes: [{ field: "messages", value: {
      metadata: { phone_number_id: "111" }, contacts: [{ wa_id: "1555" }],
      messages: [{ from: "1555", id: "wamid.tap", timestamp: "1700000005", type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: payload, title: "A duplicate charge" } } }] } }] }] });
    const [replyResult] = await adapter.processWebhook(tap, signBody(tap));
    expect(replyResult!.kind).toBe("post_message");
    expect((replyResult as any).request.body.text.body).toContain("charged twice");
    expect(recorded).toHaveLength(1);
    // A replay of the same payload with a new message id resolves to null → continue.
    const replay = tap.replace("wamid.tap", "wamid.tap2");
    const [replayResult] = await adapter.processWebhook(replay, signBody(replay));
    expect(replayResult).toMatchObject({ kind: "continue", reason: "choice_replayed" });
  });

  it("hands off to a human when human handoff is enabled and the message requests one", async () => {
    const adapter = createWhatsAppCloudAdapter({ chatbot: clarifyChatbot() as any, appSecret: APP, phoneNumberId: "111",
      choiceSigningSecret: "sig-secret-000000000000000000000000", resolveAuthenticatedAccount: async () => account,
      choiceStore: memoryStore(), now: FIXED, humanHandoff: { enabled: true } });
    const raw = textWebhook("connect me to a human");
    const [result] = await adapter.processWebhook(raw, signBody(raw));
    expect(result).toMatchObject({ kind: "handoff", reason: "human_requested" });
  });

  it("does not hand off the same phrasing when human handoff is not enabled", async () => {
    const adapter = createWhatsAppCloudAdapter({ chatbot: clarifyChatbot() as any, appSecret: APP, phoneNumberId: "111",
      choiceSigningSecret: "sig-secret-000000000000000000000000", resolveAuthenticatedAccount: async () => account,
      choiceStore: memoryStore(), now: FIXED });
    const raw = textWebhook("connect me to a human");
    const [result] = await adapter.processWebhook(raw, signBody(raw));
    expect(result!.kind).not.toBe("handoff");
    expect(result!.kind).toBe("post_message");
  });

  it("returns a safe continue and reports the error when the resolver throws under accountResolutionFailureMode: continue", async () => {
    const boom = new Error("resolver exploded");
    const errors: unknown[] = [];
    const adapter = createWhatsAppCloudAdapter({ chatbot: clarifyChatbot() as any, appSecret: APP, phoneNumberId: "111",
      choiceSigningSecret: "sig-secret-000000000000000000000000",
      resolveAuthenticatedAccount: async () => { throw boom; },
      choiceStore: memoryStore(), now: FIXED,
      accountResolutionFailureMode: "continue",
      onAccountResolutionError: (error) => errors.push(error) });
    const raw = textWebhook("charged twice");
    const [result] = await adapter.processWebhook(raw, signBody(raw));
    expect(result).toMatchObject({ kind: "continue", reason: "account_not_authenticated" });
    expect(errors).toEqual([boom]);
  });

  it("propagates the resolver's error out of processWebhook by default", async () => {
    const boom = new Error("resolver exploded");
    const adapter = createWhatsAppCloudAdapter({ chatbot: clarifyChatbot() as any, appSecret: APP, phoneNumberId: "111",
      choiceSigningSecret: "sig-secret-000000000000000000000000",
      resolveAuthenticatedAccount: async () => { throw boom; },
      choiceStore: memoryStore(), now: FIXED });
    const raw = textWebhook("charged twice");
    await expect(adapter.processWebhook(raw, signBody(raw))).rejects.toBe(boom);
  });

  it("treats an expired signed button payload as a safe continue, without recording confirmation", async () => {
    const store = memoryStore();
    const recorded: unknown[] = [];
    const chatbot = { ...clarifyChatbot(), recordConfirmation: async (c: unknown) => { recorded.push(c); return {} as any; } };
    let currentTime = new Date("2023-11-14T22:13:30.000Z");
    const adapter = createWhatsAppCloudAdapter({ chatbot: chatbot as any, appSecret: APP, phoneNumberId: "111",
      choiceSigningSecret: "sig-secret-000000000000000000000000", resolveAuthenticatedAccount: async () => account,
      choiceStore: store, now: () => currentTime, choiceTtlMs: 60_000 });
    const raw = textWebhook("charged twice");
    const [posted] = await adapter.processWebhook(raw, signBody(raw));
    const payload = (posted as any).request.body.interactive.action.buttons[0].reply.id as string;
    // Advance the injected clock past the 60s choice TTL before the tap arrives.
    currentTime = new Date(currentTime.getTime() + 61_000);
    const tap = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "e", changes: [{ field: "messages", value: {
      metadata: { phone_number_id: "111" }, contacts: [{ wa_id: "1555" }],
      messages: [{ from: "1555", id: "wamid.expired", timestamp: "1700000005", type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: payload, title: "A duplicate charge" } } }] } }] }] });
    const [result] = await adapter.processWebhook(tap, signBody(tap));
    expect(result).toMatchObject({ kind: "continue", reason: "choice_replayed" });
    expect(recorded).toHaveLength(0);
  });
});

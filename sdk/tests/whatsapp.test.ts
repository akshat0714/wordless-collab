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
import type { WordlessSupportChatTurn } from "../src/server.js";

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

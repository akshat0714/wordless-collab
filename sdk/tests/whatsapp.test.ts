// sdk/tests/whatsapp.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseWhatsAppEnvelope,
  verifyWhatsAppSignature,
  verifyWhatsAppSubscription,
  WhatsAppWebhookValidationError,
} from "../src/whatsapp.js";

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

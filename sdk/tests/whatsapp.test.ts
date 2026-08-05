// sdk/tests/whatsapp.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
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

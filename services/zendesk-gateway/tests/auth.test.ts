import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { authenticateWebhook } from "../src/auth.js";
import { MemorySecretStore } from "../src/secrets.js";
import { installation } from "./helpers.js";

const secret = "w".repeat(40);
const secrets = new MemorySecretStore({ ZENDESK_WEBHOOK_SECRET: secret });

describe("webhook authentication", () => {
  it("supports Marketplace X-API-Key authentication", async () => {
    await expect(authenticateWebhook(installation, { "x-api-key": secret }, Buffer.from("{}"), null, 300, secrets)).resolves.toBe(true);
    await expect(authenticateWebhook(installation, { "x-api-key": "wrong" }, Buffer.from("{}"), null, 300, secrets)).resolves.toBe(false);
  });

  it("verifies a timestamped delivery-bound HMAC", async () => {
    const hmacInstallation = { ...installation, webhookAuth: { mode: "hmac_sha256" as const, secretRef: "ZENDESK_WEBHOOK_SECRET" } };
    const body = Buffer.from('{"ok":true}');
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const deliveryId = "delivery-123456789";
    const signature = createHmac("sha256", secret).update(`${timestamp}.${deliveryId}.`).update(body).digest("hex");
    await expect(authenticateWebhook(hmacInstallation, {
      "x-wordless-webhook-timestamp": timestamp,
      "x-wordless-delivery-id": deliveryId,
      "x-wordless-webhook-signature": `v1=${signature}`,
    }, body, null, 300, secrets)).resolves.toBe(true);
  });
});

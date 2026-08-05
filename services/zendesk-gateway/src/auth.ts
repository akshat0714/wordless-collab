import { createHmac, timingSafeEqual } from "node:crypto";

import type { IncomingHttpHeaders } from "node:http";
import { verifyZendeskWebhookApiKey } from "@wordless/sdk/zendesk-marketplace";

import type { Installation } from "./types.js";
import type { SecretStore } from "./secrets.js";

function singleHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  return typeof value === "string" ? value : null;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function authenticateWebhook(
  installation: Installation,
  headers: IncomingHttpHeaders,
  rawBody: Buffer,
  pathCredential: string | null,
  allowedClockSkewSeconds: number,
  secrets: SecretStore,
): Promise<boolean> {
  const secret = await secrets.get(installation.webhookAuth.secretRef);
  if (Buffer.byteLength(secret, "utf8") < 32) return false;
  if (installation.webhookAuth.mode === "path_bearer") {
    return pathCredential !== null && safeEqual(secret, pathCredential);
  }
  if (installation.webhookAuth.mode === "x_api_key") {
    return pathCredential === null && verifyZendeskWebhookApiKey(headers, secret);
  }
  if (pathCredential !== null) return false;
  const timestamp = singleHeader(headers, "x-wordless-webhook-timestamp");
  const signature = singleHeader(headers, "x-wordless-webhook-signature");
  const deliveryId = singleHeader(headers, "x-wordless-delivery-id") ?? "";
  if (timestamp === null || signature === null || !/^\d{10}$/u.test(timestamp) || !/^v1=[0-9a-f]{64}$/u.test(signature)) return false;
  const age = Math.abs(Math.floor(Date.now() / 1_000) - Number(timestamp));
  if (age > allowedClockSkewSeconds) return false;
  const expected = `v1=${createHmac("sha256", secret)
    .update(`${timestamp}.${deliveryId}.`, "utf8")
    .update(rawBody)
    .digest("hex")}`;
  return safeEqual(expected, signature);
}

export async function authenticateHead(
  installation: Installation,
  pathCredential: string | null,
  headers: IncomingHttpHeaders,
  secrets: SecretStore,
): Promise<boolean> {
  const secret = await secrets.get(installation.webhookAuth.secretRef);
  if (Buffer.byteLength(secret, "utf8") < 32) return false;
  if (installation.webhookAuth.mode === "path_bearer") return pathCredential !== null && safeEqual(secret, pathCredential);
  if (installation.webhookAuth.mode === "x_api_key") {
    return pathCredential === null && verifyZendeskWebhookApiKey(headers, secret);
  }
  return false;
}

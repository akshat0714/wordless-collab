import { describe, expect, it, vi } from "vitest";
import type { ZendeskInboundMessage } from "@wordless/sdk/zendesk";

import { EvidenceResolverError, HttpEvidenceResolver } from "../src/resolver.js";
import { MemorySecretStore } from "../src/secrets.js";
import { installation } from "./helpers.js";

const incoming: ZendeskInboundMessage = {
  appId: installation.appId,
  webhookId: installation.webhookId,
  eventId: "event-123",
  eventCreatedAt: "2026-01-01T00:00:00.000Z",
  conversationId: "conversation-123",
  messageId: "message-123",
  receivedAt: "2026-01-01T00:00:00.000Z",
  userId: "zendesk-user-123",
  sourceType: "web",
  sourceIntegrationId: null,
  activeSwitchboardIntegrationId: installation.switchboardIntegrationId,
  activeIntegrationId: installation.underlyingIntegrationId,
  contentType: "text",
  text: "help",
  payload: null,
};

const secrets = new MemorySecretStore({
  EVIDENCE_RESOLVER_HMAC_SECRET: "e".repeat(40),
  ZENDESK_KEY_ID: "key-id",
  ZENDESK_KEY_SECRET: "key-secret",
});

function resolver(fetchImplementation: typeof fetch): HttpEvidenceResolver {
  return new HttpEvidenceResolver({
    mode: "http",
    url: "https://evidence.example/v1/resolve",
    authorizationSecretRef: "EVIDENCE_RESOLVER_HMAC_SECRET",
    timeoutMs: 1_000,
  }, 1_000, secrets, fetchImplementation);
}

describe("authenticated evidence boundary", () => {
  it("verifies Zendesk authentication before making an evidence call", async () => {
    const mock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: incoming.userId, authenticated: false } }), { status: 200 }))
      .mockResolvedValueOnce(new Response("must not be called", { status: 500 }));
    await expect(resolver(mock).resolve(installation, incoming)).resolves.toBeNull();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("binds the resolver request and response to tenant and verified identity", async () => {
    const mock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: incoming.userId, authenticated: true, externalId: "customer-external-7", profile: { locale: "en-US" } } }), { status: 200 }))
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        expect(body).toMatchObject({
          installation_id: "acme",
          zendesk_identity: { type: "external_id", value: "customer-external-7" },
        });
        return new Response(JSON.stringify({
          authenticated: true,
          installation_id: body.installation_id,
          zendesk_identity: body.zendesk_identity,
          customer_id: "account-7",
          observed_at: "2026-01-01T00:00:01.000Z",
          evidence: [],
        }), { status: 200 });
      });
    await expect(resolver(mock).resolve(installation, incoming)).resolves.toMatchObject({ customerId: "account-7" });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("rejects a cross-tenant resolver response", async () => {
    const mock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: incoming.userId, authenticated: true, profile: { locale: "en" } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authenticated: true,
        installation_id: "another-tenant",
        zendesk_identity: { type: "user_id", value: incoming.userId },
        customer_id: "wrong-account",
        observed_at: "2026-01-01T00:00:01.000Z",
        evidence: [],
      }), { status: 200 }));
    await expect(resolver(mock).resolve(installation, incoming)).rejects.toBeInstanceOf(EvidenceResolverError);
  });

  it("passes explicit non-English and missing-locale profiles onward without an evidence call", async () => {
    for (const user of [
      { id: incoming.userId, authenticated: true, profile: { locale: "es-MX" } },
      { id: incoming.userId, authenticated: true },
    ]) {
      const mock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ user }), { status: 200 }))
        .mockResolvedValueOnce(new Response("must not be called", { status: 500 }));
      await expect(resolver(mock).resolve(installation, incoming)).resolves.toBeNull();
      expect(mock).toHaveBeenCalledTimes(1);
    }
  });
});

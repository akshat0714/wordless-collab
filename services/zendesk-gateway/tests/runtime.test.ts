import { expect, it, vi } from "vitest";

import { GatewayRuntime, sourceSystemForInstallation, splitWebhookEvents } from "../src/runtime.js";
import { EvidenceResolverError } from "../src/resolver.js";
import { MemoryGatewayStore } from "../src/store.js";
import { MemorySecretStore } from "../src/secrets.js";
import { MemoryLogger } from "../src/logger.js";
import { installation, testConfig } from "./helpers.js";

function envelope(text: string): Record<string, unknown> {
  return {
    app: { id: installation.appId },
    webhook: { id: installation.webhookId, version: "v2" },
    events: [{
      id: "event-123",
      type: "conversation:message",
      createdAt: new Date().toISOString(),
      payload: {
        conversation: {
          id: "conversation-123",
          activeSwitchboardIntegration: {
            id: installation.switchboardIntegrationId,
            integrationId: installation.underlyingIntegrationId,
          },
        },
        message: {
          id: "message-123",
          received: new Date().toISOString(),
          author: { type: "user", userId: "user-123" },
          content: { type: "text", text },
        },
      },
    }],
  };
}

it("preserves an explicit human request for the SDK human_requested route", () => {
  const [part] = splitWebhookEvents(envelope("Please let me talk to a real person"), installation, 300_000);
  const content = (part?.envelope as any).events[0].payload.message.content;
  expect(content.type).toBe("text");
  expect(content.text).toBe("Please let me talk to a real person");
});

it("does not intercept an ordinary customer message", () => {
  const [part] = splitWebhookEvents(envelope("My order is late"), installation, 300_000);
  const content = (part?.envelope as any).events[0].payload.message.content;
  expect(content.type).toBe("text");
});

it("builds API-valid stable source systems at installation id boundaries", () => {
  expect(sourceSystemForInstallation("a".repeat(56))).toBe(`zendesk-${"a".repeat(56)}`);
  const long = sourceSystemForInstallation("a".repeat(57));
  expect(long).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
  expect(long).toHaveLength(64);
  expect(long).toBe(sourceSystemForInstallation("a".repeat(57)));
  expect(long).not.toBe(sourceSystemForInstallation(`${"a".repeat(56)}b`));
});

it("passes resolver outages onward once without disclosing resolver details", async () => {
  const secrets = new MemorySecretStore({
    WORDLESS_API_KEY: `wl_live_test.${"a".repeat(24)}`,
    WORDLESS_SIGNING_SECRET: "s".repeat(40),
    CHOICE_SIGNING_SECRET: "c".repeat(40),
    ZENDESK_KEY_ID: "key-id",
    ZENDESK_KEY_SECRET: "key-secret",
  });
  const resolver = {
    resolve: vi.fn().mockRejectedValue(new EvidenceResolverError("private upstream response")),
  };
  const logger = new MemoryLogger();
  const runtime = new GatewayRuntime(testConfig(), secrets, new MemoryGatewayStore(), resolver, logger);
  const processed = await runtime.process(installation, envelope("money one twice"));
  expect(processed.results).toEqual([
    expect.objectContaining({
      kind: "pass_control",
      handoff: { target: "next", reason: "evidence_unavailable", firstMessageId: "message-123", suggestionId: null, confirmedChoice: null },
    }),
  ]);
  expect(resolver.resolve).toHaveBeenCalledTimes(1);
  expect(logger.entries).toContainEqual(expect.objectContaining({
    event: "evidence_resolution_yielded",
    fields: expect.objectContaining({ error_code: "evidence_resolver_error" }),
  }));
  expect(JSON.stringify({ processed, entries: logger.entries })).not.toContain("private upstream response");
});

it("treats absent active ownership after release as ownership_lost but rejects malformed non-null ownership", async () => {
  const secrets = new MemorySecretStore({
    WORDLESS_API_KEY: `wl_live_test.${"a".repeat(24)}`,
    WORDLESS_SIGNING_SECRET: "s".repeat(40),
    CHOICE_SIGNING_SECRET: "c".repeat(40),
    ZENDESK_KEY_ID: "key-id",
    ZENDESK_KEY_SECRET: "key-secret",
  });
  const request = {
    method: "POST" as const,
    path: `/sc/v2/apps/${installation.appId}/conversations/conversation-123/messages`,
    body: {
      author: { type: "business" as const },
      content: { type: "text" as const, text: "hello", blockChatInput: false as const },
    },
  };
  const resolver = { resolve: vi.fn() } as any;
  const absentFetch = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ conversation: { activeSwitchboardIntegration: null } }), { status: 200 }),
  );
  const absent = new GatewayRuntime(testConfig({ deliveryMode: "zendesk" }), secrets, new MemoryGatewayStore(), resolver, new MemoryLogger(), absentFetch);
  await expect(absent.execute(installation, request, new AbortController().signal)).resolves.toBe("ownership_lost");
  expect(absentFetch).toHaveBeenCalledTimes(1);

  const malformedFetch = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ conversation: { activeSwitchboardIntegration: { id: 42 } } }), { status: 200 }),
  );
  const malformed = new GatewayRuntime(testConfig({ deliveryMode: "zendesk" }), secrets, new MemoryGatewayStore(), resolver, new MemoryLogger(), malformedFetch);
  await expect(malformed.execute(installation, request, new AbortController().signal)).rejects.toThrow(/omitted the active integration/u);
});

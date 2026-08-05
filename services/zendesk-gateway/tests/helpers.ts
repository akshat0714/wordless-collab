import type { GatewayConfig, Installation } from "../src/types.js";

export const installation: Installation = {
  id: "acme",
  appId: "app_1234567890",
  webhookId: "webhook_1234567890",
  switchboardIntegrationId: "switchboard_1234567890",
  underlyingIntegrationId: "underlying_1234567890",
  humanSwitchboardIntegrationId: "human_1234567890",
  zendeskSubdomain: "acme",
  webhookAuth: { mode: "x_api_key", secretRef: "ZENDESK_WEBHOOK_SECRET" },
  choiceSigningSecretRef: "CHOICE_SIGNING_SECRET",
  wordlessApiKeyRef: "WORDLESS_API_KEY",
  wordlessSigningSecretRef: "WORDLESS_SIGNING_SECRET",
  zendeskAuthentication: {
    type: "basic",
    scope: "integration",
    keyIdRef: "ZENDESK_KEY_ID",
    keySecretRef: "ZENDESK_KEY_SECRET",
  },
};

export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    environment: "test",
    host: "127.0.0.1",
    port: 8080,
    storeDriver: "memory",
    databaseUrl: null,
    wordlessBaseUrl: "http://127.0.0.1:8001",
    installations: new Map([[installation.id, installation]]),
    evidenceResolver: { mode: "demo", evidenceJson: [] },
    deliveryMode: "log",
    productMode: "customer_clarify",
    bodyMaxBytes: 262_144,
    webhookClockSkewSeconds: 300,
    processTimeoutMs: 1_000,
    zendeskTimeoutMs: 1_000,
    choiceTtlHours: 23,
    supportedLocalePrefixes: ["en"],
    requireKnownLocale: true,
    outboxPollMs: 10,
    outboxLeaseMs: 100,
    outboxMaxAttempts: 3,
    shutdownGraceMs: 1_000,
    retentionDays: 30,
    cleanupIntervalMs: 60_000,
    ...overrides,
  };
}

export function installationJson(): string {
  return JSON.stringify([installation]);
}

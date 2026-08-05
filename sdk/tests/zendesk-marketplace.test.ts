// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  ZENDESK_MARKETPLACE_WEBHOOK_TRIGGERS,
  ZendeskMarketplaceApiError,
  createZendeskMarketplaceAuthorizationUrl,
  discoverZendeskMarketplaceIntegrationReference,
  exchangeZendeskMarketplaceCode,
  generateZendeskMarketplaceOAuthState,
  getZendeskMarketplaceTokenInfo,
  handleZendeskMarketplaceLifecycleEvent,
  parseZendeskMarketplaceLifecycleWebhook,
  parseZendeskMarketplaceOAuthCallback,
  registerZendeskMarketplaceWebhook,
  verifyZendeskMarketplaceUninstall,
  verifyZendeskWebhookApiKey,
} from "../src/zendesk-marketplace";

const APP_ID = "app-0123456789";
const WEBHOOK_ID = "webhook-0123456789";
const SWITCHBOARD_ID = "switchboard-entry-1";
const INTEGRATION_ID = "underlying-integration-1";
const MARKETPLACE = {
  name: "Wordless",
  organizationId: "organization-1",
  botId: "bot-1",
} as const;

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function headersFrom(call: unknown[]): Headers {
  return new Headers((call[1] as RequestInit).headers);
}

function lifecycleEnvelope(
  type: string,
  options: {
    activeId?: string;
    integrationId?: string;
    creationReason?: string;
    previous?: boolean;
    noActive?: boolean;
  } = {},
): unknown {
  const active = {
    id: options.activeId ?? SWITCHBOARD_ID,
    integrationId: options.integrationId ?? INTEGRATION_ID,
    integrationType: "custom",
  };
  return {
    app: { id: APP_ID },
    webhook: { id: WEBHOOK_ID, version: "v2" },
    events: [
      {
        id: `event-${type.replace(/:/gu, "-")}`,
        type,
        createdAt: "2026-07-30T20:00:00Z",
        payload: {
          conversation: {
            id: "conversation-1",
            ...(options.noActive ? {} : { activeSwitchboardIntegration: active }),
          },
          ...(options.creationReason === undefined
            ? {}
            : { creationReason: options.creationReason }),
          ...(options.previous ? { previousActiveSwitchboardIntegration: active } : {}),
        },
      },
    ],
  };
}

const PARSER_OPTIONS = {
  expectedAppId: APP_ID,
  expectedWebhookId: WEBHOOK_ID,
  switchboardIntegrationId: SWITCHBOARD_ID,
  integrationId: INTEGRATION_ID,
} as const;

describe("Zendesk Marketplace OAuth and installation lifecycle", () => {
  it("creates an authorization URL and verifies the callback state", () => {
    const state = generateZendeskMarketplaceOAuthState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const authorizationUrl = createZendeskMarketplaceAuthorizationUrl({
      clientId: "marketplace-client-id",
      state,
      redirectUri: "https://wordless.example/integrations/zendesk/callback",
    });
    const parsed = new URL(authorizationUrl);
    expect(parsed.origin).toBe("https://oauth-bridge.zendesk.com");
    expect(parsed.pathname).toBe("/sc/oauth/authorize");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      response_type: "code",
      client_id: "marketplace-client-id",
      state,
      redirect_uri: "https://wordless.example/integrations/zendesk/callback",
    });
    expect(parseZendeskMarketplaceOAuthCallback(
      `https://wordless.example/callback?code=one-time-code&state=${state}`,
      { expectedState: state },
    )).toEqual({ code: "one-time-code" });
    expect(() => parseZendeskMarketplaceOAuthCallback(
      "?code=one-time-code&state=attacker-state",
      { expectedState: state },
    )).toThrow(/state verification failed/u);
  });

  it("exchanges the code with every required Marketplace header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      access_token: "installation-access-token",
      token_type: "Bearer",
    }));

    await expect(exchangeZendeskMarketplaceCode({
      code: "one-time-code",
      clientId: "marketplace-client-id",
      clientSecret: "marketplace-client-secret",
      marketplace: MARKETPLACE,
      fetch: fetchMock,
    })).resolves.toEqual({
      accessToken: "installation-access-token",
      tokenType: "Bearer",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth-bridge.zendesk.com/sc/oauth/token");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual({
      grant_type: "authorization_code",
      code: "one-time-code",
      client_id: "marketplace-client-id",
      client_secret: "marketplace-client-secret",
    });
    const headers = headersFrom(fetchMock.mock.calls[0] as unknown[]);
    expect(headers.get("x-zendesk-marketplace-name")).toBe("Wordless");
    expect(headers.get("x-zendesk-marketplace-organization-id")).toBe("organization-1");
    expect(headers.get("x-zendesk-marketplace-bot-id")).toBe("bot-1");
  });

  it("uses tokenInfo to discover the installation app and subdomain", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      app: { id: APP_ID, subdomain: "acme" },
    }));

    await expect(getZendeskMarketplaceTokenInfo({
      accessToken: "installation-access-token",
      marketplace: MARKETPLACE,
      fetch: fetchMock,
    })).resolves.toEqual({ appId: APP_ID, subdomain: "acme" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth-bridge.zendesk.com/sc/v2/tokenInfo");
    expect(headersFrom(fetchMock.mock.calls[0] as unknown[]).get("authorization"))
      .toBe("Bearer installation-access-token");
  });

  it("registers one integrations/me webhook with all required lifecycle triggers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      webhook: { id: WEBHOOK_ID, secret: "generated-webhook-secret" },
    }, 201));

    await expect(registerZendeskMarketplaceWebhook({
      accessToken: "installation-access-token",
      marketplace: MARKETPLACE,
      appId: APP_ID,
      subdomain: "acme",
      target: "https://wordless.example/webhooks/zendesk",
      includeFullUser: false,
      includeFullSource: false,
      fetch: fetchMock,
    })).resolves.toEqual({
      id: WEBHOOK_ID,
      secret: "generated-webhook-secret",
      triggers: ZENDESK_MARKETPLACE_WEBHOOK_TRIGGERS,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://acme.zendesk.com/sc/v2/apps/${APP_ID}/integrations/me/webhooks`,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      target: "https://wordless.example/webhooks/zendesk",
      triggers: ZENDESK_MARKETPLACE_WEBHOOK_TRIGGERS,
      includeFullUser: false,
      includeFullSource: false,
    });
  });

  it("bootstraps the two ids from the issued Marketplace client id", () => {
    const envelope = lifecycleEnvelope("conversation:create", {
      creationReason: "startConversation",
    }) as {
      events: Array<{
        payload: { conversation: { activeSwitchboardIntegration: Record<string, unknown> } };
      }>;
    };
    envelope.events[0]!.payload.conversation.activeSwitchboardIntegration.integrationType =
      "marketplace-client-id";

    expect(discoverZendeskMarketplaceIntegrationReference(envelope, {
      expectedAppId: APP_ID,
      expectedWebhookId: WEBHOOK_ID,
      marketplaceClientId: "marketplace-client-id",
    })).toEqual({
      switchboardIntegrationId: SWITCHBOARD_ID,
      integrationId: INTEGRATION_ID,
      integrationType: "marketplace-client-id",
    });
  });

  it("constant-time checks the generated webhook secret from X-API-Key", () => {
    expect(verifyZendeskWebhookApiKey(
      new Headers({ "X-API-Key": "generated-webhook-secret" }),
      "generated-webhook-secret",
    )).toBe(true);
    expect(verifyZendeskWebhookApiKey(
      { "x-api-key": "attacker-secret" },
      "generated-webhook-secret",
    )).toBe(false);
    expect(verifyZendeskWebhookApiKey({}, "generated-webhook-secret")).toBe(false);
  });

  it("accepts unsigned uninstall input only after tokenInfo confirms revocation", async () => {
    const revokedFetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(verifyZendeskMarketplaceUninstall(
      { appId: APP_ID, integrationId: INTEGRATION_ID },
      {
        expectedInstallation: { appId: APP_ID, integrationId: INTEGRATION_ID },
        accessToken: "revoked-access-token",
        marketplace: MARKETPLACE,
        fetch: revokedFetch,
      },
    )).resolves.toEqual({ verified: true, reason: "token_revoked" });

    const validFetch = vi.fn().mockResolvedValue(jsonResponse({
      app: { id: APP_ID, subdomain: "acme" },
    }));
    await expect(verifyZendeskMarketplaceUninstall(
      { appId: APP_ID, integrationId: INTEGRATION_ID },
      {
        expectedInstallation: { appId: APP_ID, integrationId: INTEGRATION_ID },
        accessToken: "still-valid-token",
        marketplace: MARKETPLACE,
        fetch: validFetch,
      },
    )).resolves.toEqual({ verified: false, reason: "token_still_valid" });

    const unusedFetch = vi.fn();
    await expect(verifyZendeskMarketplaceUninstall(
      { appId: APP_ID, integrationId: "another-integration" },
      {
        expectedInstallation: { appId: APP_ID, integrationId: INTEGRATION_ID },
        accessToken: "irrelevant-token",
        marketplace: MARKETPLACE,
        fetch: unusedFetch,
      },
    )).resolves.toEqual({ verified: false, reason: "installation_mismatch" });
    expect(unusedFetch).not.toHaveBeenCalled();
  });

  it("does not mistake a transient tokenInfo failure for uninstall", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(verifyZendeskMarketplaceUninstall(
      { appId: APP_ID, integrationId: INTEGRATION_ID },
      {
        expectedInstallation: { appId: APP_ID, integrationId: INTEGRATION_ID },
        accessToken: "installation-access-token",
        marketplace: MARKETPLACE,
        fetch: fetchMock,
      },
    )).rejects.toBeInstanceOf(ZendeskMarketplaceApiError);
  });
});

describe("Zendesk Marketplace lifecycle planning", () => {
  it("greets only on startConversation while active, and schedules release", () => {
    const [event] = parseZendeskMarketplaceLifecycleWebhook(
      lifecycleEnvelope("conversation:create", { creationReason: "startConversation" }),
      PARSER_OPTIONS,
    );

    expect(event).toMatchObject({
      kind: "conversation_create",
      creationReason: "startConversation",
      configuredIntegrationActive: true,
      directive: "greet",
      activeSwitchboardIntegration: {
        switchboardIntegrationId: SWITCHBOARD_ID,
        integrationId: INTEGRATION_ID,
      },
      releasePlan: {
        releaseNoLaterThan: "2026-07-31T20:00:00.000Z",
        request: {
          path: `/sc/v2/apps/${APP_ID}/conversations/conversation-1/releaseControl`,
        },
      },
    });
  });

  it("waits for the message event instead of greeting a message-created conversation", () => {
    const [event] = parseZendeskMarketplaceLifecycleWebhook(
      lifecycleEnvelope("conversation:create", { creationReason: "message" }),
      PARSER_OPTIONS,
    );
    expect(event).toMatchObject({ directive: "await_message" });
  });

  it("requires both the Switchboard entry id and underlying integration id", () => {
    const [event] = parseZendeskMarketplaceLifecycleWebhook(
      lifecycleEnvelope("conversation:referral", { integrationId: "different-underlying-id" }),
      PARSER_OPTIONS,
    );
    expect(event).toMatchObject({
      kind: "conversation_referral",
      configuredIntegrationActive: false,
      directive: "none",
      releasePlan: null,
    });
  });

  it("greets on pass-in and cleans up on pass-out or release", () => {
    const [passedIn] = parseZendeskMarketplaceLifecycleWebhook(
      lifecycleEnvelope("switchboard:passControl"),
      PARSER_OPTIONS,
    );
    const [passedOut] = parseZendeskMarketplaceLifecycleWebhook(
      lifecycleEnvelope("switchboard:passControl", {
        activeId: "another-switchboard-entry",
        integrationId: "another-underlying-integration",
        previous: true,
      }),
      PARSER_OPTIONS,
    );
    // Build the previous reference explicitly because the helper mirrors current by default.
    const passOutEnvelope = lifecycleEnvelope("switchboard:passControl", {
      activeId: "another-switchboard-entry",
      integrationId: "another-underlying-integration",
    }) as {
      events: Array<{ payload: Record<string, unknown> }>;
    };
    passOutEnvelope.events[0]!.payload.previousActiveSwitchboardIntegration = {
      id: SWITCHBOARD_ID,
      integrationId: INTEGRATION_ID,
      integrationType: "custom",
    };
    const [actualPassedOut] = parseZendeskMarketplaceLifecycleWebhook(
      passOutEnvelope,
      PARSER_OPTIONS,
    );
    const [released] = parseZendeskMarketplaceLifecycleWebhook(
      lifecycleEnvelope("switchboard:releaseControl", { noActive: true }),
      PARSER_OPTIONS,
    );

    expect(passedIn).toMatchObject({ directive: "greet" });
    expect(passedOut).toMatchObject({ directive: "cleanup" });
    expect(actualPassedOut).toMatchObject({ directive: "cleanup" });
    expect(released).toMatchObject({ directive: "cleanup", releasePlan: null });
  });

  it("dispatches scheduling before the lifecycle action callback", async () => {
    const [event] = parseZendeskMarketplaceLifecycleWebhook(
      lifecycleEnvelope("conversation:create", { creationReason: "startConversation" }),
      PARSER_OPTIONS,
    );
    if (event === undefined) throw new Error("Expected lifecycle event.");
    const order: string[] = [];

    await expect(handleZendeskMarketplaceLifecycleEvent(event, {
      scheduleRelease: () => { order.push("schedule"); },
      greet: () => { order.push("greet"); },
    })).resolves.toBe("greet");
    expect(order).toEqual(["schedule", "greet"]);
  });
});

import {
  createSupportChatbotAdapter,
  createWordlessClient,
} from "@wordless/sdk/server";
import {
  createZendeskConversationsClient,
  createZendeskMessagingAdapter,
  type ZendeskAuthenticatedAccount,
  type ZendeskChoiceStore,
} from "@wordless/sdk/zendesk";
import { verifyZendeskWebhookApiKey } from "@wordless/sdk/zendesk-marketplace";

interface ZendeskHandlerConfiguration {
  readonly zendeskSubdomain: string;
  readonly zendeskAppId: string;
  readonly zendeskWebhookId: string;
  readonly zendeskSwitchboardIntegrationId: string;
  readonly zendeskUnderlyingIntegrationId: string;
  readonly zendeskWebhookSecret: string;
  readonly zendeskKeyId: string;
  readonly zendeskKeySecret: string;
  readonly choiceSigningSecret: string;
  readonly wordlessBaseUrl: string;
  readonly wordlessApiKey: string;
  readonly wordlessSigningSecret: string;
}

interface ZendeskHandlerDependencies {
  /** Resolve only a verified Zendesk user/account link, then load current read-only state. */
  readonly resolveAuthenticatedAccount: (
    zendeskUserId: string,
  ) => Promise<ZendeskAuthenticatedAccount | null>;
  readonly choices: ZendeskChoiceStore;
  /**
   * Execute the callback through a durable inbox/outbox keyed by the Zendesk event id.
   * A webhook retry must never create a duplicate customer message.
   */
  readonly dispatchOnce: (
    zendeskEventId: string,
    operation: () => Promise<void>,
  ) => Promise<void>;
}

/**
 * Framework-neutral request handler. Mount the returned function on an HTTPS POST
 * route and configure a Sunshine Conversations v2 `conversation:message` webhook.
 */
export function createZendeskMessagingHandler(
  configuration: ZendeskHandlerConfiguration,
  dependencies: ZendeskHandlerDependencies,
) {
  const chatbot = createSupportChatbotAdapter({
    client: createWordlessClient({
      baseUrl: configuration.wordlessBaseUrl,
      apiKey: configuration.wordlessApiKey,
      signingSecret: configuration.wordlessSigningSecret,
    }),
    sourceSystem: "zendesk-messaging",
  });
  const adapter = createZendeskMessagingAdapter({
    chatbot,
    expectedAppId: configuration.zendeskAppId,
    expectedWebhookId: configuration.zendeskWebhookId,
    switchboardIntegrationId: configuration.zendeskSwitchboardIntegrationId,
    underlyingIntegrationId: configuration.zendeskUnderlyingIntegrationId,
    choiceSigningSecret: configuration.choiceSigningSecret,
    choiceStore: dependencies.choices,
    resolveAuthenticatedAccount: async (message) =>
      dependencies.resolveAuthenticatedAccount(message.userId),
  });
  const zendesk = createZendeskConversationsClient({
    subdomain: configuration.zendeskSubdomain,
    authentication: {
      type: "basic",
      keyId: configuration.zendeskKeyId,
      keySecret: configuration.zendeskKeySecret,
      scope: "integration",
    },
  });

  return async function handleZendeskWebhook(request: Request): Promise<Response> {
    // Zendesk sends HEAD to check that a conversation-integration domain is reachable.
    if (request.method === "HEAD") return new Response(null, { status: 200 });
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "HEAD, POST" } });
    }
    const rawBody = await request.text();
    if (rawBody.length === 0 || rawBody.length > 1_048_576) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (!verifyZendeskWebhookApiKey(request.headers, configuration.zendeskWebhookSecret)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    let value: unknown;
    try {
      value = JSON.parse(rawBody) as unknown;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const results = await adapter.processWebhook(value);
    for (const result of results) {
      if (result.kind === "ignored") continue;
      await dependencies.dispatchOnce(result.deduplicationKey, async () => {
        await zendesk.execute(result.request);
      });
    }
    return new Response(null, { status: 204 });
  };
}

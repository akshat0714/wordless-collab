// sdk/examples/whatsapp-cloud-handler.ts
import {
  createSupportChatbotAdapter,
  createWordlessClient,
} from "@wordless/sdk/server";
import {
  createWhatsAppCloudAdapter,
  verifyWhatsAppSubscription,
  type WhatsAppAuthenticatedAccount,
  type WhatsAppChoiceStore,
  type WhatsAppInboundMessage,
} from "@wordless/sdk/whatsapp";

interface Config {
  readonly appSecret: string;
  readonly phoneNumberId: string;
  readonly verifyToken: string;
  readonly choiceSigningSecret: string;
  readonly wordlessBaseUrl: string;
  readonly wordlessApiKey: string;
  readonly wordlessSigningSecret: string;
}

interface Dependencies {
  readonly resolveAuthenticatedAccount: (inbound: WhatsAppInboundMessage) => Promise<WhatsAppAuthenticatedAccount | null>;
  readonly choiceStore: WhatsAppChoiceStore;
  readonly sendToWhatsApp: (request: { readonly method: "POST"; readonly path: string; readonly body: unknown }) => Promise<void>;
}

export function createWhatsAppHttpHandlers(config: Config, deps: Dependencies) {
  const chatbot = createSupportChatbotAdapter({
    client: createWordlessClient({ baseUrl: config.wordlessBaseUrl, apiKey: config.wordlessApiKey, signingSecret: config.wordlessSigningSecret }),
    sourceSystem: "whatsapp",
  });
  const adapter = createWhatsAppCloudAdapter({
    chatbot, appSecret: config.appSecret, phoneNumberId: config.phoneNumberId,
    choiceSigningSecret: config.choiceSigningSecret,
    resolveAuthenticatedAccount: deps.resolveAuthenticatedAccount,
    choiceStore: deps.choiceStore, humanHandoff: { enabled: true },
  });

  return {
    // GET /webhooks/whatsapp — Meta subscription handshake.
    verifySubscription(query: { mode: string | null; token: string | null; challenge: string | null }): string {
      return verifyWhatsAppSubscription(query, config.verifyToken);
    },
    // POST /webhooks/whatsapp — deliver the exact raw body and the X-Hub-Signature-256 header.
    async handleWebhook(rawBody: string, signatureHeader: string | null): Promise<void> {
      const results = await adapter.processWebhook(rawBody, signatureHeader);
      for (const result of results) {
        if (result.kind === "post_message") {
          await deps.sendToWhatsApp(result.request); // host claims result.deduplicationKey first for idempotency
        }
        // "continue" → let the host's own bot answer; "handoff" → route to a human inbox; "ignored" → no-op.
      }
    },
  };
}

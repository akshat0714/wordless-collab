// sdk/examples/slack-events-handler.ts
import { createSupportChatbotAdapter, createWordlessClient } from "@wordless/sdk/server";
import {
  createSlackAdapter,
  type SlackAuthenticatedAccount,
  type SlackChoiceStore,
  type SlackInboundMessage,
} from "@wordless/sdk/slack";

interface Config {
  readonly signingSecret: string; readonly choiceSigningSecret: string; readonly selfBotUserId: string;
  readonly wordlessBaseUrl: string; readonly wordlessApiKey: string; readonly wordlessSigningSecret: string;
}
interface Dependencies {
  readonly resolveAuthenticatedAccount: (inbound: SlackInboundMessage) => Promise<SlackAuthenticatedAccount | null>;
  readonly choiceStore: SlackChoiceStore;
  readonly postToSlack: (request: { readonly method: "POST"; readonly path: string; readonly body: unknown }) => Promise<void>;
}

export function createSlackHttpHandlers(config: Config, deps: Dependencies) {
  const chatbot = createSupportChatbotAdapter({
    client: createWordlessClient({ baseUrl: config.wordlessBaseUrl, apiKey: config.wordlessApiKey, signingSecret: config.wordlessSigningSecret }),
    sourceSystem: "slack",
  });
  const adapter = createSlackAdapter({
    chatbot, signingSecret: config.signingSecret, choiceSigningSecret: config.choiceSigningSecret,
    selfBotUserId: config.selfBotUserId, resolveAuthenticatedAccount: deps.resolveAuthenticatedAccount,
    choiceStore: deps.choiceStore, humanHandoff: { enabled: true },
  });
  return {
    // POST /slack/events — deliver the raw body + X-Slack-Signature / X-Slack-Request-Timestamp headers.
    async handleEvent(rawBody: string, headers: { signature: string | null; timestamp: string | null }): Promise<{ challenge?: string }> {
      const outcome = await adapter.processEvent(rawBody, headers);
      if (outcome.kind === "url_verification") return { challenge: outcome.challenge };
      if (outcome.kind === "result" && outcome.result.kind === "post_message") await deps.postToSlack(outcome.result.request);
      return {};
    },
    // POST /slack/interactions — application/x-www-form-urlencoded body with a `payload` field.
    async handleInteraction(rawBody: string, headers: { signature: string | null; timestamp: string | null }): Promise<void> {
      const result = await adapter.processInteraction(rawBody, headers);
      if (result.kind === "post_message") await deps.postToSlack(result.request);
    },
  };
}

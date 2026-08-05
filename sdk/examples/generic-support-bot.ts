import {
  createSupportChatbotAdapter,
  createWordlessClient,
  type WordlessEvidence,
  type WordlessSupportChatTurn,
} from "@wordless/sdk/server";

export interface IncomingSupportMessage {
  readonly id: string;
  readonly customerId: string;
  readonly text: string;
  readonly receivedAt: string;
  readonly showChoices?: boolean;
}

export interface HostChatbot {
  loadReadOnlyEvidence(customerId: string): Promise<readonly WordlessEvidence[]>;
  runNormalBot(message: IncomingSupportMessage): Promise<void>;
  sendMessage(text: string): Promise<void>;
  sendChoices(
    prompt: string,
    choices: readonly { id: string; label: string; reply: string }[],
  ): Promise<void>;
}

export function createMessageHandler(configuration: {
  readonly wordlessBaseUrl: string;
  readonly wordlessApiKey: string;
  readonly wordlessSigningSecret: string;
  readonly sourceSystem: string;
}) {
  const wordless = createSupportChatbotAdapter({
    client: createWordlessClient({
      baseUrl: configuration.wordlessBaseUrl,
      apiKey: configuration.wordlessApiKey,
      signingSecret: configuration.wordlessSigningSecret,
    }),
    sourceSystem: configuration.sourceSystem,
  });

  return async function handleMessage(
    host: HostChatbot,
    message: IncomingSupportMessage,
  ): Promise<WordlessSupportChatTurn> {
    const evidence = await host.loadReadOnlyEvidence(message.customerId);
    const turn = await wordless.processMessage({
      messageId: message.id,
      customerId: message.customerId,
      text: message.text,
      sentAt: message.receivedAt,
      evidence,
      ...(message.showChoices === undefined
        ? {}
        : { showChoices: message.showChoices }),
    });

    if (turn.hostAction === "continue_host_bot") {
      await host.runNormalBot(message);
    } else if (turn.renderMode === "choices") {
      await host.sendChoices(turn.message, turn.choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
        reply: choice.reply,
      })));
    } else {
      await host.sendMessage(turn.message);
    }
    return turn;
  };
}

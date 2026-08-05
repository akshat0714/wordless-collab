import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type {
  ZendeskApiRequest,
  ZendeskChoiceStore,
  ZendeskConversationsClient,
  ZendeskMessagingResult,
  ZendeskPassControlBody,
  ZendeskPendingChoiceSet,
  ZendeskResolvedChoice,
  ZendeskTextMessageBody,
  ZendeskMessagingAdapterOptions,
  ZendeskReleaseControlBody,
} from "@wordless/sdk/zendesk";
import {
  createZendeskConversationsClient,
  createZendeskMessagingAdapter,
  preflightZendeskWebhook,
  ZendeskApiError,
  ZendeskWebhookValidationError,
} from "@wordless/sdk/zendesk";
import { createSupportChatbotAdapter, createWordlessClient } from "@wordless/sdk/server";
import {
  parseZendeskMarketplaceLifecycleWebhook,
  type ZendeskMarketplaceLifecycleEvent,
} from "@wordless/sdk/zendesk-marketplace";

import { safeErrorCode, type Logger } from "./logger.js";
import type { AuthenticatedEvidenceResolver } from "./resolver.js";
import type { SecretStore } from "./secrets.js";
import type { GatewayStore } from "./store.js";
import type { GatewayConfig, Installation } from "./types.js";

class BufferedChoiceStore implements ZendeskChoiceStore {
  readonly pending: ZendeskPendingChoiceSet[] = [];

  constructor(
    private readonly installationId: string,
    private readonly store: GatewayStore,
  ) {}

  async save(value: ZendeskPendingChoiceSet): Promise<void> {
    this.pending.push(value);
  }

  resolve(input: {
    readonly appId: string;
    readonly conversationId: string;
    readonly userId: string;
    readonly payload: string;
    readonly selectionEventId: string;
    readonly selectionReceivedAt: string;
    readonly sourceMessageNonce: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
  }): Promise<ZendeskResolvedChoice | null> {
    return this.store.resolveChoice(this.installationId, input);
  }
}

interface RuntimeParts {
  readonly chatbot: ReturnType<typeof createSupportChatbotAdapter>;
  readonly choiceSigningSecret: string;
  readonly zendeskClient: ZendeskConversationsClient;
  readonly zendeskAuthorization: Readonly<Record<string, string>>;
  readonly zendeskOrigin: string;
}

export function sourceSystemForInstallation(installationId: string): string {
  const direct = `zendesk-${installationId}`;
  if (direct.length <= 64) return direct;
  const digest = createHash("sha256").update(installationId, "utf8").digest("hex").slice(0, 12);
  return `zendesk-${installationId.slice(0, 43)}-${digest}`;
}

export interface ProcessedWebhook {
  readonly results: readonly ZendeskMessagingResult[];
  readonly choices: readonly ZendeskPendingChoiceSet[];
  readonly lifecycle: readonly ZendeskMarketplaceLifecycleEvent[];
}

export class OwnershipCheckError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OwnershipCheckError";
  }
}

export class AmbiguousDeliveryError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Zendesk delivery outcome is ambiguous; automatic retry is disabled.", options);
    this.name = "AmbiguousDeliveryError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function splitWebhookEvents(
  value: unknown,
  installation: Installation,
  maxFutureSkewMs: number,
): readonly {
  envelope: unknown;
  eventId: string;
  eventType: string;
  conversationId: string | null;
  customerActivity: boolean;
  configuredIntegrationActive: boolean;
  eventCreatedAt: string;
}[] {
  const events = preflightZendeskWebhook(value, {
    expectedAppId: installation.appId,
    expectedWebhookId: installation.webhookId,
    switchboardIntegrationId: installation.switchboardIntegrationId,
    underlyingIntegrationId: installation.underlyingIntegrationId,
    maxFutureSkewMs,
  });
  if (!isRecord(value) || !Array.isArray(value.events)) return [];
  const rawEvents: unknown[] = value.events;
  return events.map((event, index) => ({
    envelope: { ...value, events: [rawEvents[index]] },
    eventId: event.eventId,
    eventType: event.eventType,
    conversationId: event.conversationId,
    customerActivity: event.customerActivity,
    configuredIntegrationActive: event.configuredIntegrationActive,
    eventCreatedAt: event.eventCreatedAt,
  }));
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 1_048_576) throw new Error("Zendesk ownership response is too large.");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Zendesk ownership response is invalid.");
  }
}

export class GatewayRuntime {
  private readonly runtimes = new Map<string, Promise<RuntimeParts>>();

  constructor(
    private readonly config: GatewayConfig,
    private readonly secrets: SecretStore,
    private readonly store: GatewayStore,
    private readonly resolver: AuthenticatedEvidenceResolver,
    private readonly logger: Logger,
    private readonly fetchImplementation: typeof fetch = globalThis.fetch,
  ) {}

  private parts(installation: Installation): Promise<RuntimeParts> {
    const existing = this.runtimes.get(installation.id);
    if (existing !== undefined) return existing;
    const building = this.buildParts(installation);
    this.runtimes.set(installation.id, building);
    void building.catch(() => this.runtimes.delete(installation.id));
    return building;
  }

  private async buildParts(installation: Installation): Promise<RuntimeParts> {
    const [apiKey, signingSecret, choiceSigningSecret] = await Promise.all([
      this.secrets.get(installation.wordlessApiKeyRef),
      this.secrets.get(installation.wordlessSigningSecretRef),
      this.secrets.get(installation.choiceSigningSecretRef),
    ]);
    if (Buffer.byteLength(choiceSigningSecret, "utf8") < 32) throw new Error("Choice signing secret is too short.");
    const chatbot = createSupportChatbotAdapter({
      client: createWordlessClient({
        baseUrl: this.config.wordlessBaseUrl,
        allowPrivateHttp: new URL(this.config.wordlessBaseUrl).protocol === "http:",
        apiKey,
        signingSecret,
        timeoutMs: Math.min(this.config.processTimeoutMs, 60_000),
      }),
      sourceSystem: sourceSystemForInstallation(installation.id),
      defaultChannel: "chat",
    });
    const authentication = installation.zendeskAuthentication.type === "basic"
      ? {
          type: "basic" as const,
          scope: "integration" as const,
          keyId: await this.secrets.get(installation.zendeskAuthentication.keyIdRef),
          keySecret: await this.secrets.get(installation.zendeskAuthentication.keySecretRef),
        }
      : {
          type: "bearer" as const,
          scope: "integration" as const,
          token: await this.secrets.get(installation.zendeskAuthentication.tokenRef),
          ...(installation.zendeskAuthentication.marketplace === undefined
            ? {}
            : { marketplace: installation.zendeskAuthentication.marketplace }),
        };
    const zendeskAuthorization: Readonly<Record<string, string>> = authentication.type === "basic"
      ? { authorization: `Basic ${Buffer.from(`${authentication.keyId}:${authentication.keySecret}`, "utf8").toString("base64")}` }
      : {
          authorization: `Bearer ${authentication.token}`,
          ...(authentication.marketplace === undefined ? {} : {
            "x-zendesk-marketplace-name": authentication.marketplace.name,
            "x-zendesk-marketplace-organization-id": authentication.marketplace.organizationId,
            "x-zendesk-marketplace-bot-id": authentication.marketplace.botId,
          }),
        };
    return {
      chatbot,
      choiceSigningSecret,
      zendeskAuthorization,
      zendeskOrigin: `https://${installation.zendeskSubdomain}.zendesk.com`,
      zendeskClient: createZendeskConversationsClient({
        subdomain: installation.zendeskSubdomain,
        authentication,
        timeoutMs: this.config.zendeskTimeoutMs,
        fetch: this.fetchImplementation,
      }),
    };
  }

  async validateSecrets(): Promise<void> {
    if (this.config.evidenceResolver.mode === "http") {
      const resolverSecret = await this.secrets.get(this.config.evidenceResolver.authorizationSecretRef);
      if (Buffer.byteLength(resolverSecret, "utf8") < 32) throw new Error("Evidence resolver secret is too short.");
    }
    await Promise.all([...this.config.installations.values()].map(async (installation) => {
      const webhookSecret = await this.secrets.get(installation.webhookAuth.secretRef);
      if (Buffer.byteLength(webhookSecret, "utf8") < 32) throw new Error("Webhook secret is too short.");
      await this.parts(installation);
    }));
  }

  async process(installation: Installation, value: unknown): Promise<ProcessedWebhook> {
    const parts = await this.parts(installation);
    const results: ZendeskMessagingResult[] = [];
    const choices: ZendeskPendingChoiceSet[] = [];
    const lifecycle: ZendeskMarketplaceLifecycleEvent[] = [];
    for (const item of splitWebhookEvents(
      value,
      installation,
      this.config.webhookClockSkewSeconds * 1_000,
    )) {
      const configuredChoiceTtlMs = this.config.choiceTtlHours * 3_600_000;
      const remainingControlMs = Date.parse(item.eventCreatedAt) + configuredChoiceTtlMs - Date.now();
      const choiceTtlMs = Math.min(configuredChoiceTtlMs, Math.floor(remainingControlMs / 1_000) * 1_000);
      if (item.customerActivity && item.configuredIntegrationActive && choiceTtlMs < 60_000) {
        throw new ZendeskWebhookValidationError("Zendesk event control window has expired.");
      }
      lifecycle.push(...parseZendeskMarketplaceLifecycleWebhook(item.envelope, {
        expectedAppId: installation.appId,
        expectedWebhookId: installation.webhookId,
        switchboardIntegrationId: installation.switchboardIntegrationId,
        integrationId: installation.underlyingIntegrationId,
        releaseAfterMs: this.config.choiceTtlHours * 3_600_000,
      }));
      const choiceStore = new BufferedChoiceStore(installation.id, this.store);
      const adapterOptions: ZendeskMessagingAdapterOptions = {
        chatbot: parts.chatbot,
        expectedAppId: installation.appId,
        expectedWebhookId: installation.webhookId,
        switchboardIntegrationId: installation.switchboardIntegrationId,
        underlyingIntegrationId: installation.underlyingIntegrationId,
        humanSwitchboardIntegrationId: installation.humanSwitchboardIntegrationId,
        choiceSigningSecret: parts.choiceSigningSecret,
        choiceTtlMs: Math.max(60_000, choiceTtlMs),
        choiceStore,
        resolveAuthenticatedAccount: (incoming) => this.resolver.resolve(installation, incoming),
        accountResolutionFailureMode: "pass_control",
        onAccountResolutionError: (error) => this.logger.log("warn", "evidence_resolution_yielded", {
          installation_id: installation.id,
          error_code: safeErrorCode(error),
        }),
        onFeedbackError: (error) => this.logger.log("warn", "feedback_recording_yielded", {
          installation_id: installation.id,
          error_code: safeErrorCode(error),
        }),
        onWordlessError: (error) => this.logger.log("warn", "wordless_request_yielded", {
          installation_id: installation.id,
          error_code: error.name,
        }),
      };
      const adapter = createZendeskMessagingAdapter(adapterOptions);
      results.push(...await adapter.processWebhook(item.envelope));
      choices.push(...choiceStore.pending);
    }
    return { results, choices, lifecycle };
  }

  async execute(
    installation: Installation,
    request: ZendeskApiRequest<ZendeskTextMessageBody | ZendeskPassControlBody | ZendeskReleaseControlBody>,
    signal: AbortSignal,
  ): Promise<"delivered" | "ownership_lost"> {
    const parts = await this.parts(installation);
    const match = /^(\/sc\/v2\/apps\/[^/]+\/conversations\/[^/]+)\/(?:messages|passControl|releaseControl)$/u.exec(request.path);
    if (match?.[1] === undefined) throw new Error("Outbound Zendesk path cannot be ownership-checked.");
    let response: Response;
    let value: unknown;
    try {
      const ownershipSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.zendeskTimeoutMs)]);
      response = await this.fetchImplementation(`${parts.zendeskOrigin}${match[1]}`, {
        method: "GET",
        redirect: "error",
        headers: parts.zendeskAuthorization,
        signal: ownershipSignal,
      });
      if (!response.ok) throw new Error(`Zendesk ownership check returned HTTP ${response.status}.`);
      value = await boundedJson(response);
    } catch (error) {
      throw new OwnershipCheckError("Zendesk ownership could not be verified.", { cause: error });
    }
    const root = isRecord(value) && isRecord(value.conversation) ? value.conversation : value;
    if (!isRecord(root)) throw new OwnershipCheckError("Zendesk ownership response is invalid.");
    if (root.activeSwitchboardIntegration === null || root.activeSwitchboardIntegration === undefined) {
      return "ownership_lost";
    }
    if (!isRecord(root.activeSwitchboardIntegration) ||
        typeof root.activeSwitchboardIntegration.id !== "string" ||
        typeof root.activeSwitchboardIntegration.integrationId !== "string") {
      throw new OwnershipCheckError("Zendesk ownership response omitted the active integration.");
    }
    if (
      root.activeSwitchboardIntegration.id !== installation.switchboardIntegrationId ||
      root.activeSwitchboardIntegration.integrationId !== installation.underlyingIntegrationId
    ) return "ownership_lost";
    try {
      await parts.zendeskClient.execute(request, { signal });
    } catch (error) {
      if (error instanceof ZendeskApiError && error.status < 500 && error.status !== 408) throw error;
      throw new AmbiguousDeliveryError({ cause: error });
    }
    return "delivered";
  }
}

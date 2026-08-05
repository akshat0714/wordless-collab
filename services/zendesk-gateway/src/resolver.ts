import { createHmac } from "node:crypto";

import type {
  ZendeskAuthenticatedAccount,
  ZendeskInboundMessage,
} from "@wordless/sdk/zendesk";
import type { WordlessEvidence, WordlessJsonValue } from "@wordless/sdk/server";

import type { GatewayConfig, Installation } from "./types.js";
import type { SecretStore } from "./secrets.js";
import type { Logger } from "./logger.js";

export interface AuthenticatedEvidenceResolver {
  resolve(installation: Installation, incoming: ZendeskInboundMessage): Promise<ZendeskAuthenticatedAccount | null>;
}

export class EvidenceResolverError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EvidenceResolverError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function boundedJson(response: Response, maximumBytes = 1_048_576): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new EvidenceResolverError("Evidence resolver response is too large.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new EvidenceResolverError("Evidence resolver response is too large.");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new EvidenceResolverError("Evidence resolver returned invalid JSON.");
  }
}

interface VerifiedZendeskIdentity {
  readonly type: "external_id" | "user_id";
  readonly value: string;
}

function parseResolverResponse(
  value: unknown,
  installationId: string,
  identity: VerifiedZendeskIdentity,
): ZendeskAuthenticatedAccount | null {
  const object = isRecord(value) ? value : null;
  if (object === null || typeof object.authenticated !== "boolean") {
    throw new EvidenceResolverError("Evidence resolver response is invalid.");
  }
  if (object.authenticated === false) return null;
  if (
    object.installation_id !== installationId ||
    !isRecord(object.zendesk_identity) || object.zendesk_identity.type !== identity.type ||
    object.zendesk_identity.value !== identity.value ||
    typeof object.customer_id !== "string" || object.customer_id.length === 0 || object.customer_id.length > 512 ||
    typeof object.observed_at !== "string" || !Number.isFinite(Date.parse(object.observed_at)) ||
    !Array.isArray(object.evidence) || object.evidence.length > 100 ||
    (object.metadata !== undefined && !isRecord(object.metadata))
  ) {
    throw new EvidenceResolverError("Authenticated evidence response is invalid.");
  }
  return {
    authenticated: true,
    customerId: object.customer_id,
    observedAt: object.observed_at,
    evidence: object.evidence as readonly WordlessEvidence[],
    ...(object.metadata === undefined
      ? {}
      : { metadata: object.metadata as Readonly<Record<string, WordlessJsonValue>> }),
  };
}

export class HttpEvidenceResolver implements AuthenticatedEvidenceResolver {
  constructor(
    private readonly options: Extract<GatewayConfig["evidenceResolver"], { mode: "http" }>,
    private readonly zendeskTimeoutMs: number,
    private readonly secrets: SecretStore,
    private readonly fetchImplementation: typeof fetch = globalThis.fetch,
    private readonly localePolicy: {
      readonly supportedPrefixes: readonly string[];
      readonly requireKnown: boolean;
    } = { supportedPrefixes: ["en"], requireKnown: true },
    private readonly logger?: Logger,
  ) {}

  private localeAllowed(user: Record<string, unknown>, installationId: string): boolean {
    const profile = isRecord(user.profile) ? user.profile : null;
    const locale = typeof profile?.locale === "string" && profile.locale.trim().length > 0
      ? profile.locale.trim().toLowerCase().replace(/_/gu, "-")
      : null;
    if (locale === null) {
      if (!this.localePolicy.requireKnown) return true;
      this.logger?.log("info", "evidence_resolution_skipped", {
        installation_id: installationId,
        error_code: "missing_locale",
      });
      return false;
    }
    const supported = this.localePolicy.supportedPrefixes.some((prefix) =>
      locale === prefix || locale.startsWith(`${prefix}-`));
    if (!supported) {
      this.logger?.log("info", "evidence_resolution_skipped", {
        installation_id: installationId,
        error_code: "unsupported_locale",
      });
    }
    return supported;
  }

  private async zendeskAuthorization(installation: Installation): Promise<Readonly<Record<string, string>>> {
    if (installation.zendeskAuthentication.type === "basic") {
      const [keyId, keySecret] = await Promise.all([
        this.secrets.get(installation.zendeskAuthentication.keyIdRef),
        this.secrets.get(installation.zendeskAuthentication.keySecretRef),
      ]);
      return { authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`, "utf8").toString("base64")}` };
    }
    const token = await this.secrets.get(installation.zendeskAuthentication.tokenRef);
    return {
      authorization: `Bearer ${token}`,
      ...(installation.zendeskAuthentication.marketplace === undefined ? {} : {
        "x-zendesk-marketplace-name": installation.zendeskAuthentication.marketplace.name,
        "x-zendesk-marketplace-organization-id": installation.zendeskAuthentication.marketplace.organizationId,
        "x-zendesk-marketplace-bot-id": installation.zendeskAuthentication.marketplace.botId,
      }),
    };
  }

  private async verifyZendeskIdentity(
    installation: Installation,
    incoming: ZendeskInboundMessage,
  ): Promise<VerifiedZendeskIdentity | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.zendeskTimeoutMs);
    try {
      const response = await this.fetchImplementation(
        `https://${installation.zendeskSubdomain}.zendesk.com/sc/v2/apps/${encodeURIComponent(installation.appId)}/users/${encodeURIComponent(incoming.userId)}`,
        {
          method: "GET",
          redirect: "error",
          headers: await this.zendeskAuthorization(installation),
          signal: controller.signal,
        },
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new EvidenceResolverError(`Zendesk identity check returned HTTP ${response.status}.`);
      const value = await boundedJson(response);
      const user = isRecord(value) && isRecord(value.user) ? value.user : value;
      if (!isRecord(user) || user.id !== incoming.userId || user.authenticated !== true) return null;
      if (!this.localeAllowed(user, installation.id)) return null;
      if (typeof user.externalId === "string" && user.externalId.length > 0 && user.externalId.length <= 512) {
        return { type: "external_id", value: user.externalId };
      }
      return { type: "user_id", value: incoming.userId };
    } catch (error) {
      if (error instanceof EvidenceResolverError) throw error;
      throw new EvidenceResolverError("Zendesk identity verification failed.", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async resolve(installation: Installation, incoming: ZendeskInboundMessage): Promise<ZendeskAuthenticatedAccount | null> {
    const identity = await this.verifyZendeskIdentity(installation, incoming);
    if (identity === null) return null;
    const body = JSON.stringify({
      schema_version: 1,
      installation_id: installation.id,
      zendesk_app_id: incoming.appId,
      zendesk_identity: identity,
      zendesk_conversation_id: incoming.conversationId,
      zendesk_message_id: incoming.messageId,
      message_received_at: incoming.receivedAt,
    });
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const secret = await this.secrets.get(this.options.authorizationSecretRef);
    if (Buffer.byteLength(secret, "utf8") < 32) throw new EvidenceResolverError("Evidence resolver secret is too short.");
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImplementation(this.options.url, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-wordless-resolver-timestamp": timestamp,
          "x-wordless-resolver-signature": `v1=${signature}`,
        },
        body,
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new EvidenceResolverError(`Evidence resolver returned HTTP ${response.status}.`);
      return parseResolverResponse(await boundedJson(response), installation.id, identity);
    } catch (error) {
      if (error instanceof EvidenceResolverError) throw error;
      throw new EvidenceResolverError("Evidence resolver request failed.", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Explicit development-only resolver. It never reads real account systems. */
export class DemoEvidenceResolver implements AuthenticatedEvidenceResolver {
  constructor(private readonly evidence: unknown) {
    if (!Array.isArray(evidence)) throw new EvidenceResolverError("DEMO_EVIDENCE_JSON must be an array.");
  }

  async resolve(_installation: Installation, incoming: ZendeskInboundMessage): Promise<ZendeskAuthenticatedAccount> {
    const received = Date.parse(incoming.receivedAt);
    return {
      authenticated: true,
      customerId: `demo:${incoming.userId}`,
      observedAt: new Date(Math.max(Date.now(), received)).toISOString(),
      evidence: this.evidence as readonly WordlessEvidence[],
      metadata: { resolver_mode: "synthetic_demo" },
    };
  }
}

export function createEvidenceResolver(config: GatewayConfig, secrets: SecretStore, logger?: Logger): AuthenticatedEvidenceResolver {
  return config.evidenceResolver.mode === "http"
    ? new HttpEvidenceResolver(
        config.evidenceResolver,
        config.zendeskTimeoutMs,
        secrets,
        globalThis.fetch,
        {
          supportedPrefixes: config.supportedLocalePrefixes,
          requireKnown: config.requireKnownLocale,
        },
        logger,
      )
    : new DemoEvidenceResolver(config.evidenceResolver.evidenceJson);
}

import { Buffer } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  createZendeskControlReleasePlan,
  ZendeskIntegrationError,
  ZendeskWebhookValidationError,
  type ZendeskControlReleasePlan,
} from "./zendesk.js";

const OAUTH_ORIGIN = "https://oauth-bridge.zendesk.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_WEBHOOK_EVENTS = 100;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export const ZENDESK_MARKETPLACE_WEBHOOK_TRIGGERS = Object.freeze([
  "conversation:message",
  "conversation:create",
  "conversation:referral",
  "switchboard:passControl",
  "switchboard:releaseControl",
] as const);

export type ZendeskMarketplaceWebhookTrigger =
  (typeof ZENDESK_MARKETPLACE_WEBHOOK_TRIGGERS)[number];

export interface ZendeskMarketplaceIdentity {
  readonly name: string;
  readonly organizationId: string;
  readonly botId: string;
}

export class ZendeskMarketplaceApiError extends ZendeskIntegrationError {
  readonly operation: string;
  readonly status: number;

  constructor(operation: string, status: number) {
    super(`Zendesk Marketplace ${operation} returned HTTP ${status}.`);
    this.name = "ZendeskMarketplaceApiError";
    this.operation = operation;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new ZendeskIntegrationError(`${label} is invalid.`);
  }
  return value;
}

function webhookIdentifier(value: unknown, label: string): string {
  try {
    return identifier(value, label);
  } catch {
    throw new ZendeskWebhookValidationError(`${label} is invalid.`);
  }
}

function opaque(value: unknown, label: string, maximum = 8_192): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\r\n]/u.test(value)
  ) {
    throw new ZendeskIntegrationError(`${label} is invalid.`);
  }
  return value;
}

function oauthState(value: unknown, label: string): string {
  const result = opaque(value, label, 2_048);
  if (Buffer.byteLength(result, "utf8") < 22) {
    throw new ZendeskIntegrationError(`${label} must contain at least 128 bits of entropy.`);
  }
  return result;
}

function headerField(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\r\n]/u.test(value)
  ) {
    throw new ZendeskIntegrationError(`${label} is invalid.`);
  }
  return value;
}

function marketplaceHeaders(
  marketplace: ZendeskMarketplaceIdentity,
): Readonly<Record<string, string>> {
  if (!isRecord(marketplace)) {
    throw new ZendeskIntegrationError("Zendesk Marketplace identity is invalid.");
  }
  return Object.freeze({
    "X-Zendesk-Marketplace-Name": headerField(
      marketplace.name,
      "Zendesk Marketplace name",
    ),
    "X-Zendesk-Marketplace-Organization-Id": headerField(
      marketplace.organizationId,
      "Zendesk Marketplace organization id",
    ),
    "X-Zendesk-Marketplace-Bot-Id": headerField(
      marketplace.botId,
      "Zendesk Marketplace bot id",
    ),
  });
}

function timeout(value: number | undefined): number {
  const result = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(result) || result < 100 || result > 60_000) {
    throw new ZendeskIntegrationError("Zendesk timeoutMs must be between 100 and 60000.");
  }
  return result;
}

async function fetchZendesk(
  operation: string,
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetchImplementation(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    throw new ZendeskIntegrationError(`Zendesk Marketplace ${operation} failed.`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function responseObject(response: Response, operation: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json() as unknown;
  } catch (error) {
    throw new ZendeskIntegrationError(
      `Zendesk Marketplace ${operation} returned invalid JSON.`,
      { cause: error },
    );
  }
  if (!isRecord(value)) {
    throw new ZendeskIntegrationError(
      `Zendesk Marketplace ${operation} returned an invalid response.`,
    );
  }
  return value;
}

function assertOk(response: Response, operation: string): void {
  if (!response.ok) throw new ZendeskMarketplaceApiError(operation, response.status);
}

/** Generate opaque state. Persist it in the host's short-lived server session until callback. */
export function generateZendeskMarketplaceOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export interface ZendeskMarketplaceAuthorizationOptions {
  readonly clientId: string;
  readonly state: string;
  /** Must exactly match a redirect URI registered with Zendesk when supplied. */
  readonly redirectUri?: string;
}

function redirectUri(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ZendeskIntegrationError("Zendesk OAuth redirectUri is invalid.", { cause: error });
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ZendeskIntegrationError("Zendesk OAuth redirectUri is invalid.");
  }
  return parsed.toString();
}

export function createZendeskMarketplaceAuthorizationUrl(
  options: ZendeskMarketplaceAuthorizationOptions,
): string {
  if (!isRecord(options)) {
    throw new ZendeskIntegrationError("Zendesk OAuth authorization options are invalid.");
  }
  const url = new URL("/sc/oauth/authorize", OAUTH_ORIGIN);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opaque(options.clientId, "Zendesk OAuth client id", 512));
  url.searchParams.set("state", oauthState(options.state, "Zendesk OAuth state"));
  if (options.redirectUri !== undefined) {
    url.searchParams.set("redirect_uri", redirectUri(options.redirectUri));
  }
  return url.toString();
}

export interface ZendeskMarketplaceOAuthCallbackOptions {
  readonly expectedState: string;
}

export interface ZendeskMarketplaceOAuthCallback {
  readonly code: string;
}

function callbackSearchParams(value: string | URL | URLSearchParams): URLSearchParams {
  if (value instanceof URLSearchParams) return value;
  if (value instanceof URL) return value.searchParams;
  if (typeof value !== "string") {
    throw new ZendeskIntegrationError("Zendesk OAuth callback is invalid.");
  }
  try {
    return new URL(value).searchParams;
  } catch {
    return new URLSearchParams(value.startsWith("?") ? value.slice(1) : value);
  }
}

function stateMatches(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes);
}

/** Parse an OAuth callback and constant-time verify state before exposing the code. */
export function parseZendeskMarketplaceOAuthCallback(
  callback: string | URL | URLSearchParams,
  options: ZendeskMarketplaceOAuthCallbackOptions,
): ZendeskMarketplaceOAuthCallback {
  if (!isRecord(options)) {
    throw new ZendeskIntegrationError("Zendesk OAuth callback options are invalid.");
  }
  const expectedState = oauthState(options.expectedState, "Expected Zendesk OAuth state");
  const parameters = callbackSearchParams(callback);
  const receivedStates = parameters.getAll("state");
  if (
    receivedStates.length !== 1 ||
    receivedStates[0] === undefined ||
    !stateMatches(receivedStates[0], expectedState)
  ) {
    throw new ZendeskIntegrationError("Zendesk OAuth state verification failed.");
  }
  const oauthError = parameters.get("error");
  if (oauthError !== null) {
    throw new ZendeskIntegrationError("Zendesk OAuth authorization was not granted.");
  }
  const codes = parameters.getAll("code");
  if (codes.length !== 1 || codes[0] === undefined) {
    throw new ZendeskIntegrationError("Zendesk OAuth callback code is missing or duplicated.");
  }
  return Object.freeze({
    code: opaque(codes[0], "Zendesk OAuth authorization code"),
  });
}

interface ZendeskMarketplaceRequestOptions {
  readonly marketplace: ZendeskMarketplaceIdentity;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export interface ZendeskMarketplaceCodeExchangeOptions
  extends ZendeskMarketplaceRequestOptions {
  readonly code: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface ZendeskMarketplaceOAuthToken {
  readonly accessToken: string;
  readonly tokenType: "Bearer";
}

/** Exchange once, then let the host persist the returned token in its secret store. */
export async function exchangeZendeskMarketplaceCode(
  options: ZendeskMarketplaceCodeExchangeOptions,
): Promise<ZendeskMarketplaceOAuthToken> {
  if (!isRecord(options)) {
    throw new ZendeskIntegrationError("Zendesk OAuth code exchange options are invalid.");
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new ZendeskIntegrationError("A fetch implementation is required.");
  }
  const response = await fetchZendesk(
    "OAuth code exchange",
    fetchImplementation,
    `${OAUTH_ORIGIN}/sc/oauth/token`,
    {
      method: "POST",
      headers: {
        ...marketplaceHeaders(options.marketplace),
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: opaque(options.code, "Zendesk OAuth authorization code"),
        client_id: opaque(options.clientId, "Zendesk OAuth client id", 512),
        client_secret: opaque(options.clientSecret, "Zendesk OAuth client secret"),
      }),
    },
    timeout(options.timeoutMs),
    options.signal,
  );
  assertOk(response, "OAuth code exchange");
  const value = await responseObject(response, "OAuth code exchange");
  const accessToken = opaque(value.access_token, "Zendesk OAuth access token", 32_768);
  if (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer") {
    throw new ZendeskIntegrationError("Zendesk OAuth token type is invalid.");
  }
  return Object.freeze({ accessToken, tokenType: "Bearer" as const });
}

export interface ZendeskMarketplaceTokenInfoOptions
  extends ZendeskMarketplaceRequestOptions {
  readonly accessToken: string;
}

export interface ZendeskMarketplaceTokenInfo {
  readonly appId: string;
  readonly subdomain: string;
}

export async function getZendeskMarketplaceTokenInfo(
  options: ZendeskMarketplaceTokenInfoOptions,
): Promise<ZendeskMarketplaceTokenInfo> {
  if (!isRecord(options)) {
    throw new ZendeskIntegrationError("Zendesk tokenInfo options are invalid.");
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new ZendeskIntegrationError("A fetch implementation is required.");
  }
  const response = await fetchZendesk(
    "tokenInfo",
    fetchImplementation,
    `${OAUTH_ORIGIN}/sc/v2/tokenInfo`,
    {
      method: "GET",
      headers: {
        ...marketplaceHeaders(options.marketplace),
        accept: "application/json",
        authorization: `Bearer ${opaque(options.accessToken, "Zendesk OAuth access token", 32_768)}`,
      },
    },
    timeout(options.timeoutMs),
    options.signal,
  );
  assertOk(response, "tokenInfo");
  const value = await responseObject(response, "tokenInfo");
  if (!isRecord(value.app)) {
    throw new ZendeskIntegrationError("Zendesk tokenInfo app is invalid.");
  }
  const appId = identifier(value.app.id, "Zendesk tokenInfo app id");
  if (typeof value.app.subdomain !== "string" || !SUBDOMAIN_PATTERN.test(value.app.subdomain)) {
    throw new ZendeskIntegrationError("Zendesk tokenInfo subdomain is invalid.");
  }
  return Object.freeze({ appId, subdomain: value.app.subdomain });
}

export interface ZendeskMarketplaceWebhookRegistrationOptions
  extends ZendeskMarketplaceRequestOptions {
  readonly accessToken: string;
  readonly appId: string;
  readonly subdomain: string;
  readonly target: string;
  readonly includeFullUser?: boolean;
  readonly includeFullSource?: boolean;
}

export interface ZendeskMarketplaceWebhookRegistration {
  readonly id: string;
  /** Persist encrypted; Zendesk sends this value in `X-API-Key`. */
  readonly secret: string;
  readonly triggers: readonly ZendeskMarketplaceWebhookTrigger[];
}

function webhookTarget(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ZendeskIntegrationError("Zendesk webhook target is invalid.", { cause: error });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ZendeskIntegrationError("Zendesk webhook target must be an HTTPS URL.");
  }
  return parsed.toString();
}

/** Register the one recommended Marketplace webhook through `integrations/me`. */
export async function registerZendeskMarketplaceWebhook(
  options: ZendeskMarketplaceWebhookRegistrationOptions,
): Promise<ZendeskMarketplaceWebhookRegistration> {
  if (!isRecord(options) || !SUBDOMAIN_PATTERN.test(options.subdomain)) {
    throw new ZendeskIntegrationError("Zendesk webhook registration options are invalid.");
  }
  if (
    (options.includeFullUser !== undefined && typeof options.includeFullUser !== "boolean") ||
    (options.includeFullSource !== undefined && typeof options.includeFullSource !== "boolean")
  ) {
    throw new ZendeskIntegrationError("Zendesk webhook inclusion options are invalid.");
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new ZendeskIntegrationError("A fetch implementation is required.");
  }
  const appId = identifier(options.appId, "Zendesk app id");
  const response = await fetchZendesk(
    "webhook registration",
    fetchImplementation,
    `https://${options.subdomain}.zendesk.com/sc/v2/apps/${encodeURIComponent(appId)}/integrations/me/webhooks`,
    {
      method: "POST",
      headers: {
        ...marketplaceHeaders(options.marketplace),
        accept: "application/json",
        authorization: `Bearer ${opaque(options.accessToken, "Zendesk OAuth access token", 32_768)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        target: webhookTarget(options.target),
        triggers: ZENDESK_MARKETPLACE_WEBHOOK_TRIGGERS,
        ...(options.includeFullUser === undefined
          ? {}
          : { includeFullUser: options.includeFullUser }),
        ...(options.includeFullSource === undefined
          ? {}
          : { includeFullSource: options.includeFullSource }),
      }),
    },
    timeout(options.timeoutMs),
    options.signal,
  );
  assertOk(response, "webhook registration");
  const outer = await responseObject(response, "webhook registration");
  const value = isRecord(outer.webhook) ? outer.webhook : outer;
  return Object.freeze({
    id: identifier(value.id, "Zendesk webhook id"),
    secret: opaque(value.secret, "Zendesk webhook secret", 32_768),
    triggers: ZENDESK_MARKETPLACE_WEBHOOK_TRIGGERS,
  });
}

export type ZendeskWebhookHeaders =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>;

function webhookApiKey(headers: ZendeskWebhookHeaders): string | null {
  if (headers instanceof Headers) return headers.get("x-api-key");
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "x-api-key") continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.length === 1) return value[0] ?? null;
    return null;
  }
  return null;
}

/** Constant-time verification for the secret Zendesk sends in `X-API-Key`. */
export function verifyZendeskWebhookApiKey(
  headers: ZendeskWebhookHeaders,
  expectedSecret: string,
): boolean {
  const received = webhookApiKey(headers);
  if (received === null || typeof expectedSecret !== "string" || expectedSecret.length === 0) {
    return false;
  }
  const receivedBytes = Buffer.from(received, "utf8");
  const expectedBytes = Buffer.from(expectedSecret, "utf8");
  return receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes);
}

export interface ZendeskMarketplaceUninstallInstallation {
  readonly appId: string;
  /** The underlying integration id (`activeSwitchboardIntegration.integrationId`). */
  readonly integrationId: string;
}

export interface ZendeskMarketplaceUninstallVerificationOptions
  extends ZendeskMarketplaceTokenInfoOptions {
  readonly expectedInstallation: ZendeskMarketplaceUninstallInstallation;
}

export type ZendeskMarketplaceUninstallVerification =
  | { readonly verified: true; readonly reason: "token_revoked" }
  | {
      readonly verified: false;
      readonly reason: "installation_mismatch" | "token_still_valid";
    };

/**
 * Zendesk uninstall callbacks are unsigned. Accept one only after its ids match
 * stored installation metadata and `tokenInfo` confirms that token revocation occurred.
 */
export async function verifyZendeskMarketplaceUninstall(
  payload: unknown,
  options: ZendeskMarketplaceUninstallVerificationOptions,
): Promise<ZendeskMarketplaceUninstallVerification> {
  if (!isRecord(payload) || !isRecord(options) || !isRecord(options.expectedInstallation)) {
    throw new ZendeskWebhookValidationError("Zendesk uninstall callback is invalid.");
  }
  const appId = webhookIdentifier(payload.appId, "Zendesk uninstall app id");
  const integrationId = webhookIdentifier(
    payload.integrationId,
    "Zendesk uninstall integration id",
  );
  const expectedAppId = identifier(options.expectedInstallation.appId, "Expected Zendesk app id");
  const expectedIntegrationId = identifier(
    options.expectedInstallation.integrationId,
    "Expected Zendesk underlying integration id",
  );
  if (appId !== expectedAppId || integrationId !== expectedIntegrationId) {
    return Object.freeze({ verified: false as const, reason: "installation_mismatch" as const });
  }
  try {
    await getZendeskMarketplaceTokenInfo(options);
    return Object.freeze({ verified: false as const, reason: "token_still_valid" as const });
  } catch (error) {
    if (
      error instanceof ZendeskMarketplaceApiError &&
      (error.status === 401 || error.status === 403)
    ) {
      return Object.freeze({ verified: true as const, reason: "token_revoked" as const });
    }
    throw error;
  }
}

export interface ZendeskSwitchboardIntegrationReference {
  /** `activeSwitchboardIntegration.id`: the Switchboard entry id. */
  readonly switchboardIntegrationId: string;
  /** `activeSwitchboardIntegration.integrationId`: the underlying integration id. */
  readonly integrationId: string;
  readonly integrationType: string | null;
}

interface ZendeskMarketplaceLifecycleBase {
  readonly appId: string;
  readonly webhookId: string;
  readonly eventId: string;
  readonly eventCreatedAt: string;
  readonly conversationId: string;
  readonly activeSwitchboardIntegration: ZendeskSwitchboardIntegrationReference | null;
  readonly previousActiveSwitchboardIntegration: ZendeskSwitchboardIntegrationReference | null;
  readonly configuredIntegrationActive: boolean;
  readonly directive: ZendeskMarketplaceLifecycleDirective;
  /** Persist the earliest deadline seen for a conversation; never extend an older lease. */
  readonly releasePlan: ZendeskControlReleasePlan | null;
}

export type ZendeskMarketplaceLifecycleDirective =
  | "greet"
  | "await_message"
  | "inspect_proactive_campaign"
  | "cleanup"
  | "none";

export interface ZendeskConversationCreateLifecycleEvent
  extends ZendeskMarketplaceLifecycleBase {
  readonly kind: "conversation_create";
  readonly creationReason: string;
}

export interface ZendeskConversationReferralLifecycleEvent
  extends ZendeskMarketplaceLifecycleBase {
  readonly kind: "conversation_referral";
}

export interface ZendeskSwitchboardPassControlLifecycleEvent
  extends ZendeskMarketplaceLifecycleBase {
  readonly kind: "switchboard_pass_control";
}

export interface ZendeskSwitchboardReleaseControlLifecycleEvent
  extends ZendeskMarketplaceLifecycleBase {
  readonly kind: "switchboard_release_control";
}

export interface ZendeskIgnoredLifecycleEvent {
  readonly kind: "ignored";
  readonly eventId: string;
  readonly eventCreatedAt: string;
  readonly eventType: string;
  readonly directive: "none";
}

export type ZendeskMarketplaceLifecycleEvent =
  | ZendeskConversationCreateLifecycleEvent
  | ZendeskConversationReferralLifecycleEvent
  | ZendeskSwitchboardPassControlLifecycleEvent
  | ZendeskSwitchboardReleaseControlLifecycleEvent
  | ZendeskIgnoredLifecycleEvent;

export interface ZendeskMarketplaceLifecycleParserOptions {
  readonly expectedAppId: string;
  readonly expectedWebhookId: string;
  /** Expected `activeSwitchboardIntegration.id`. */
  readonly switchboardIntegrationId: string;
  /** Expected `activeSwitchboardIntegration.integrationId`. */
  readonly integrationId: string;
  /** Defaults to 24 hours; may only shorten the maximum control lease. */
  readonly releaseAfterMs?: number;
}

function eventTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value)) ||
    !/T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value)
  ) {
    throw new ZendeskWebhookValidationError("Zendesk lifecycle event timestamp is invalid.");
  }
  return value;
}

function integrationReference(
  value: unknown,
  label: string,
): ZendeskSwitchboardIntegrationReference | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new ZendeskWebhookValidationError(`${label} is invalid.`);
  }
  if (
    value.integrationType !== undefined &&
    (typeof value.integrationType !== "string" ||
      value.integrationType.length === 0 ||
      value.integrationType.length > 512 ||
      /[\r\n]/u.test(value.integrationType))
  ) {
    throw new ZendeskWebhookValidationError(`${label} integrationType is invalid.`);
  }
  return Object.freeze({
    switchboardIntegrationId: webhookIdentifier(value.id, `${label} id`),
    integrationId: webhookIdentifier(value.integrationId, `${label} integrationId`),
    integrationType: typeof value.integrationType === "string"
      ? value.integrationType
      : null,
  });
}

export interface ZendeskMarketplaceIntegrationDiscoveryOptions {
  readonly expectedAppId: string;
  readonly expectedWebhookId: string;
  /** Zendesk-issued Marketplace OAuth client id. */
  readonly marketplaceClientId: string;
}

/**
 * Bootstrap the two installation ids from an authenticated webhook where
 * `integrationType` identifies this Marketplace bot by its issued client id.
 */
export function discoverZendeskMarketplaceIntegrationReference(
  value: unknown,
  options: ZendeskMarketplaceIntegrationDiscoveryOptions,
): ZendeskSwitchboardIntegrationReference | null {
  if (!isRecord(options)) {
    throw new ZendeskIntegrationError("Zendesk integration discovery options are invalid.");
  }
  const expectedAppId = identifier(options.expectedAppId, "Expected Zendesk app id");
  const expectedWebhookId = identifier(
    options.expectedWebhookId,
    "Expected Zendesk webhook id",
  );
  const marketplaceClientId = opaque(
    options.marketplaceClientId,
    "Zendesk Marketplace client id",
    512,
  );
  if (!isRecord(value) || !isRecord(value.app) || !isRecord(value.webhook)) {
    throw new ZendeskWebhookValidationError("Zendesk webhook envelope is invalid.");
  }
  if (
    webhookIdentifier(value.app.id, "Zendesk app id") !== expectedAppId ||
    webhookIdentifier(value.webhook.id, "Zendesk webhook id") !== expectedWebhookId ||
    value.webhook.version !== "v2"
  ) {
    throw new ZendeskWebhookValidationError(
      "Zendesk webhook does not belong to the configured installation.",
    );
  }
  if (!Array.isArray(value.events) || value.events.length > MAX_WEBHOOK_EVENTS) {
    throw new ZendeskWebhookValidationError(
      `Zendesk webhook events must contain at most ${MAX_WEBHOOK_EVENTS} items.`,
    );
  }
  const matches = new Map<string, ZendeskSwitchboardIntegrationReference>();
  for (const event of value.events) {
    if (!isRecord(event) || !isRecord(event.payload) || !isRecord(event.payload.conversation)) {
      continue;
    }
    const reference = integrationReference(
      event.payload.conversation.activeSwitchboardIntegration,
      "Zendesk active Switchboard integration",
    );
    if (reference?.integrationType !== marketplaceClientId) continue;
    matches.set(
      `${reference.switchboardIntegrationId}\n${reference.integrationId}`,
      reference,
    );
  }
  if (matches.size > 1) {
    throw new ZendeskWebhookValidationError(
      "Zendesk webhook contains ambiguous Marketplace integration identifiers.",
    );
  }
  return matches.values().next().value ?? null;
}

function sameIntegration(
  value: ZendeskSwitchboardIntegrationReference | null,
  options: ZendeskMarketplaceLifecycleParserOptions,
): boolean {
  return value !== null &&
    value.switchboardIntegrationId === options.switchboardIntegrationId &&
    value.integrationId === options.integrationId;
}

function lifecycleDirective(
  type: string,
  creationReason: string,
  active: boolean,
): ZendeskMarketplaceLifecycleDirective {
  if (type === "conversation:create") {
    if (!active) return "none";
    if (creationReason === "startConversation") return "greet";
    if (creationReason === "message") return "await_message";
    if (creationReason === "proactiveMessaging") return "inspect_proactive_campaign";
    return "none";
  }
  if (type === "conversation:referral") return active ? "greet" : "none";
  if (type === "switchboard:passControl") {
    // The official event contains the new active integration, not a guaranteed
    // previous integration. A pass to us may greet; every pass away is safe cleanup.
    return active ? "greet" : "cleanup";
  }
  if (type === "switchboard:releaseControl") {
    return "cleanup";
  }
  return "none";
}

/** Parse and plan non-message events from the same Marketplace webhook envelope. */
export function parseZendeskMarketplaceLifecycleWebhook(
  value: unknown,
  options: ZendeskMarketplaceLifecycleParserOptions,
): readonly ZendeskMarketplaceLifecycleEvent[] {
  if (!isRecord(options)) {
    throw new ZendeskIntegrationError("Zendesk lifecycle parser options are invalid.");
  }
  const expectedAppId = identifier(options.expectedAppId, "Expected Zendesk app id");
  const expectedWebhookId = identifier(
    options.expectedWebhookId,
    "Expected Zendesk webhook id",
  );
  identifier(options.switchboardIntegrationId, "Zendesk Switchboard integration id");
  identifier(options.integrationId, "Zendesk underlying integration id");
  if (!isRecord(value) || !isRecord(value.app) || !isRecord(value.webhook)) {
    throw new ZendeskWebhookValidationError("Zendesk webhook envelope is invalid.");
  }
  const appId = webhookIdentifier(value.app.id, "Zendesk app id");
  const webhookId = webhookIdentifier(value.webhook.id, "Zendesk webhook id");
  if (value.webhook.version !== "v2") {
    throw new ZendeskWebhookValidationError("Only Zendesk webhook version v2 is supported.");
  }
  if (appId !== expectedAppId || webhookId !== expectedWebhookId) {
    throw new ZendeskWebhookValidationError(
      "Zendesk webhook does not belong to the configured installation.",
    );
  }
  if (!Array.isArray(value.events) || value.events.length > MAX_WEBHOOK_EVENTS) {
    throw new ZendeskWebhookValidationError(
      `Zendesk webhook events must contain at most ${MAX_WEBHOOK_EVENTS} items.`,
    );
  }

  return Object.freeze(value.events.map((event): ZendeskMarketplaceLifecycleEvent => {
    if (!isRecord(event)) {
      throw new ZendeskWebhookValidationError("Zendesk lifecycle event must be an object.");
    }
    const eventId = webhookIdentifier(event.id, "Zendesk lifecycle event id");
    const eventCreatedAt = eventTimestamp(event.createdAt);
    const type = typeof event.type === "string" ? event.type : "";
    if (
      type !== "conversation:create" &&
      type !== "conversation:referral" &&
      type !== "switchboard:passControl" &&
      type !== "switchboard:releaseControl"
    ) {
      return Object.freeze({
        kind: "ignored" as const,
        eventId,
        eventCreatedAt,
        eventType: type,
        directive: "none" as const,
      });
    }
    if (!isRecord(event.payload) || !isRecord(event.payload.conversation)) {
      throw new ZendeskWebhookValidationError("Zendesk lifecycle event is incomplete.");
    }
    const conversation = event.payload.conversation;
    const conversationId = webhookIdentifier(
      conversation.id,
      "Zendesk lifecycle conversation id",
    );
    const active = integrationReference(
      conversation.activeSwitchboardIntegration,
      "Zendesk active Switchboard integration",
    );
    const previousValue = event.payload.previousActiveSwitchboardIntegration ??
      conversation.previousActiveSwitchboardIntegration;
    const previous = integrationReference(
      previousValue,
      "Zendesk previous active Switchboard integration",
    );
    const creationReason = typeof event.payload.creationReason === "string"
      ? event.payload.creationReason
      : "none";
    const configuredIntegrationActive = sameIntegration(active, options);
    const directive = lifecycleDirective(
      type,
      creationReason,
      configuredIntegrationActive,
    );
    const releasePlan = configuredIntegrationActive
      ? createZendeskControlReleasePlan({
          appId,
          conversationId,
          acquiredAt: eventCreatedAt,
          ...(options.releaseAfterMs === undefined
            ? {}
            : { releaseAfterMs: options.releaseAfterMs }),
          metadata: { lifecycle_event_id: eventId },
        })
      : null;
    const base = {
      appId,
      webhookId,
      eventId,
      eventCreatedAt,
      conversationId,
      activeSwitchboardIntegration: active,
      previousActiveSwitchboardIntegration: previous,
      configuredIntegrationActive,
      directive,
      releasePlan,
    };
    if (type === "conversation:create") {
      return Object.freeze({
        ...base,
        kind: "conversation_create" as const,
        creationReason,
      });
    }
    if (type === "conversation:referral") {
      return Object.freeze({ ...base, kind: "conversation_referral" as const });
    }
    if (type === "switchboard:passControl") {
      return Object.freeze({ ...base, kind: "switchboard_pass_control" as const });
    }
    return Object.freeze({ ...base, kind: "switchboard_release_control" as const });
  }));
}

export interface ZendeskMarketplaceLifecycleHandlers {
  /** Persist/schedule the earliest plan for the conversation before greeting or waiting. */
  readonly scheduleRelease?: (
    plan: ZendeskControlReleasePlan,
    event: ZendeskMarketplaceLifecycleEvent,
  ) => void | Promise<void>;
  readonly greet?: (event: ZendeskMarketplaceLifecycleEvent) => void | Promise<void>;
  readonly awaitMessage?: (event: ZendeskMarketplaceLifecycleEvent) => void | Promise<void>;
  readonly inspectProactiveCampaign?: (
    event: ZendeskMarketplaceLifecycleEvent,
  ) => void | Promise<void>;
  readonly cleanup?: (event: ZendeskMarketplaceLifecycleEvent) => void | Promise<void>;
}

/** Execute one planned lifecycle callback; de-duplicate by `eventId` before calling. */
export async function handleZendeskMarketplaceLifecycleEvent(
  event: ZendeskMarketplaceLifecycleEvent,
  handlers: ZendeskMarketplaceLifecycleHandlers,
): Promise<ZendeskMarketplaceLifecycleDirective> {
  if (
    typeof event !== "object" ||
    event === null ||
    typeof handlers !== "object" ||
    handlers === null
  ) {
    throw new ZendeskIntegrationError("Zendesk lifecycle handler input is invalid.");
  }
  if ("releasePlan" in event && event.releasePlan !== null) {
    await handlers.scheduleRelease?.(event.releasePlan, event);
  }
  if (event.directive === "greet") await handlers.greet?.(event);
  if (event.directive === "await_message") await handlers.awaitMessage?.(event);
  if (event.directive === "inspect_proactive_campaign") {
    await handlers.inspectProactiveCampaign?.(event);
  }
  if (event.directive === "cleanup") await handlers.cleanup?.(event);
  return event.directive;
}

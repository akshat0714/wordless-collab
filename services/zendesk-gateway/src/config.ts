import type {
  DeliveryMode,
  GatewayConfig,
  Installation,
  InstallationAuthentication,
  RuntimeEnvironment,
  StoreDriver,
} from "./types.js";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const INSTALLATION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SECRET_REF = /^[A-Z][A-Z0-9_]{2,127}$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new ConfigurationError(`${label} has unknown or missing fields.`);
  }
}

function stringField(
  value: unknown,
  label: string,
  pattern: RegExp,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ConfigurationError(`${label} is invalid.`);
  }
  return value;
}

function secretRef(value: unknown, label: string): string {
  return stringField(value, label, SECRET_REF);
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  const parsed = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigurationError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function booleanFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new ConfigurationError(`${name} must be true or false.`);
}

function localePrefixes(raw: string | undefined): readonly string[] {
  const values = (raw?.trim() || "en").split(",").map((value) => value.trim().toLowerCase());
  if (values.length === 0 || values.length > 20 || values.some((value) => !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u.test(value))) {
    throw new ConfigurationError("SUPPORTED_LOCALE_PREFIXES must be a comma-separated locale prefix list.");
  }
  return Object.freeze([...new Set(values)]);
}

function readTextFile(path: string, name: string, maximumBytes: number): string {
  if (!isAbsolute(path)) throw new ConfigurationError(`${name} must be an absolute path.`);
  let bytes: Buffer;
  try {
    const size = statSync(path).size;
    if (size > maximumBytes) throw new ConfigurationError(`${name} exceeds its size limit.`);
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`${name} could not be read.`);
  }
  if (bytes.byteLength > maximumBytes) throw new ConfigurationError(`${name} exceeds its size limit.`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r?\n$/u, "");
  } catch {
    throw new ConfigurationError(`${name} must be UTF-8 text.`);
  }
}

function envOrFile(
  env: NodeJS.ProcessEnv,
  valueName: string,
  fileName: string,
  maximumBytes: number,
): string | undefined {
  const value = env[valueName];
  const path = env[fileName];
  if (value !== undefined && value !== "" && path !== undefined && path !== "") {
    throw new ConfigurationError(`${valueName} and ${fileName} are mutually exclusive.`);
  }
  if (path !== undefined && path !== "") return readTextFile(path, fileName, maximumBytes);
  return value;
}

function oneOf<T extends string>(
  value: string | undefined,
  values: readonly T[],
  fallback: T,
  label: string,
): T {
  const selected = value === undefined || value === "" ? fallback : value;
  if (!values.includes(selected as T)) {
    throw new ConfigurationError(`${label} must be one of: ${values.join(", ")}.`);
  }
  return selected as T;
}

function parseAuthentication(value: unknown, index: number): InstallationAuthentication {
  const auth = record(value, `installations[${index}].zendeskAuthentication`);
  if (auth.type === "basic") {
    exactKeys(auth, ["type", "scope", "keyIdRef", "keySecretRef"], ["type", "scope", "keyIdRef", "keySecretRef"], "Zendesk basic authentication");
    if (auth.scope !== "integration") throw new ConfigurationError("Zendesk credentials must be integration-scoped.");
    return {
      type: "basic",
      scope: "integration",
      keyIdRef: secretRef(auth.keyIdRef, "Zendesk key id reference"),
      keySecretRef: secretRef(auth.keySecretRef, "Zendesk key secret reference"),
    };
  }
  if (auth.type === "bearer") {
    exactKeys(auth, ["type", "scope", "tokenRef", "marketplace"], ["type", "scope", "tokenRef"], "Zendesk bearer authentication");
    if (auth.scope !== "integration") throw new ConfigurationError("Zendesk credentials must be integration-scoped.");
    let marketplace: { name: string; organizationId: string; botId: string } | undefined;
    if (auth.marketplace !== undefined) {
      const fields = record(auth.marketplace, "Zendesk marketplace headers");
      exactKeys(fields, ["name", "organizationId", "botId"], ["name", "organizationId", "botId"], "Zendesk marketplace headers");
      if ([fields.name, fields.organizationId, fields.botId].some((field) => typeof field !== "string" || field.length === 0 || field.length > 128 || /[\r\n]/u.test(field))) {
        throw new ConfigurationError("Zendesk marketplace headers are invalid.");
      }
      marketplace = {
        name: fields.name as string,
        organizationId: fields.organizationId as string,
        botId: fields.botId as string,
      };
    }
    return {
      type: "bearer",
      scope: "integration",
      tokenRef: secretRef(auth.tokenRef, "Zendesk bearer token reference"),
      ...(marketplace === undefined ? {} : { marketplace }),
    };
  }
  throw new ConfigurationError("Zendesk authentication type is invalid.");
}

function parseInstallations(raw: string | undefined): ReadonlyMap<string, Installation> {
  if (raw === undefined || raw.trim() === "") {
    throw new ConfigurationError("INSTALLATIONS_JSON is required.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ConfigurationError("INSTALLATIONS_JSON must be valid JSON.");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) {
    throw new ConfigurationError("INSTALLATIONS_JSON must contain 1 to 1000 installations.");
  }
  const installations = new Map<string, Installation>();
  value.forEach((rawInstallation, index) => {
    const item = record(rawInstallation, `installations[${index}]`);
    exactKeys(
      item,
      ["id", "appId", "webhookId", "switchboardIntegrationId", "underlyingIntegrationId", "humanSwitchboardIntegrationId", "zendeskSubdomain", "webhookAuth", "choiceSigningSecretRef", "wordlessApiKeyRef", "wordlessSigningSecretRef", "zendeskAuthentication"],
      ["id", "appId", "webhookId", "switchboardIntegrationId", "underlyingIntegrationId", "humanSwitchboardIntegrationId", "zendeskSubdomain", "webhookAuth", "choiceSigningSecretRef", "wordlessApiKeyRef", "wordlessSigningSecretRef", "zendeskAuthentication"],
      `installations[${index}]`,
    );
    const webhookAuth = record(item.webhookAuth, `installations[${index}].webhookAuth`);
    exactKeys(webhookAuth, ["mode", "secretRef"], ["mode", "secretRef"], "Webhook authentication");
    if (webhookAuth.mode !== "path_bearer" && webhookAuth.mode !== "hmac_sha256" && webhookAuth.mode !== "x_api_key") {
      throw new ConfigurationError("Webhook authentication mode is invalid.");
    }
    const id = stringField(item.id, "Installation id", INSTALLATION_ID);
    if (installations.has(id)) throw new ConfigurationError(`Duplicate installation id: ${id}.`);
    const switchboardIntegrationId = stringField(item.switchboardIntegrationId, "Zendesk switchboard integration id", ID);
    const humanSwitchboardIntegrationId = stringField(item.humanSwitchboardIntegrationId, "Zendesk human switchboard integration id", ID);
    if (humanSwitchboardIntegrationId === switchboardIntegrationId) {
      throw new ConfigurationError("Zendesk human integration must be different from Wordless.");
    }
    installations.set(id, Object.freeze({
      id,
      appId: stringField(item.appId, "Zendesk app id", ID),
      webhookId: stringField(item.webhookId, "Zendesk webhook id", ID),
      switchboardIntegrationId,
      underlyingIntegrationId: stringField(item.underlyingIntegrationId, "Zendesk underlying integration id", ID),
      humanSwitchboardIntegrationId,
      zendeskSubdomain: stringField(item.zendeskSubdomain, "Zendesk subdomain", SUBDOMAIN),
      webhookAuth: Object.freeze({
        mode: webhookAuth.mode,
        secretRef: secretRef(webhookAuth.secretRef, "Webhook secret reference"),
      }),
      choiceSigningSecretRef: secretRef(item.choiceSigningSecretRef, "Choice signing secret reference"),
      wordlessApiKeyRef: secretRef(item.wordlessApiKeyRef, "Wordless API key reference"),
      wordlessSigningSecretRef: secretRef(item.wordlessSigningSecretRef, "Wordless signing secret reference"),
      zendeskAuthentication: parseAuthentication(item.zendeskAuthentication, index),
    }));
  });
  return installations;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost") return true;
  if (isIP(host) === 6) return host === "::1" || /^f[cd][0-9a-f:]*$/u.test(host) || /^fe[89ab][0-9a-f:]*$/u.test(host);
  if (!host.includes(".") && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(host)) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 169 && parts[1] === 254);
}

function validOrigin(value: string | undefined, allowPrivateHttp: boolean): string {
  if (value === undefined || value === "") throw new ConfigurationError("WORDLESS_BASE_URL is required.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("WORDLESS_BASE_URL is invalid.");
  }
  if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ConfigurationError("WORDLESS_BASE_URL must be an origin only.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isPrivateHostname(url.hostname) && allowPrivateHttp)) {
    throw new ConfigurationError("WORDLESS_BASE_URL must use HTTPS; private HTTP requires WORDLESS_ALLOW_PRIVATE_HTTP=true.");
  }
  return url.origin;
}

function parseJson(name: string, raw: string | undefined, fallback: unknown): unknown {
  if (raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ConfigurationError(`${name} must be valid JSON.`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const environment = oneOf<RuntimeEnvironment>(env.NODE_ENV, ["development", "test", "production"], "development", "NODE_ENV");
  const storeDriver = oneOf<StoreDriver>(env.GATEWAY_STORE, ["memory", "postgres"], environment === "production" ? "postgres" : "memory", "GATEWAY_STORE");
  const deliveryMode = oneOf<DeliveryMode>(env.OUTBOX_DELIVERY_MODE, ["zendesk", "log"], "zendesk", "OUTBOX_DELIVERY_MODE");
  const resolverMode = oneOf(env.EVIDENCE_RESOLVER_MODE, ["http", "demo"] as const, environment === "production" ? "http" : "demo", "EVIDENCE_RESOLVER_MODE");
  const productMode = oneOf(env.PRODUCT_MODE, ["customer_clarify"] as const, "customer_clarify", "PRODUCT_MODE");
  const requireKnownLocale = env.REQUIRE_KNOWN_LOCALE === undefined || env.REQUIRE_KNOWN_LOCALE === ""
    ? environment === "production"
    : booleanFlag(env, "REQUIRE_KNOWN_LOCALE");
  const supportedLocalePrefixes = localePrefixes(env.SUPPORTED_LOCALE_PREFIXES);
  if (environment === "production" && (
    supportedLocalePrefixes.length !== 1 || supportedLocalePrefixes[0] !== "en" || !requireKnownLocale
  )) {
    throw new ConfigurationError("Production currently requires SUPPORTED_LOCALE_PREFIXES=en and REQUIRE_KNOWN_LOCALE=true.");
  }
  if (environment === "production" && env.PRODUCT_MODE !== "customer_clarify") {
    throw new ConfigurationError("Production requires explicit PRODUCT_MODE=customer_clarify.");
  }
  if (environment === "production" && (storeDriver !== "postgres" || deliveryMode !== "zendesk" || resolverMode !== "http")) {
    throw new ConfigurationError("Production requires PostgreSQL, Zendesk delivery, and the authenticated HTTP evidence resolver.");
  }
  const databaseUrl = loadDatabaseUrl(env, false);
  if (storeDriver === "postgres" && databaseUrl === null) {
    throw new ConfigurationError("DATABASE_URL or DATABASE_URL_FILE is required with the PostgreSQL store.");
  }
  const resolver = resolverMode === "http"
    ? (() => {
        if (env.EVIDENCE_RESOLVER_URL === undefined) throw new ConfigurationError("EVIDENCE_RESOLVER_URL is required.");
        let url: URL;
        try {
          url = new URL(env.EVIDENCE_RESOLVER_URL);
        } catch {
          throw new ConfigurationError("EVIDENCE_RESOLVER_URL is invalid.");
        }
        if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
          throw new ConfigurationError("EVIDENCE_RESOLVER_URL cannot contain credentials, query, or fragment.");
        }
        if (url.protocol !== "https:" && !(url.protocol === "http:" && isPrivateHostname(url.hostname) && booleanFlag(env, "EVIDENCE_RESOLVER_ALLOW_PRIVATE_HTTP"))) {
          throw new ConfigurationError("EVIDENCE_RESOLVER_URL must use HTTPS; private HTTP requires EVIDENCE_RESOLVER_ALLOW_PRIVATE_HTTP=true.");
        }
        return {
          mode: "http" as const,
          url: url.toString(),
          authorizationSecretRef: secretRef(env.EVIDENCE_RESOLVER_SECRET_REF, "Evidence resolver secret reference"),
          timeoutMs: integer(env, "EVIDENCE_RESOLVER_TIMEOUT_MS", 5_000, 100, 60_000),
        };
      })()
    : {
        mode: "demo" as const,
        evidenceJson: parseJson("DEMO_EVIDENCE_JSON", env.DEMO_EVIDENCE_JSON, []),
      };

  return Object.freeze({
    environment,
    host: env.GATEWAY_HOST?.trim() || "127.0.0.1",
    port: integer(env, "PORT", 8080, 1, 65_535),
    storeDriver,
    databaseUrl,
    wordlessBaseUrl: validOrigin(env.WORDLESS_BASE_URL, booleanFlag(env, "WORDLESS_ALLOW_PRIVATE_HTTP")),
    installations: parseInstallations(envOrFile(env, "INSTALLATIONS_JSON", "INSTALLATIONS_JSON_FILE", 1_048_576)),
    evidenceResolver: resolver,
    deliveryMode,
    productMode,
    bodyMaxBytes: integer(env, "BODY_MAX_BYTES", 262_144, 1_024, 1_048_576),
    webhookClockSkewSeconds: integer(env, "WEBHOOK_CLOCK_SKEW_SECONDS", 300, 30, 3_600),
    processTimeoutMs: integer(env, "WEBHOOK_PROCESS_TIMEOUT_MS", 25_000, 1_000, 120_000),
    zendeskTimeoutMs: integer(env, "ZENDESK_TIMEOUT_MS", 10_000, 100, 60_000),
    // Leave at least one hour for a bounded release retry before Zendesk's 24h maximum.
    choiceTtlHours: integer(env, "CHOICE_TTL_HOURS", 1, 1, 23),
    supportedLocalePrefixes,
    requireKnownLocale,
    outboxPollMs: integer(env, "OUTBOX_POLL_MS", 500, 50, 60_000),
    outboxLeaseMs: integer(env, "OUTBOX_LEASE_MS", 30_000, 1_000, 300_000),
    outboxMaxAttempts: integer(env, "OUTBOX_MAX_ATTEMPTS", 10, 1, 100),
    shutdownGraceMs: integer(env, "SHUTDOWN_GRACE_MS", 15_000, 1_000, 120_000),
    retentionDays: integer(env, "RETENTION_DAYS", 30, 1, 90),
    cleanupIntervalMs: integer(env, "CLEANUP_INTERVAL_MS", 3_600_000, 60_000, 86_400_000),
  });
}

export function loadDatabaseUrl(env: NodeJS.ProcessEnv = process.env, required = true): string | null {
  const value = envOrFile(env, "DATABASE_URL", "DATABASE_URL_FILE", 8_192)?.trim() || null;
  if (required && value === null) throw new ConfigurationError("DATABASE_URL or DATABASE_URL_FILE is required.");
  return value;
}

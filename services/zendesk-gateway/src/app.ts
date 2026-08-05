import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { authenticateHead, authenticateWebhook } from "./auth.js";
import type { GatewayRuntime } from "./runtime.js";
import type { SecretStore } from "./secrets.js";
import type { GatewayStore } from "./store.js";
import type { GatewayConfig, Installation } from "./types.js";
import { safeErrorCode, type Logger } from "./logger.js";

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large.");
    this.name = "BodyTooLargeError";
  }
}

function respond(response: ServerResponse, status: number, body?: Readonly<Record<string, unknown>>): void {
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (body === undefined) {
    response.end();
    return;
  }
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw new BodyTooLargeError();
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    length += chunk.byteLength;
    if (length > maximumBytes) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function route(url: string | undefined): { installationId: string; credential: string | null } | null {
  if (url === undefined) return null;
  let pathname: string;
  try { pathname = new URL(url, "http://gateway.invalid").pathname; } catch { return null; }
  const match = /^\/v1\/webhooks\/zendesk\/([a-z0-9][a-z0-9_-]{0,63})(?:\/([^/]+))?\/?$/u.exec(pathname);
  if (match?.[1] === undefined) return null;
  try {
    return { installationId: match[1], credential: match[2] === undefined ? null : decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

function deliveryId(request: IncomingMessage, bodySha256: string): string | null {
  const value = request.headers["x-wordless-delivery-id"];
  if (value === undefined) return `body:${bodySha256}`;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(value)) return null;
  return `header:${value}`;
}

export interface GatewayServerDependencies {
  readonly config: GatewayConfig;
  readonly store: GatewayStore;
  readonly secrets: SecretStore;
  readonly runtime: GatewayRuntime;
  readonly logger: Logger;
}

export function createGatewayServer(dependencies: GatewayServerDependencies): Server {
  const { config, store, secrets, runtime, logger } = dependencies;
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const started = Date.now();
    try {
      if (request.url === "/health/live" && request.method === "GET") {
        respond(response, 200, { status: "ok" });
        return;
      }
      if (request.url === "/health/ready" && request.method === "GET") {
        try {
          await Promise.all([store.ping(), runtime.validateSecrets()]);
          respond(response, 200, { status: "ready" });
        } catch {
          respond(response, 503, { status: "not_ready" });
        }
        return;
      }
      const parsedRoute = route(request.url);
      if (parsedRoute === null) {
        respond(response, 404, { error: "not_found" });
        return;
      }
      const installation: Installation | undefined = config.installations.get(parsedRoute.installationId);
      if (installation === undefined) {
        respond(response, 404, { error: "not_found" });
        return;
      }
      if (request.method === "HEAD") {
        const authenticated = await authenticateHead(installation, parsedRoute.credential, request.headers, secrets);
        respond(response, authenticated ? 204 : 404);
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("allow", "HEAD, POST");
        respond(response, 405, { error: "method_not_allowed" });
        return;
      }
      if (!/^application\/json(?:\s*;|$)/iu.test(request.headers["content-type"] ?? "")) {
        respond(response, 415, { error: "content_type_required" });
        return;
      }
      // Header/path credentials do not depend on the body: reject before buffering it.
      if (
        installation.webhookAuth.mode !== "hmac_sha256" &&
        !await authenticateHead(installation, parsedRoute.credential, request.headers, secrets)
      ) {
        respond(response, 401, { error: "unauthorized" });
        return;
      }
      const rawBody = await readBody(request, config.bodyMaxBytes);
      const authenticated = installation.webhookAuth.mode === "hmac_sha256"
        ? await authenticateWebhook(
            installation,
            request.headers,
            rawBody,
            parsedRoute.credential,
            config.webhookClockSkewSeconds,
            secrets,
          )
        : true;
      if (!authenticated) {
        respond(response, 401, { error: "unauthorized" });
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
      } catch {
        respond(response, 400, { error: "invalid_json" });
        return;
      }
      const bodySha256 = createHash("sha256").update(rawBody).digest("hex");
      const key = deliveryId(request, bodySha256);
      if (key === null) {
        respond(response, 400, { error: "invalid_delivery_id" });
        return;
      }
      const claim = await store.claimDelivery({
        installationId: installation.id,
        deliveryKey: key,
        bodySha256,
        payload,
      });
      if (claim === "conflict") {
        respond(response, 409, { error: "delivery_id_reused" });
        return;
      }
      respond(response, 202, { status: claim === "duplicate" ? "duplicate" : "accepted" });
      logger.log("info", claim === "duplicate" ? "webhook_duplicate" : "webhook_accepted", {
        request_id: requestId,
        installation_id: installation.id,
        product_mode: config.productMode,
        duration_ms: Date.now() - started,
      });
    } catch (error) {
      const status = error instanceof BodyTooLargeError ? 413 : 503;
      logger.log(status === 413 ? "warn" : "error", "webhook_request_failed", {
        request_id: requestId,
        duration_ms: Date.now() - started,
        error_code: safeErrorCode(error),
        status,
      });
      if (!response.headersSent) respond(response, status, { error: status === 413 ? "body_too_large" : "temporarily_unavailable" });
      else response.end();
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;
  return server;
}

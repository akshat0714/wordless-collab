import "server-only";

import { fetchProductWithSafeRetry } from "@/lib/live-product-retry";
import { createLiveRequestSignature } from "@/lib/live-signature";

const developmentBaseUrl = "http://127.0.0.1:8001";
const developmentApiKey = "wl_live_demo.local_only_wordless_key_2026_07_25";
const maximumUpstreamResponseBytes = 256 * 1024;
const upstreamTimeoutMs = 30_000;

export class LiveProductConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveProductConfigurationError";
  }
}

export class LiveProductTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveProductTransportError";
  }
}

type ProductConfiguration = {
  baseUrl: URL;
  apiKey: string;
  signingSecret: string | null;
};

export type ProductFetchResult = {
  ok: boolean;
  status: number;
  value: unknown;
  requestId: string | null;
  retryAfter: string | null;
};

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

function productConfiguration(): ProductConfiguration {
  const production = process.env.NODE_ENV === "production";
  if (production) {
    throw new LiveProductConfigurationError(
      "The local live console proxy is disabled in production until human session authentication is configured.",
    );
  }

  const baseText = process.env.WORDLESS_REALTIME_API_BASE_URL ?? developmentBaseUrl;
  const apiKey = process.env.WORDLESS_REALTIME_API_KEY ?? developmentApiKey;
  const signingSecret = process.env.WORDLESS_REALTIME_SIGNING_SECRET ?? null;

  let baseUrl: URL;
  try {
    baseUrl = new URL(baseText);
  } catch {
    throw new LiveProductConfigurationError(
      "The server-side real-time API URL is invalid.",
    );
  }
  if (
    (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    (baseUrl.pathname !== "/" && baseUrl.pathname !== "")
  ) {
    throw new LiveProductConfigurationError(
      "The real-time API URL must be an HTTP(S) origin without credentials or a path.",
    );
  }
  if (baseUrl.protocol !== "https:" && !isLoopback(baseUrl.hostname)) {
    throw new LiveProductConfigurationError(
      "A non-loopback real-time API URL must use HTTPS.",
    );
  }
  if (!/^wl_live_[A-Za-z0-9][A-Za-z0-9_-]{1,31}\.[A-Za-z0-9_-]{24,128}$/.test(apiKey)) {
    throw new LiveProductConfigurationError(
      "The server-side real-time API key has an invalid format.",
    );
  }
  if (signingSecret !== null && signingSecret.length < 32) {
    throw new LiveProductConfigurationError(
      "The server-side signing secret must contain at least 32 characters.",
    );
  }
  return { baseUrl, apiKey, signingSecret };
}

function signatureHeaders(
  body: string,
  secret: string | null,
  path: string,
  idempotencyKey: string,
): Record<string, string> {
  if (secret === null) return {};
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createLiveRequestSignature({
    body,
    idempotencyKey,
    path,
    secret,
    timestamp,
  });
  return {
    "X-Wordless-Timestamp": timestamp,
    "X-Wordless-Signature": `v1=${signature}`,
  };
}

export async function fetchLiveProduct(
  path: string,
  {
    body,
    idempotencyKey,
    requestSignal,
    retryOnce = false,
  }: {
    body: string;
    idempotencyKey: string;
    requestSignal: AbortSignal;
    retryOnce?: boolean;
  },
): Promise<ProductFetchResult> {
  if (!path.startsWith("/v1/") || path.includes("?") || path.includes("#")) {
    throw new LiveProductConfigurationError("The real-time API path is invalid.");
  }
  const configuration = productConfiguration();
  const target = new URL(path, configuration.baseUrl);
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${configuration.apiKey}`,
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
    ...signatureHeaders(body, configuration.signingSecret, path, idempotencyKey),
  };

  let response: Response;
  try {
    response = await fetchProductWithSafeRetry({
      target,
      requestSignal,
      timeoutMs: upstreamTimeoutMs,
      retryOnce,
      init: {
        method: "POST",
        cache: "no-store",
        redirect: "error",
        headers,
        body,
      },
    });
  } catch (error) {
    if (requestSignal.aborted) {
      throw new LiveProductTransportError("The browser cancelled the live API request.");
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new LiveProductTransportError("The real-time API did not respond before the timeout.");
    }
    throw new LiveProductTransportError("The real-time API could not be reached.");
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumUpstreamResponseBytes) {
    throw new LiveProductTransportError("The real-time API response was too large.");
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new LiveProductTransportError("The real-time API returned a non-JSON response.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maximumUpstreamResponseBytes) {
    throw new LiveProductTransportError("The real-time API response was too large.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new LiveProductTransportError("The real-time API returned malformed JSON.");
  }
  return {
    ok: response.ok,
    status: response.status,
    value,
    requestId: response.headers.get("x-wordless-request-id"),
    retryAfter: response.headers.get("retry-after"),
  };
}

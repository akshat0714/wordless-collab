import {
  parseLiveApiError,
  parseLiveSuggestionInput,
  parseLiveSuggestionResponse,
} from "@/lib/live-suggestion-schema";
import { buildLiveDemoProductRequest } from "@/lib/live-demo-request";
import {
  fetchLiveProduct,
  LiveProductConfigurationError,
  LiveProductTransportError,
} from "@/lib/live-product-server";
import { assertRequestSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maximumRequestBytes = 32 * 1024;

function noStoreJson(value: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function safeError(code: string, message: string, status: number): Response {
  return noStoreJson(
    { error: { code, message, request_id: null } },
    status,
  );
}

async function boundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new Error("content_type");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumRequestBytes) {
    throw new Error("request_too_large");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maximumRequestBytes) {
    throw new Error("request_too_large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("invalid_json");
  }
}

export async function POST(request: Request): Promise<Response> {
  let input: ReturnType<typeof parseLiveSuggestionInput>;
  try {
    assertRequestSameOrigin(request);
    input = parseLiveSuggestionInput(await boundedJson(request));
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_request";
    if (code === "cross_origin") {
      return safeError("cross_origin", "Cross-origin live requests are not allowed.", 403);
    }
    if (code === "content_type") {
      return safeError("content_type", "Content-Type must be application/json.", 415);
    }
    if (code === "request_too_large") {
      return safeError("request_too_large", "The live request is too large.", 413);
    }
    return safeError(
      "invalid_request",
      "The live request must contain one bounded utterance and request ID.",
      400,
    );
  }

  const observedAtMs = Date.parse(input.observed_at);
  const nowMs = Date.now();
  if (observedAtMs > nowMs + 30_000 || observedAtMs < nowMs - 15 * 60_000) {
    return safeError(
      "invalid_observed_at",
      "The live request timestamp is outside the allowed retry window.",
      400,
    );
  }
  const upstreamBody = buildLiveDemoProductRequest(input);

  try {
    const upstream = await fetchLiveProduct("/v1/suggestions", {
      body: upstreamBody,
      idempotencyKey: `console-suggestion:${input.request_id}`,
      requestSignal: request.signal,
    });
    const requestHeaders: Record<string, string> = {};
    if (upstream.requestId) {
      requestHeaders["X-Wordless-Upstream-Request-Id"] = upstream.requestId;
    }
    if (!upstream.ok) {
      let error;
      try {
        error = parseLiveApiError(upstream.value);
      } catch {
        return safeError(
          "upstream_error",
          "The real-time API could not complete the suggestion.",
          502,
        );
      }
      const headers: Record<string, string> = { ...requestHeaders };
      if (upstream.retryAfter) headers["Retry-After"] = upstream.retryAfter;
      return noStoreJson(error, upstream.status, headers);
    }
    let response;
    try {
      response = parseLiveSuggestionResponse(upstream.value);
    } catch (error) {
      console.error("The real-time API returned an invalid suggestion contract.", error);
      return safeError(
        "invalid_upstream_contract",
        "The real-time API returned an invalid suggestion response.",
        502,
      );
    }
    return noStoreJson(response, upstream.status, requestHeaders);
  } catch (error) {
    if (error instanceof LiveProductConfigurationError) {
      console.error("The live product proxy is not configured.", error.message);
      return safeError(
        "live_api_not_configured",
        "The server-side real-time API connection is not configured.",
        503,
      );
    }
    if (error instanceof LiveProductTransportError) {
      console.error("The live product proxy could not reach its upstream.", error.message);
      return safeError(
        "live_api_unavailable",
        "The real-time API is unavailable. Start it and try again.",
        502,
      );
    }
    console.error("The live product proxy failed unexpectedly.", error);
    return safeError(
      "live_proxy_failed",
      "The live suggestion proxy could not complete the request.",
      500,
    );
  }
}

import {
  parseSupportChatRequest,
} from "@/lib/support-chat-schema";
import {
  adaptSupportChatResponse,
  createHostSupportChatResponse,
} from "@/lib/support-chat-adapter";
import {
  buildSupportAssistRequest,
  supportAssistEvidenceCount,
} from "@/lib/support-demo-request";
import { parseLiveApiError } from "@/lib/live-suggestion-schema";
import {
  fetchLiveProduct,
  LiveProductConfigurationError,
  LiveProductTransportError,
} from "@/lib/live-product-server";
import { parseUpstreamChatAssistResponse } from "@/lib/support-chat-upstream";
import {
  createPublicDemoSupportResponse,
  publicSupportDemoEnabled,
} from "@/lib/support-public-demo";
import { isExplicitHumanSupportRequest } from "@/lib/support-normal-resolver";
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
  return noStoreJson({ error: { code, message, request_id: null } }, status);
}

async function boundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) throw new Error("content_type");
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumRequestBytes) {
    throw new Error("request_too_large");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maximumRequestBytes) throw new Error("request_too_large");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("invalid_json");
  }
}

export async function POST(request: Request): Promise<Response> {
  let input: ReturnType<typeof parseSupportChatRequest>;
  try {
    assertRequestSameOrigin(request);
    input = parseSupportChatRequest(await boundedJson(request));
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_request";
    if (code === "cross_origin") {
      return safeError("cross_origin", "Cross-origin chat requests are not allowed.", 403);
    }
    if (code === "content_type") {
      return safeError("content_type", "Content-Type must be application/json.", 415);
    }
    if (code === "request_too_large") {
      return safeError("request_too_large", "The chat request is too large.", 413);
    }
    return safeError("invalid_request", "The chat message does not match the versioned contract.", 400);
  }

  const observedAtMs = Date.parse(input.observed_at);
  const nowMs = Date.now();
  if (observedAtMs > nowMs + 30_000 || observedAtMs < nowMs - 15 * 60_000) {
    return safeError("invalid_observed_at", "The chat timestamp is outside the allowed window.", 400);
  }

  // The host's person-request rule has priority over semantic assistance.
  if (isExplicitHumanSupportRequest(input.message)) {
    return noStoreJson(createHostSupportChatResponse(input), 200);
  }

  if (publicSupportDemoEnabled(process.env)) {
    return noStoreJson(createPublicDemoSupportResponse(input), 200, {
      "X-Wordless-Demo-Mode": "public_synthetic",
    });
  }

  const upstreamBody = buildSupportAssistRequest(input);
  try {
    const upstream = await fetchLiveProduct("/v1/chat/assist", {
      body: upstreamBody,
      idempotencyKey: `console-chat:${input.request_id}`,
      requestSignal: request.signal,
      retryOnce: true,
    });
    const responseHeaders: Record<string, string> = {};
    if (upstream.requestId) responseHeaders["X-Wordless-Upstream-Request-Id"] = upstream.requestId;
    if (!upstream.ok) {
      try {
        const error = parseLiveApiError(upstream.value);
        if (upstream.retryAfter) responseHeaders["Retry-After"] = upstream.retryAfter;
        return noStoreJson(error, upstream.status, responseHeaders);
      } catch {
        return safeError("upstream_error", "Support could not check the account evidence.", 502);
      }
    }

    let assist;
    try {
      assist = parseUpstreamChatAssistResponse(upstream.value, {
        inputEvidenceCount: supportAssistEvidenceCount(input),
      });
    } catch (error) {
      console.error("The chat assist API returned an invalid contract.", error);
      return safeError("invalid_upstream_contract", "Support received an invalid response.", 502);
    }

    let result;
    try {
      result = adaptSupportChatResponse(input, assist);
    } catch (error) {
      console.error("The chat assist directive could not be adapted.", error);
      return safeError("invalid_upstream_contract", "Support received an invalid directive.", 502);
    }
    return noStoreJson(result, 200, responseHeaders);
  } catch (error) {
    if (error instanceof LiveProductConfigurationError) {
      console.error("The chat proxy is not configured.", error.message);
      return safeError("live_api_not_configured", "Support is not connected to Wordless.", 503);
    }
    if (error instanceof LiveProductTransportError) {
      console.error("The chat proxy could not reach Wordless.", error.message);
      return safeError("live_api_unavailable", "Support is temporarily unavailable. Try again.", 502);
    }
    console.error("The chat proxy failed unexpectedly.", error);
    return safeError("live_proxy_failed", "Support could not complete the request.", 500);
  }
}

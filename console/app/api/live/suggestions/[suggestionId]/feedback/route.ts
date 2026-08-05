import {
  parseLiveApiError,
  parseLiveFeedbackInput,
  parseLiveFeedbackResponse,
} from "@/lib/live-suggestion-schema";
import {
  fetchLiveProduct,
  LiveProductConfigurationError,
  LiveProductTransportError,
} from "@/lib/live-product-server";
import { assertRequestSameOrigin } from "@/lib/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const suggestionIdPattern = /^sg_[0-9a-f]{32}$/;
const maximumRequestBytes = 2 * 1024;

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

export async function POST(
  request: Request,
  context: { params: Promise<{ suggestionId: string }> },
): Promise<Response> {
  const { suggestionId } = await context.params;
  if (!suggestionIdPattern.test(suggestionId)) {
    return safeError("unknown_suggestion", "The suggestion ID is invalid.", 404);
  }

  let input: ReturnType<typeof parseLiveFeedbackInput>;
  try {
    assertRequestSameOrigin(request);
    input = parseLiveFeedbackInput(await boundedJson(request));
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_request";
    if (code === "cross_origin") {
      return safeError("cross_origin", "Cross-origin feedback is not allowed.", 403);
    }
    if (code === "content_type") {
      return safeError("content_type", "Content-Type must be application/json.", 415);
    }
    if (code === "request_too_large") {
      return safeError("request_too_large", "The feedback request is too large.", 413);
    }
    return safeError(
      "invalid_request",
      "The feedback request does not match the versioned contract.",
      400,
    );
  }

  const upstreamBody = JSON.stringify({
    schema_version: 1,
    outcome: input.outcome,
    selected_detector_id: input.selected_detector_id,
    actor: "customer",
  });

  try {
    const upstream = await fetchLiveProduct(
      `/v1/suggestions/${suggestionId}/feedback`,
      {
        body: upstreamBody,
        idempotencyKey: `console-feedback:${input.request_id}`,
        requestSignal: request.signal,
      },
    );
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
          "The real-time API could not record the feedback.",
          502,
        );
      }
      const headers: Record<string, string> = { ...requestHeaders };
      if (upstream.retryAfter) headers["Retry-After"] = upstream.retryAfter;
      return noStoreJson(error, upstream.status, headers);
    }
    let response;
    try {
      response = parseLiveFeedbackResponse(upstream.value);
    } catch (error) {
      console.error("The real-time API returned an invalid feedback contract.", error);
      return safeError(
        "invalid_upstream_contract",
        "The real-time API returned an invalid feedback response.",
        502,
      );
    }
    if (response.suggestion_id !== suggestionId) {
      return safeError(
        "invalid_upstream_contract",
        "The real-time API returned feedback for another suggestion.",
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
      console.error("The live feedback proxy could not reach its upstream.", error.message);
      return safeError(
        "live_api_unavailable",
        "The real-time API is unavailable. Start it and try again.",
        502,
      );
    }
    console.error("The live feedback proxy failed unexpectedly.", error);
    return safeError(
      "live_proxy_failed",
      "The live feedback proxy could not complete the request.",
      500,
    );
  }
}

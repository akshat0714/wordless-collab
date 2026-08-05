// @vitest-environment node

import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WordlessApiError,
  WordlessConfigurationError,
  WordlessNetworkError,
  WordlessRequestError,
  WordlessResponseError,
  createIdempotencyKey,
  createWordlessClient,
  type WordlessSuggestionRequest,
} from "../src/server";

const API_KEY = "wl_live_acme.abcdefghijklmnopqrstuvwxyz012345";
const SIGNING_SECRET = "a-production-signing-secret-with-32-characters";
const SUGGESTION_ID = "sg_0123456789abcdef0123456789abcdef";
const IDEMPOTENCY_KEY = "suggestion-ticket-441-v1";

const request: WordlessSuggestionRequest = {
  schema_version: 1,
  external_event_id: "evt_ticket_441",
  observed_at: "2026-07-25T12:00:00Z",
  channel: "chat",
  customer_external_id: "customer-17",
  utterance: {
    sent_at: "2026-07-25T11:59:00Z",
    text: "I think I paid twice for the same order.",
  },
  evidence: [
    {
      type: "charge",
      ref: "charge-1",
      occurred_at: "2026-07-25T11:00:00Z",
      order_ref: "order-441",
      amount: "84.00",
      currency: "USD",
      status: "succeeded",
    },
    {
      type: "charge",
      ref: "charge-2",
      occurred_at: "2026-07-25T11:06:00Z",
      order_ref: "order-441",
      amount: "84.00",
      currency: "USD",
      status: "succeeded",
    },
  ],
  source_system: "support-backend",
  metadata: { ticket_id: "ticket-441" },
};

const suggestion = {
  schema_version: 1,
  suggestion_id: SUGGESTION_ID,
  status: "completed",
  outcome: "candidates",
  abstained: false,
  abstention_reason: null,
  review_required: true,
  candidates: [
    {
      id: `${SUGGESTION_ID}:duplicate_charge`,
      detector_id: "duplicate_charge",
      title: "You were charged twice",
      detail: "Two successful $84.00 charges were recorded for order order-441 within one hour.",
      rank: 1,
      ranking_score: 1.42,
      evidence: [
        {
          ref: "charge-1",
          source: "billing",
          kind: "charge",
          input_index: 0,
          occurred_at: "2026-07-25T11:00:00Z",
          provenance: "exported",
        },
        {
          ref: "charge-2",
          source: "billing",
          kind: "charge",
          input_index: 1,
          occurred_at: "2026-07-25T11:06:00Z",
          provenance: "exported",
        },
      ],
    },
  ],
  processing_ms: 24,
  redaction_entity_counts: {},
  policy: {
    detector_set_version: "det_0123456789abcdef",
    threshold_version: "pilot-v1",
    threshold: 0,
    score_kind: "ranking_not_probability",
    embedding_model_id: "sentence-transformers/all-MiniLM-L6-v2",
    embedding_model_revision: "1110a243fdf4706b3f48f1d95db1a4f5529b4d41",
  },
  links: {
    self: `/v1/suggestions/${SUGGESTION_ID}`,
    events: `/v1/suggestions/${SUGGESTION_ID}/events`,
    feedback: `/v1/suggestions/${SUGGESTION_ID}/feedback`,
  },
};

const feedback = {
  schema_version: 1,
  feedback_id: "fb_0123456789abcdef0123456789abcdef",
  suggestion_id: SUGGESTION_ID,
  recorded: true,
  outcome: "confirmed",
  selected_detector_id: "duplicate_charge",
  actor: "agent",
  recorded_at: "2026-07-25T12:01:00Z",
};

function jsonResponse(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function errorResponse(
  code: string,
  status: number,
  headers?: Record<string, string>,
): Response {
  return jsonResponse(
    {
      error: {
        code,
        message: `Safe ${code.replace(/_/gu, " ")} message.`,
        request_id: "req_0123456789abcdef01234567",
      },
    },
    status,
    headers,
  );
}

function clientWith(fetchMock: ReturnType<typeof vi.fn>, overrides = {}) {
  return createWordlessClient({
    baseUrl: "https://api.wordless.example",
    apiKey: API_KEY,
    signingSecret: SIGNING_SECRET,
    retryDelayMs: 0,
    fetch: fetchMock as unknown as typeof fetch,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createWordlessClient", () => {
  it("signs the exact suggestion bytes and request identity", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_785_326_400_000);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(suggestion, 201));
    const client = clientWith(fetchMock);

    const result = await client.suggest(request, { idempotencyKey: IDEMPOTENCY_KEY });

    expect(result.suggestion_id).toBe(SUGGESTION_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = init.body as string;
    const headers = new Headers(init.headers);
    const timestamp = headers.get("X-Wordless-Timestamp") as string;
    const expected = createHmac("sha256", Buffer.from(SIGNING_SECRET, "utf8"))
      .update(
        Buffer.from(
          `v1:${timestamp}\nPOST\n/v1/suggestions\n${IDEMPOTENCY_KEY}\n`,
          "utf8",
        ),
      )
      .update(Buffer.from(body, "utf8"))
      .digest("hex");

    expect(url).toBe("https://api.wordless.example/v1/suggestions");
    expect(init.redirect).toBe("error");
    expect(headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("Idempotency-Key")).toBe(IDEMPOTENCY_KEY);
    expect(headers.get("X-Wordless-Signature")).toBe(`v1=${expected}`);
    expect(body).toBe(
      '{"channel":"chat","customer_external_id":"customer-17","evidence":[' +
        '{"amount":"84.00","currency":"USD","occurred_at":"2026-07-25T11:00:00Z",' +
        '"order_ref":"order-441","ref":"charge-1","status":"succeeded","type":"charge"},' +
        '{"amount":"84.00","currency":"USD","occurred_at":"2026-07-25T11:06:00Z",' +
        '"order_ref":"order-441","ref":"charge-2","status":"succeeded","type":"charge"}' +
        '],"external_event_id":"evt_ticket_441","metadata":{"ticket_id":"ticket-441"},' +
        '"observed_at":"2026-07-25T12:00:00Z","schema_version":1,' +
        '"source_system":"support-backend","utterance":{"sent_at":"2026-07-25T11:59:00Z",' +
        '"text":"I think I paid twice for the same order."}}',
    );
  });

  it("retries a transport failure once with the identical body and idempotency key", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_785_326_400_000)
      .mockReturnValueOnce(1_785_326_401_000);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(jsonResponse(suggestion, 200));

    await expect(
      clientWith(fetchMock).suggest(request, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).resolves.toMatchObject({ suggestion_id: SUGGESTION_ID });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(second.body).toBe(first.body);
    expect(new Headers(second.headers).get("Idempotency-Key")).toBe(
      new Headers(first.headers).get("Idempotency-Key"),
    );
    expect(new Headers(second.headers).get("X-Wordless-Timestamp")).not.toBe(
      new Headers(first.headers).get("X-Wordless-Timestamp"),
    );
    expect(new Headers(second.headers).get("X-Wordless-Signature")).not.toBe(
      new Headers(first.headers).get("X-Wordless-Signature"),
    );
  });

  it("performs no more than one automatic retry", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("offline"));
    await expect(
      clientWith(fetchMock).suggest(request, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).rejects.toBeInstanceOf(WordlessNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a transient API response but not an authentication failure", async () => {
    const transientFetch = vi
      .fn()
      .mockResolvedValueOnce(errorResponse("temporarily_unavailable", 503))
      .mockResolvedValueOnce(jsonResponse(suggestion, 201));
    await clientWith(transientFetch).suggest(request, { idempotencyKey: IDEMPOTENCY_KEY });
    expect(transientFetch).toHaveBeenCalledTimes(2);

    const authFetch = vi.fn().mockResolvedValue(errorResponse("invalid_api_key", 401));
    const rejected = clientWith(authFetch).suggest(request, {
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await expect(rejected).rejects.toMatchObject({
      status: 401,
      code: "invalid_api_key",
      requestId: "req_0123456789abcdef01234567",
      retryable: false,
      serverMessage: "Safe invalid api key message.",
    });
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it("parses the safe error envelope and retries suggestion_in_progress", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errorResponse("suggestion_in_progress", 409, { "Retry-After": "0" }),
      )
      .mockResolvedValueOnce(jsonResponse(suggestion, 200));

    await expect(
      clientWith(fetchMock).suggest(request, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).resolves.toMatchObject({ suggestion_id: SUGGESTION_ID });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("signs and strictly validates feedback on its exact path", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_785_326_460_000);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(feedback));
    const client = clientWith(fetchMock);
    const feedbackKey = createIdempotencyKey("feedback", SUGGESTION_ID, "agent-decision-1");

    const result = await client.recordFeedback(
      SUGGESTION_ID,
      {
        schema_version: 1,
        outcome: "confirmed",
        selected_detector_id: "duplicate_charge",
        actor: "agent",
      },
      { idempotencyKey: feedbackKey },
    );

    expect(result.feedback_id).toBe(feedback.feedback_id);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    const body = init.body as string;
    const timestamp = headers.get("X-Wordless-Timestamp") as string;
    const path = `/v1/suggestions/${SUGGESTION_ID}/feedback`;
    const expected = createHmac("sha256", SIGNING_SECRET)
      .update(`v1:${timestamp}\nPOST\n${path}\n${feedbackKey}\n`)
      .update(body)
      .digest("hex");
    expect(url).toBe(`https://api.wordless.example${path}`);
    expect(headers.get("X-Wordless-Signature")).toBe(`v1=${expected}`);
  });

  it("binds feedback success to the submitted human decision", async () => {
    const mismatched = {
      ...feedback,
      outcome: "none",
      selected_detector_id: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(mismatched));

    await expect(
      clientWith(fetchMock).recordFeedback(
        SUGGESTION_ID,
        {
          schema_version: 1,
          outcome: "confirmed",
          selected_detector_id: "duplicate_charge",
          actor: "agent",
        },
        { idempotencyKey: createIdempotencyKey("feedback", "bound-decision") },
      ),
    ).rejects.toThrow("does not match the submitted decision");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed response contracts and oversized bodies", async () => {
    const malformedFetch = vi.fn().mockResolvedValue(
      jsonResponse({ ...suggestion, candidates: [{ ...suggestion.candidates[0], evidence: [] }] }),
    );
    await expect(
      clientWith(malformedFetch).suggest(request, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).rejects.toBeInstanceOf(WordlessResponseError);

    const oversizedFetch = vi.fn().mockResolvedValue(
      jsonResponse(suggestion, 200, { "Content-Length": "2048" }),
    );
    await expect(
      clientWith(oversizedFetch, { maxResponseBytes: 1_024 }).suggest(request, {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toThrow("exceeded 1024 bytes");
    expect(oversizedFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects evidence indices outside the submitted request array", async () => {
    const outOfRange = structuredClone(suggestion);
    outOfRange.candidates[0]!.evidence[0]!.input_index = request.evidence.length;
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(outOfRange));

    await expect(
      clientWith(fetchMock).suggest(request, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).rejects.toThrow("does not map to the submitted request");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an in-range suggestion citation bound to the wrong normalized fact", async () => {
    const misbound = structuredClone(suggestion);
    misbound.candidates[0]!.evidence[0]!.source = "shipping";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(misbound));

    await expect(
      clientWith(fetchMock).suggest(request, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).rejects.toThrow("does not match the submitted evidence at input_index 0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid feedback before making a credentialed request", async () => {
    const fetchMock = vi.fn();
    const client = clientWith(fetchMock);
    await expect(
      client.recordFeedback(
        SUGGESTION_ID,
        {
          schema_version: 1,
          outcome: "none",
          selected_detector_id: "duplicate_charge",
          actor: "agent",
        } as never,
        { idempotencyKey: createIdempotencyKey("feedback", "bad-decision") },
      ),
    ).rejects.toBeInstanceOf(WordlessRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates chronology, evidence discriminators, uniqueness, and metadata locally", async () => {
    const fetchMock = vi.fn();
    const client = clientWith(fetchMock);

    const futureUtterance = structuredClone(request) as unknown as Record<string, unknown>;
    (futureUtterance.utterance as Record<string, unknown>).sent_at = "2026-07-25T12:01:00Z";
    await expect(
      client.suggest(futureUtterance as never, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).rejects.toThrow("cannot be after observed_at");

    const duplicateRef = structuredClone(request) as unknown as Record<string, unknown>;
    const duplicateEvidence = duplicateRef.evidence as Record<string, unknown>[];
    duplicateEvidence[1]!.ref = duplicateEvidence[0]!.ref;
    await expect(
      client.suggest(duplicateRef as never, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).rejects.toThrow("unique");

    const invalidEvidence = structuredClone(request) as unknown as Record<string, unknown>;
    (invalidEvidence.evidence as Record<string, unknown>[])[0]!.status = "refunded";
    await expect(
      client.suggest(invalidEvidence as never, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).rejects.toThrow("invalid for charge evidence");

    const invalidMetadata = structuredClone(request) as unknown as Record<string, unknown>;
    invalidMetadata.metadata = { ticket_id: BigInt(441) };
    await expect(
      client.suggest(invalidMetadata as never, { idempotencyKey: IDEMPOTENCY_KEY }),
    ).rejects.toThrow("JSON-compatible");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("server configuration and idempotency", () => {
  it.each([
    "http://api.wordless.example",
    "https://user:secret@api.wordless.example",
    "https://api.wordless.example/v1",
    "https://api.wordless.example/v1/..",
    "https://api.wordless.example?tenant=acme",
  ])("rejects unsafe API origin %s", (baseUrl) => {
    expect(() =>
      createWordlessClient({
        baseUrl,
        apiKey: API_KEY,
        signingSecret: SIGNING_SECRET,
      }),
    ).toThrow(WordlessConfigurationError);
  });

  it("allows HTTP only for loopback development", () => {
    expect(
      createWordlessClient({
        baseUrl: "http://127.0.0.1:8001/",
        apiKey: API_KEY,
        signingSecret: SIGNING_SECRET,
        fetch: vi.fn() as unknown as typeof fetch,
      }).baseUrl,
    ).toBe("http://127.0.0.1:8001");
  });

  it("allows explicitly opted-in private HTTP without allowing public HTTP", () => {
    expect(
      createWordlessClient({
        baseUrl: "http://wordless-api:8001",
        allowPrivateHttp: true,
        apiKey: API_KEY,
        signingSecret: SIGNING_SECRET,
        fetch: vi.fn() as unknown as typeof fetch,
      }).baseUrl,
    ).toBe("http://wordless-api:8001");
    expect(() => createWordlessClient({
      baseUrl: "http://8.8.8.8:8001",
      allowPrivateHttp: true,
      apiKey: API_KEY,
      signingSecret: SIGNING_SECRET,
    })).toThrow(WordlessConfigurationError);
    expect(() => createWordlessClient({
      baseUrl: "http://wordless-api:8001",
      apiKey: API_KEY,
      signingSecret: SIGNING_SECRET,
    })).toThrow(WordlessConfigurationError);
  });

  it("validates credentials before retaining them", () => {
    expect(() =>
      createWordlessClient({
        baseUrl: "https://api.wordless.example",
        apiKey: "not-a-live-key",
        signingSecret: SIGNING_SECRET,
      }),
    ).toThrow("live-key format");
    expect(() =>
      createWordlessClient({
        baseUrl: "https://api.wordless.example",
        apiKey: API_KEY,
        signingSecret: "too-short",
      }),
    ).toThrow("32–256");
  });

  it("creates deterministic, namespace-separated API-valid keys", () => {
    const first = createIdempotencyKey("suggestion", "tenant-1", "ticket-441");
    expect(first).toBe(createIdempotencyKey("suggestion", "tenant-1", "ticket-441"));
    expect(first).not.toBe(createIdempotencyKey("feedback", "tenant-1", "ticket-441"));
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u);
  });
});

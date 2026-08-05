// @vitest-environment node

import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  WordlessRequestError,
  WordlessResponseError,
  createSupportChatbotAdapter,
  createWordlessClient,
  parseChatAssistResponse,
  type WordlessChatAssistRequest,
  type WordlessEvidence,
} from "../src/server";

const API_KEY = "wl_live_acme.abcdefghijklmnopqrstuvwxyz012345";
const SIGNING_SECRET = "a-production-signing-secret-with-32-characters";
const SUGGESTION_ID = "sg_0123456789abcdef0123456789abcdef";
const EVIDENCE = [
  {
    type: "charge" as const,
    ref: "charge-1",
    occurred_at: "2026-07-25T11:00:00Z",
    order_ref: "order-441",
    amount: "84.00",
    currency: "USD",
    status: "succeeded" as const,
  },
  {
    type: "charge" as const,
    ref: "charge-2",
    occurred_at: "2026-07-25T11:06:00Z",
    order_ref: "order-441",
    amount: "84.00",
    currency: "USD",
    status: "succeeded" as const,
  },
] as const;
const SUMMARIES = [
  {
    ref: "ev_0123456789abcdef01234567",
    source: "billing",
    kind: "charge",
    input_index: 0,
    occurred_at: "2026-07-25T11:00:00Z",
    provenance: "exported",
  },
  {
    ref: "ev_89abcdef0123456789abcdef",
    source: "billing",
    kind: "charge",
    input_index: 1,
    occurred_at: "2026-07-25T11:06:00Z",
    provenance: "exported",
  },
] as const;
const POLICY = {
  detector_set_version: "det_0123456789abcdef",
  threshold_version: "pilot-v1",
  threshold: 1.6,
  score_kind: "ranking_not_probability",
  embedding_model_id: "sentence-transformers/all-MiniLM-L6-v2",
  embedding_model_revision: "1110a243fdf4706b3f48f1d95db1a4f5529b4d41",
} as const;
const LINKS = {
  self: `/v1/suggestions/${SUGGESTION_ID}`,
  events: `/v1/suggestions/${SUGGESTION_ID}/events`,
  feedback: `/v1/suggestions/${SUGGESTION_ID}/feedback`,
};

const chatRequest: WordlessChatAssistRequest = {
  schema_version: 1,
  external_event_id: "evt_ticket_441",
  observed_at: "2026-07-25T12:00:00Z",
  channel: "chat",
  customer_external_id: "customer-17",
  message: {
    sent_at: "2026-07-25T11:59:00Z",
    text: "money one twice",
  },
  assistance_mode: "auto",
  evidence: EVIDENCE,
  source_system: "support-backend",
  metadata: {},
};

const clarification = {
  schema_version: 1,
  suggestion_id: SUGGESTION_ID,
  status: "completed",
  outcome: "clarification_choices",
  integration: { host_action: "show_wordless", render_mode: "choices" },
  message: "Which option best matches what you need?",
  choices: [
    {
      id: "duplicate_charge",
      label: "Charged twice",
      reply: "I was charged twice for the same order.",
      detector_id: "duplicate_charge",
      evidence: SUMMARIES,
    },
    {
      id: "something_else",
      label: "Something else",
      reply: "I need help with something else.",
      detector_id: null,
      evidence: [],
    },
  ],
  detector_id: "duplicate_charge",
  evidence: SUMMARIES,
  reason: null,
  selection_basis: "evidence_and_message",
  review_required: true,
  read_only: true,
  processing_ms: 25,
  redaction_entity_counts: {},
  policy: POLICY,
  links: LINKS,
} as const;

const continueHostBot = {
  ...clarification,
  outcome: "clarifying_fallback",
  integration: { host_action: "continue_host_bot", render_mode: "none" },
  message: null,
  choices: [],
  detector_id: null,
  evidence: [],
  reason: "no_relevant_evidence",
  selection_basis: "none",
} as const;

const groundedReply = {
  ...clarification,
  outcome: "grounded_reply",
  integration: { host_action: "show_wordless", render_mode: "message" },
  message: "One completed USD 84.00 charge is recorded for order order-441.",
  choices: [],
  detector_id: null,
  evidence: [SUMMARIES[0]],
  reason: null,
  selection_basis: "grounded_state",
} as const;

const navigationChoices = {
  ...continueHostBot,
  integration: { host_action: "show_wordless", render_mode: "choices" },
  message: "Choose what you need help with.",
  choices: [
    {
      id: "payment_help",
      label: "Billing or charges",
      reply: "I need help with billing or a charge.",
      detector_id: null,
      evidence: [],
    },
    {
      id: "delivery_or_item",
      label: "Orders or delivery",
      reply: "I need help with an order or delivery.",
      detector_id: null,
      evidence: [],
    },
    {
      id: "account_access",
      label: "Account access",
      reply: "I need help getting into my account.",
      detector_id: null,
      evidence: [],
    },
  ],
  reason: "insufficient_context",
} as const;

const BINDING_CASES = [
  {
    name: "charge",
    evidence: EVIDENCE[0],
    source: "billing",
    kind: "charge",
  },
  {
    name: "shipment",
    evidence: {
      type: "shipment",
      ref: "shipment-1",
      occurred_at: "2026-07-25T11:00:00Z",
      order_ref: "order-441",
      status: "delayed",
      expected_delivery_at: "2026-07-25T11:30:00Z",
    },
    source: "shipping",
    kind: "shipment",
  },
  {
    name: "fulfillment",
    evidence: {
      type: "fulfillment",
      ref: "fulfillment-1",
      occurred_at: "2026-07-25T11:00:00Z",
      order_ref: "order-441",
      ordered_sku: "sku-ordered",
      delivered_sku: "sku-delivered",
      status: "wrong_item",
    },
    source: "orders",
    kind: "fulfillment",
  },
  {
    name: "account access",
    evidence: {
      type: "account_access",
      ref: "access-1",
      occurred_at: "2026-07-25T11:00:00Z",
      account_ref: "account-441",
      status: "locked",
      failed_attempts: 4,
    },
    source: "authentication",
    kind: "account",
  },
] as const satisfies readonly {
  name: string;
  evidence: WordlessEvidence;
  source: string;
  kind: string;
}[];

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function clientWith(fetchMock: ReturnType<typeof vi.fn>) {
  return createWordlessClient({
    baseUrl: "https://api.wordless.example",
    apiKey: API_KEY,
    signingSecret: SIGNING_SECRET,
    retryDelayMs: 0,
    fetch: fetchMock as unknown as typeof fetch,
  });
}

describe("chat-assist client", () => {
  it("signs, sends, and validates the adapter-neutral chat route", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_785_326_400_000);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(clarification, 201));
    const result = await clientWith(fetchMock).assist(chatRequest, {
      idempotencyKey: "chat-ticket-441-message-7",
    });

    expect(result.outcome).toBe("clarification_choices");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    const body = init.body as string;
    const timestamp = headers.get("X-Wordless-Timestamp") as string;
    const signature = createHmac("sha256", SIGNING_SECRET)
      .update(
        `v1:${timestamp}\nPOST\n/v1/chat/assist\nchat-ticket-441-message-7\n`,
      )
      .update(body)
      .digest("hex");
    expect(url).toBe("https://api.wordless.example/v1/chat/assist");
    expect(headers.get("X-Wordless-Signature")).toBe(`v1=${signature}`);
    expect(JSON.parse(body)).toEqual(chatRequest);
  });

  it("accepts an empty message only for the explicit show-choices path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(navigationChoices, 201));
    const client = clientWith(fetchMock);

    await expect(client.assist(
      { ...chatRequest, message: { ...chatRequest.message, text: "" } },
      { idempotencyKey: "chat-empty-auto-message-7" },
    )).rejects.toBeInstanceOf(WordlessRequestError);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(client.assist(
      {
        ...chatRequest,
        assistance_mode: "show_choices",
        message: { ...chatRequest.message, text: "" },
      },
      { idempotencyKey: "chat-show-choices-message-7" },
    )).resolves.toMatchObject({ outcome: "clarifying_fallback" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects inconsistent responses and citations outside submitted evidence", async () => {
    expect(() => parseChatAssistResponse({
      ...clarification,
      integration: { host_action: "continue_host_bot", render_mode: "none" },
    })).toThrow(WordlessResponseError);
    expect(() => parseChatAssistResponse({
      ...navigationChoices,
      choices: [{ ...navigationChoices.choices[0], detector_id: "duplicate_charge" }],
    })).toThrow(WordlessResponseError);

    const outsideSummary = { ...SUMMARIES[0], input_index: EVIDENCE.length };
    const outsideEvidence = [outsideSummary, SUMMARIES[1]];
    const outsideRequest = {
      ...clarification,
      evidence: outsideEvidence,
      choices: [
        { ...clarification.choices[0], evidence: outsideEvidence },
        clarification.choices[1],
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(outsideRequest, 201));
    await expect(clientWith(fetchMock).assist(chatRequest, {
      idempotencyKey: "chat-outside-evidence-7",
    })).rejects.toThrow("does not map to the submitted request");
  });

  it("accepts two ranked contextual evidence choices plus a safe escape", () => {
    const contextual = {
      ...clarification,
      selection_basis: "contextual_evidence_choices",
      choices: [
        clarification.choices[0],
        {
          id: "late_delivery",
          label: "My delivery is late",
          reply: "I need help with a late delivery.",
          detector_id: "late_delivery",
          evidence: [SUMMARIES[0]],
        },
        clarification.choices[1],
      ],
    } as const;

    expect(parseChatAssistResponse(contextual)).toMatchObject({
      selection_basis: "contextual_evidence_choices",
      choices: [
        { detector_id: "duplicate_charge" },
        { detector_id: "late_delivery" },
        { detector_id: null },
      ],
    });
  });

  it("accepts the narrowly grounded healthy-state reply shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(groundedReply, 201));
    await expect(clientWith(fetchMock).assist(chatRequest, {
      idempotencyKey: "chat-grounded-message-7",
    })).resolves.toMatchObject({
      outcome: "grounded_reply",
      detector_id: null,
      selection_basis: "grounded_state",
    });
  });

  it.each(BINDING_CASES)(
    "binds an in-range $name citation to its normalized service mapping",
    async ({ evidence, source, kind }) => {
      const summary = {
        ...SUMMARIES[0],
        source,
        kind,
        occurred_at: evidence.occurred_at,
      };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
        ...groundedReply,
        evidence: [summary],
      }, 201));
      await expect(clientWith(fetchMock).assist(
        { ...chatRequest, evidence: [evidence] },
        { idempotencyKey: `chat-binding-${evidence.type}-0001` },
      )).resolves.toMatchObject({ outcome: "grounded_reply" });
    },
  );

  it.each([
    ["source", "shipping"],
    ["kind", "shipment"],
    ["occurred_at", "2026-07-25T11:01:00Z"],
    ["provenance", "reconstructed"],
  ] as const)("rejects an in-range citation with a mismatched %s", async (field, value) => {
    const summaries = SUMMARIES.map((summary) => ({ ...summary }));
    summaries[0] = { ...summaries[0]!, [field]: value };
    const response = {
      ...clarification,
      evidence: summaries,
      choices: [
        { ...clarification.choices[0], evidence: summaries },
        clarification.choices[1],
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response, 201));
    await expect(clientWith(fetchMock).assist(chatRequest, {
      idempotencyKey: `chat-misbinding-${field}-0001`,
    })).rejects.toThrow("does not match the submitted evidence at input_index 0");
  });

  it("accepts minute-precision aware timestamps and normalizes equivalent offsets", async () => {
    const evidence = {
      ...EVIDENCE[0],
      occurred_at: "2026-07-25T12:00Z",
    };
    const response = {
      ...groundedReply,
      evidence: [{
        ...SUMMARIES[0],
        occurred_at: "2026-07-25T14:00:00.000+02:00",
      }],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response, 201));
    await expect(clientWith(fetchMock).assist({
      ...chatRequest,
      observed_at: "2026-07-25T12:00Z",
      message: { sent_at: "2026-07-25T12:00Z", text: "Was my charge completed?" },
      evidence: [evidence],
    }, {
      idempotencyKey: "chat-minute-aware-timestamp-0001",
    })).resolves.toMatchObject({ outcome: "grounded_reply" });
  });

  it("binds request fractions above six digits to Python microsecond serialization", async () => {
    const evidence = {
      ...EVIDENCE[0],
      occurred_at: "2026-07-25T11:00:00.123456789Z",
    };
    const response = {
      ...groundedReply,
      evidence: [{
        ...SUMMARIES[0],
        occurred_at: "2026-07-25T13:00:00.123456+02:00",
      }],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response, 201));
    await expect(clientWith(fetchMock).assist({
      ...chatRequest,
      evidence: [evidence],
    }, {
      idempotencyKey: "chat-microsecond-truncation-0001",
    })).resolves.toMatchObject({ outcome: "grounded_reply" });
  });

  it("rejects a non-equivalent microsecond citation after normalization", async () => {
    const evidence = {
      ...EVIDENCE[0],
      occurred_at: "2026-07-25T11:00:00.123456789Z",
    };
    const response = {
      ...groundedReply,
      evidence: [{
        ...SUMMARIES[0],
        occurred_at: "2026-07-25T11:00:00.123455Z",
      }],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response, 201));
    await expect(clientWith(fetchMock).assist({
      ...chatRequest,
      evidence: [evidence],
    }, {
      idempotencyKey: "chat-microsecond-mismatch-0001",
    })).rejects.toThrow("does not match the submitted evidence at input_index 0");
  });

  it("still rejects timezone-naive minute-precision timestamps locally", async () => {
    const fetchMock = vi.fn();
    await expect(clientWith(fetchMock).assist({
      ...chatRequest,
      observed_at: "2026-07-25T12:00",
      message: { sent_at: "2026-07-25T12:00", text: "Was my charge completed?" },
      evidence: [],
    }, {
      idempotencyKey: "chat-naive-timestamp-0001",
    })).rejects.toBeInstanceOf(WordlessRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("framework-neutral support chatbot adapter", () => {
  it("maps a detector result to choices with request evidence indexes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(clarification, 201));
    const bot = createSupportChatbotAdapter({
      client: clientWith(fetchMock),
      sourceSystem: "my-support-bot",
    });

    const turn = await bot.processMessage({
      messageId: "message from any host / 7",
      customerId: "customer-17",
      text: "money one twice",
      sentAt: "2026-07-25T12:00:00Z",
      evidence: EVIDENCE,
    });

    expect(turn).toMatchObject({
      kind: "clarification_choices",
      hostAction: "show_wordless",
      renderMode: "choices",
      suggestionId: SUGGESTION_ID,
      evidenceIndexes: [0, 1],
      choices: [
        { detectorId: "duplicate_charge", evidenceIndexes: [0, 1] },
        { detectorId: null, evidenceIndexes: [] },
      ],
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      assistance_mode: "auto",
      external_event_id: expect.stringMatching(/^chat-event-/u),
      message: { text: "money one twice" },
      source_system: "my-support-bot",
    });
    expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(/^chat-assist-/u);
  });

  it("scopes derived event and idempotency identities by customer", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(clarification, 201))
      .mockResolvedValueOnce(jsonResponse(clarification, 201));
    const bot = createSupportChatbotAdapter({
      client: clientWith(fetchMock),
      sourceSystem: "my-support-bot",
    });
    const shared = {
      messageId: "shared-message-id",
      text: "money one twice",
      sentAt: "2026-07-25T12:00:00Z",
      evidence: EVIDENCE,
    } as const;

    await bot.processMessage({ ...shared, customerId: "customer-a" });
    await bot.processMessage({ ...shared, customerId: "customer-b" });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const firstBody = JSON.parse(calls[0]![1].body as string) as Record<string, unknown>;
    const secondBody = JSON.parse(calls[1]![1].body as string) as Record<string, unknown>;
    expect(firstBody.external_event_id).not.toBe(secondBody.external_event_id);
    expect(new Headers(calls[0]![1].headers).get("Idempotency-Key")).not.toBe(
      new Headers(calls[1]![1].headers).get("Idempotency-Key"),
    );
  });

  it("returns an explicit continue instruction for an ordinary unsupported message", async () => {
    const bot = createSupportChatbotAdapter({
      client: clientWith(vi.fn().mockResolvedValue(jsonResponse(continueHostBot, 201))),
      sourceSystem: "my-support-bot",
    });
    await expect(bot.processMessage({
      messageId: "message-8",
      customerId: "customer-17",
      text: "How do I change my notification settings?",
      sentAt: "2026-07-25T12:00:00Z",
    })).resolves.toEqual(expect.objectContaining({
      kind: "clarifying_fallback",
      hostAction: "continue_host_bot",
      renderMode: "none",
      message: null,
    }));
  });

  it("maps a directly entailed healthy state to a read-only message turn", async () => {
    const bot = createSupportChatbotAdapter({
      client: clientWith(vi.fn().mockResolvedValue(jsonResponse(groundedReply, 201))),
      sourceSystem: "my-support-bot",
    });
    await expect(bot.processMessage({
      messageId: "message-healthy-1",
      customerId: "customer-17",
      text: "Was my charge completed?",
      sentAt: "2026-07-25T12:00:00Z",
      evidence: EVIDENCE,
    })).resolves.toEqual(expect.objectContaining({
      kind: "grounded_reply",
      hostAction: "show_wordless",
      renderMode: "message",
      detectorId: null,
      evidenceIndexes: [0],
    }));
  });

  it("supports a universal show-choices button with no typed message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(navigationChoices, 201));
    const bot = createSupportChatbotAdapter({
      client: clientWith(fetchMock),
      sourceSystem: "my-support-bot",
    });
    const turn = await bot.processMessage({
      messageId: "message-9",
      customerId: "customer-17",
      text: "",
      sentAt: "2026-07-25T12:00:00Z",
      showChoices: true,
    });

    expect(turn).toMatchObject({
      kind: "clarifying_fallback",
      hostAction: "show_wordless",
      renderMode: "choices",
      choices: [
        { id: "payment_help", detectorId: null },
        { id: "delivery_or_item", detectorId: null },
        { id: "account_access", detectorId: null },
      ],
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      assistance_mode: "show_choices",
      message: { text: "" },
    });
  });

  it("records a selected detector or an unbacked/none choice", async () => {
    const confirmedFeedback = {
      schema_version: 1,
      feedback_id: "fb_0123456789abcdef0123456789abcdef",
      suggestion_id: SUGGESTION_ID,
      recorded: true,
      outcome: "confirmed",
      selected_detector_id: "duplicate_charge",
      actor: "customer",
      recorded_at: "2026-07-25T12:01:00Z",
    };
    const noneFeedback = {
      ...confirmedFeedback,
      feedback_id: "fb_89abcdef0123456789abcdef01234567",
      outcome: "none",
      selected_detector_id: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(confirmedFeedback, 201))
      .mockResolvedValueOnce(jsonResponse(noneFeedback, 201));
    const bot = createSupportChatbotAdapter({
      client: clientWith(fetchMock),
      sourceSystem: "my-support-bot",
    });

    await bot.recordConfirmation({
      suggestionId: SUGGESTION_ID,
      selectedDetectorId: "duplicate_charge",
      actor: "customer",
      decisionId: "customer-click-1",
    });
    await bot.recordConfirmation({
      suggestionId: SUGGESTION_ID,
      selectedDetectorId: null,
      actor: "customer",
      decisionId: "customer-click-2",
    });

    const firstBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const secondBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(firstBody).toMatchObject({
      outcome: "confirmed",
      selected_detector_id: "duplicate_charge",
    });
    expect(secondBody).toMatchObject({ outcome: "none", selected_detector_id: null });
  });
});

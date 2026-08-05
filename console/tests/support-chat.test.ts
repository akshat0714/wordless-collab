import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adaptSupportChatResponse } from "../lib/support-chat-adapter.ts";
import {
  hasBackedSupportChoice,
  parseSupportChatRequest,
  parseSupportChatResponse,
} from "../lib/support-chat-schema.ts";
import { parseUpstreamChatAssistResponse } from "../lib/support-chat-upstream.ts";
import {
  buildSupportAssistRequest,
  supportAssistEvidenceCount,
} from "../lib/support-demo-request.ts";
import { fetchProductWithSafeRetry } from "../lib/live-product-retry.ts";
import {
  isExplicitHumanSupportRequest,
  resolveKnownSupportMessage,
  unresolvedSupportMessage,
} from "../lib/support-normal-resolver.ts";
import { supportScenarios } from "../lib/support-scenarios.ts";
import {
  createPublicDemoSupportResponse,
  publicSupportDemoEnabled,
} from "../lib/support-public-demo.ts";

const requestId = "019f98c8-59fa-7f61-9aee-ba5f3cb7ca2a";
const conversationId = "119f98c8-59fa-7f61-9aee-ba5f3cb7ca2b";
const suggestionId = "sg_0123456789abcdef0123456789abcdef";
const upstreamOptions = { inputEvidenceCount: 2 } as const;

function request(action: "message" | "show_choices" = "message") {
  return {
    schema_version: 1,
    request_id: requestId,
    conversation_id: conversationId,
    observed_at: "2026-07-25T12:00:00+00:00",
    scenario_id: "duplicate_charge",
    action,
    message: action === "message" ? "Money went out twice." : "",
  };
}

function evidence(index = 0, ref = "ev_0123456789abcdef01234567") {
  return {
    input_index: index,
    ref,
    source: "billing",
    kind: "charge",
    occurred_at: "2026-07-25T11:58:00+00:00",
    provenance: "exported",
  };
}

function upstreamResponse() {
  return {
    schema_version: 1,
    suggestion_id: suggestionId,
    status: "completed",
    outcome: "clarification_choices",
    integration: { host_action: "show_wordless", render_mode: "choices" },
    message: "Did you mean this?",
    choices: [
      {
        id: "confirm_duplicate_charge",
        label: "I was charged twice",
        reply: "I need help with two charges for one order.",
        detector_id: "duplicate_charge",
        evidence: [evidence()],
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
    evidence: [evidence()],
    reason: null,
    selection_basis: "evidence_and_message",
    review_required: true,
    read_only: true,
    processing_ms: 18,
    redaction_entity_counts: {},
    policy: {
      detector_set_version: "det_0123456789abcdef",
      threshold_version: "demo-floor-v1",
      threshold: 1.6,
      score_kind: "ranking_not_probability",
      embedding_model_id: "sentence-transformers/all-MiniLM-L6-v2",
      embedding_model_revision: "1110a243fdf4706b3f48f1d95db1a4f5529b4d41",
    },
    links: {
      self: `/v1/suggestions/${suggestionId}`,
      events: `/v1/suggestions/${suggestionId}/events`,
      feedback: `/v1/suggestions/${suggestionId}/feedback`,
    },
  };
}

function visibleFallbackResponse() {
  return {
    ...upstreamResponse(),
    outcome: "clarifying_fallback",
    integration: { host_action: "show_wordless", render_mode: "choices" },
    message: "Choose what you need help with.",
    choices: [
      {
        id: "payment_help",
        label: "Payment",
        reply: "I need help with a payment.",
        detector_id: null,
        evidence: [],
      },
      {
        id: "delivery_or_item",
        label: "Delivery or item",
        reply: "I need help with a delivery or item.",
        detector_id: null,
        evidence: [],
      },
    ],
    detector_id: null,
    evidence: [],
    reason: "no_relevant_evidence",
    selection_basis: "none",
  };
}

function messageFallbackResponse() {
  return {
    ...visibleFallbackResponse(),
    integration: { host_action: "show_wordless", render_mode: "message" },
    message: "Please tell me which order you mean.",
    choices: [],
  };
}

function groundedResponse() {
  return {
    ...upstreamResponse(),
    outcome: "grounded_reply",
    integration: { host_action: "show_wordless", render_mode: "message" },
    message: "The latest supplied account record says access is active.",
    choices: [],
    detector_id: null,
    evidence: [evidence()],
    reason: null,
    selection_basis: "grounded_state",
  };
}

function continuationResponse() {
  return {
    ...visibleFallbackResponse(),
    integration: { host_action: "continue_host_bot", render_mode: "none" },
    message: null,
    choices: [],
  };
}

describe("support chat contracts", () => {
  it("accepts ordinary text and an explicit empty show-choices request", () => {
    assert.equal(parseSupportChatRequest(request()).message, "Money went out twice.");
    assert.equal(parseSupportChatRequest(request("show_choices")).message, "");
    assert.throws(
      () => parseSupportChatRequest({ ...request(), message: "" }),
      /requires text|invalid/,
    );
    assert.throws(
      () => parseSupportChatRequest({ ...request(), message: "x".repeat(501) }),
      /invalid/,
    );
  });

  it("strictly validates a reviewed Wordless clarification", () => {
    const parsed = parseSupportChatResponse({
      schema_version: 1,
      request_id: requestId,
      reply_id: "reply_0123456789abcdef0123456789abcdef",
      kind: "clarification_choices",
      response_source: "wordless",
      message: "Did you mean one of these?",
      choices: [
        {
          id: "confirm_duplicate_charge",
          detector_id: "duplicate_charge",
          label: "I was charged twice",
          detail: "I need help with two charges.",
          evidence_label: "2 synthetic account records support this choice",
        },
        {
          id: "something_else",
          detector_id: null,
          label: "None of these",
          detail: "I need help with something else.",
          evidence_label: null,
        },
      ],
      review_required: true,
      suggestion_id: suggestionId,
    });
    assert.equal(parsed.response_source, "wordless");
    assert.equal(parsed.choices[1]?.detector_id, null);
  });

  it("accepts two ranked evidence choices plus a safe escape", () => {
    const secondEvidence = evidence(1, "ev_1123456789abcdef01234567");
    const raw = upstreamResponse();
    raw.selection_basis = "contextual_evidence_choices";
    raw.choices = [
      raw.choices[0]!,
      {
        id: "confirm_late_delivery",
        label: "My delivery is late",
        reply: "I need help with a late delivery.",
        detector_id: "late_delivery",
        evidence: [secondEvidence],
      },
      raw.choices[1]!,
    ];
    const parsed = parseUpstreamChatAssistResponse(raw, upstreamOptions);
    assert.equal(parsed.selection_basis, "contextual_evidence_choices");
    assert.deepEqual(parsed.choices.map((choice) => choice.detector_id), [
      "duplicate_charge",
      "late_delivery",
      null,
    ]);
    const adapted = adaptSupportChatResponse(parseSupportChatRequest(request()), parsed);
    assert.equal(adapted.choices.length, 3);
    assert.equal(adapted.choices[1]?.evidence_label, "1 synthetic account record supports this choice");
  });

  it("distinguishes a reviewed Wordless grounded reply from a host-bot reply", () => {
    const wordless = parseSupportChatResponse({
      schema_version: 1,
      request_id: requestId,
      reply_id: "reply_0123456789abcdef0123456789abcdef",
      kind: "grounded_reply",
      response_source: "wordless",
      message: "The latest supplied account record says access is active.",
      choices: [],
      review_required: true,
      suggestion_id: suggestionId,
    });
    const host = parseSupportChatResponse({
      schema_version: 1,
      request_id: requestId,
      reply_id: "reply_1123456789abcdef0123456789abcdef",
      kind: "grounded_reply",
      response_source: "host_bot",
      message: "Hi. What do you need?",
      choices: [],
      review_required: false,
      suggestion_id: null,
    });
    assert.equal(wordless.review_required, true);
    assert.equal(wordless.suggestion_id, suggestionId);
    assert.equal(host.review_required, false);
    assert.equal(host.suggestion_id, null);
  });

  it("marks a synthetic public response as non-persistent and not reviewed", () => {
    const parsed = parseSupportChatResponse({
      schema_version: 1,
      request_id: requestId,
      reply_id: "reply_0123456789abcdef0123456789abcdef",
      kind: "clarification_choices",
      response_source: "synthetic_demo",
      message: "Does this match the synthetic account evidence?",
      choices: [
        {
          id: "confirm_duplicate_charge",
          detector_id: "duplicate_charge",
          label: "Charged twice",
          detail: "I was charged twice for the same order.",
          evidence_label: "2 synthetic account records support this choice",
        },
        {
          id: "something_else",
          detector_id: null,
          label: "None of these",
          detail: "I need help with something else.",
          evidence_label: null,
        },
      ],
      review_required: false,
      suggestion_id: null,
    });
    assert.equal(parsed.response_source, "synthetic_demo");
    assert.equal(parsed.review_required, false);
    assert.equal(parsed.suggestion_id, null);

    assert.throws(
      () => parseSupportChatResponse({ ...parsed, review_required: true }),
      /disagree/,
    );
    assert.throws(
      () => parseSupportChatResponse({ ...parsed, suggestion_id: suggestionId }),
      /disagree/,
    );
    assert.throws(
      () => parseSupportChatResponse({ ...parsed, response_source: "wordless" }),
      /disagree/,
    );
  });

  it("allows reviewed Wordless navigation choices and message-only fallbacks", () => {
    const base = {
      schema_version: 1,
      request_id: requestId,
      reply_id: "reply_0123456789abcdef0123456789abcdef",
      kind: "clarifying_fallback",
      response_source: "wordless",
      review_required: true,
      suggestion_id: suggestionId,
    };
    const choices = [
      {
        id: "payment_help",
        detector_id: null,
        label: "Payment",
        detail: "I need help with a payment.",
        evidence_label: null,
      },
      {
        id: "account_access",
        detector_id: null,
        label: "Sign-in or account",
        detail: "I need help signing in.",
        evidence_label: null,
      },
    ];
    assert.equal(
      parseSupportChatResponse({
        ...base,
        message: "Choose what you need help with.",
        choices,
      }).choices.length,
      2,
    );
    assert.equal(hasBackedSupportChoice(choices), false);
    assert.equal(
      parseSupportChatResponse({
        ...base,
        message: "Please tell me which order you mean.",
        choices: [],
      }).choices.length,
      0,
    );
    assert.throws(
      () => parseSupportChatResponse({ ...base, message: "Choose.", choices: [choices[0]] }),
      /disagree/,
    );
  });

  it("rejects unknown browser fields and crossed source boundaries", () => {
    assert.throws(
      () => parseSupportChatRequest({ ...request(), extra: true }),
      /invalid shape/,
    );
    assert.throws(
      () =>
        parseSupportChatResponse({
          schema_version: 1,
          request_id: requestId,
          reply_id: "reply_0123456789abcdef0123456789abcdef",
          kind: "grounded_reply",
          response_source: "host_bot",
          message: "Hello.",
          choices: [],
          review_required: true,
          suggestion_id: suggestionId,
        }),
      /disagree/,
    );
  });

  it("strictly parses and adapts backend directives before their outcome payload", () => {
    const clarification = parseUpstreamChatAssistResponse(upstreamResponse(), upstreamOptions);
    const clarificationTurn = adaptSupportChatResponse(
      parseSupportChatRequest(request()),
      clarification,
    );
    assert.equal(clarificationTurn.response_source, "wordless");
    assert.equal(clarificationTurn.choices[1]?.label, "None of these");
    assert.equal(hasBackedSupportChoice(clarificationTurn.choices), true);

    const host = adaptSupportChatResponse(
      parseSupportChatRequest({ ...request(), message: "hello" }),
      parseUpstreamChatAssistResponse(continuationResponse(), upstreamOptions),
    );
    assert.equal(host.response_source, "host_bot");
    assert.equal(host.suggestion_id, null);
    assert.match(host.message, /billing/);
  });

  it("preserves review metadata on grounded and message-only Wordless replies", () => {
    for (const raw of [groundedResponse(), messageFallbackResponse()]) {
      const turn = adaptSupportChatResponse(
        parseSupportChatRequest(request()),
        parseUpstreamChatAssistResponse(raw, upstreamOptions),
      );
      assert.equal(turn.response_source, "wordless");
      assert.equal(turn.review_required, true);
      assert.equal(turn.suggestion_id, suggestionId);
      assert.equal(turn.choices.length, 0);
    }
  });

  it("requires exactly 2–3 unbacked choices on a visible backend fallback", () => {
    assert.equal(
      parseUpstreamChatAssistResponse(visibleFallbackResponse(), upstreamOptions).choices.length,
      2,
    );
    const oneChoice = { ...visibleFallbackResponse(), choices: [visibleFallbackResponse().choices[0]] };
    assert.throws(
      () => parseUpstreamChatAssistResponse(oneChoice, upstreamOptions),
      /fallback fields disagree/,
    );
    const fallback = visibleFallbackResponse();
    const backed = {
      ...fallback,
      choices: [
        {
          ...fallback.choices[0]!,
          detector_id: "duplicate_charge",
          evidence: [evidence()],
        },
        fallback.choices[1]!,
      ],
    };
    assert.throws(
      () => parseUpstreamChatAssistResponse(backed, upstreamOptions),
      /fallback fields disagree/,
    );
  });

  it("binds every upstream evidence index to the exact request evidence array", () => {
    const valid = upstreamResponse();
    valid.evidence = [evidence(1)];
    valid.choices[0]!.evidence = [evidence(1)];
    assert.equal(
      parseUpstreamChatAssistResponse(valid, upstreamOptions).evidence[0]?.input_index,
      1,
    );

    const outOfRange = upstreamResponse();
    outOfRange.evidence = [evidence(2)];
    outOfRange.choices[0]!.evidence = [evidence(2)];
    assert.throws(
      () => parseUpstreamChatAssistResponse(outOfRange, upstreamOptions),
      /outside the supplied evidence array/,
    );

    const duplicate = upstreamResponse();
    const repeated = [
      evidence(0),
      evidence(0, "ev_1123456789abcdef01234567"),
    ];
    duplicate.evidence = repeated;
    duplicate.choices[0]!.evidence = repeated;
    assert.throws(
      () => parseUpstreamChatAssistResponse(duplicate, upstreamOptions),
      /duplicate input_index/,
    );
  });

  it("builds each synthetic evidence shape with its declared exact count", () => {
    const types = [
      ["full_account", "charge", 5],
      ["duplicate_charge", "charge", 2],
      ["late_delivery", "shipment", 1],
      ["wrong_item", "fulfillment", 1],
      ["account_locked", "account_access", 1],
    ] as const;
    for (const [scenario_id, expectedType, expectedCount] of types) {
      const parsedRequest = parseSupportChatRequest({
        ...request("show_choices"),
        scenario_id,
      });
      const body = JSON.parse(buildSupportAssistRequest(parsedRequest)) as {
        assistance_mode: string;
        message: { text: string };
        evidence: Array<{ type: string }>;
      };
      assert.equal(body.assistance_mode, "show_choices");
      assert.equal(body.message.text, "");
      assert.equal(body.evidence.length, expectedCount);
      assert.equal(supportAssistEvidenceCount(parsedRequest), expectedCount);
      assert.equal(body.evidence[0]?.type, expectedType);
    }
  });

  it("enables the public simulation in production or by explicit local opt-in", () => {
    assert.equal(publicSupportDemoEnabled({ NODE_ENV: "production" }), true);
    assert.equal(
      publicSupportDemoEnabled({ NODE_ENV: "production", WORDLESS_PUBLIC_DEMO: "0" }),
      true,
    );
    assert.equal(
      publicSupportDemoEnabled({ NODE_ENV: "development", WORDLESS_PUBLIC_DEMO: "1" }),
      true,
    );
    assert.equal(
      publicSupportDemoEnabled({ NODE_ENV: "test", WORDLESS_PUBLIC_DEMO: " TRUE " }),
      true,
    );
    assert.equal(publicSupportDemoEnabled({ NODE_ENV: "development" }), false);
    assert.equal(
      publicSupportDemoEnabled({ NODE_ENV: "development", WORDLESS_PUBLIC_DEMO: "yes" }),
      false,
    );
  });

  it("returns one evidence-backed, non-persistent choice for every synthetic scenario", () => {
    const expectations = [
      ["duplicate_charge", "Money went out two times. Same order.", "duplicate_charge", 2],
      ["late_delivery", "Package not here. It should be here.", "late_delivery", 1],
      ["wrong_item", "The thing in the box is not what I picked.", "wrong_item", 1],
      ["account_locked", "Can't get in. It stops me.", "account_lock", 1],
    ] as const;

    for (const [scenario_id, message, detectorId, evidenceCount] of expectations) {
      const input = parseSupportChatRequest({ ...request(), scenario_id, message });
      const first = createPublicDemoSupportResponse(input);
      const second = createPublicDemoSupportResponse(input);
      assert.deepEqual(second, first);
      assert.equal(first.response_source, "synthetic_demo");
      assert.equal(first.review_required, false);
      assert.equal(first.suggestion_id, null);
      assert.equal(first.kind, "clarification_choices");
      assert.equal(first.choices.length, 2);
      assert.equal(first.choices[0]?.detector_id, detectorId);
      assert.equal(first.choices[1]?.detector_id, null);
      assert.match(first.choices[0]?.evidence_label ?? "", new RegExp(`^${evidenceCount} synthetic`));
    }
  });

  it("uses the full synthetic account as one open conversation", () => {
    const examples = [
      ["mney twcie", "duplicate_charge"],
      ["pakg no com", "late_delivery"],
      ["thing box difrent", "wrong_item"],
      ["cant in acount", "account_lock"],
    ] as const;
    for (const [message, detectorId] of examples) {
      const result = createPublicDemoSupportResponse(parseSupportChatRequest({
        ...request(),
        scenario_id: "full_account",
        message,
      }));
      assert.equal(result.kind, "clarification_choices", message);
      assert.equal(result.choices[0]?.detector_id, detectorId, message);
      assert.equal(result.choices.at(-1)?.detector_id, null, message);
    }

    const fallback = createPublicDemoSupportResponse(parseSupportChatRequest({
      ...request("show_choices"),
      scenario_id: "full_account",
    }));
    assert.equal(fallback.choices.length, 3);
    assert.equal(fallback.choices.filter((choice) => choice.detector_id !== null).length, 2);
  });

  it("uses scenario evidence for an empty Show me choices turn", () => {
    for (const scenario_id of [
      "full_account",
      "duplicate_charge",
      "late_delivery",
      "wrong_item",
      "account_locked",
    ] as const) {
      const input = parseSupportChatRequest({ ...request("show_choices"), scenario_id });
      const result = createPublicDemoSupportResponse(input);
      assert.equal(result.response_source, "synthetic_demo");
      assert.equal(result.kind, "clarification_choices");
      assert.equal(hasBackedSupportChoice(result.choices), true);
      assert.equal(result.review_required, false);
      assert.equal(result.suggestion_id, null);
    }
  });

  it("continues with the ordinary host bot for unrelated or mismatched messages", () => {
    const inputs = [
      { scenario_id: "duplicate_charge", message: "hello" },
      { scenario_id: "late_delivery", message: "I need a receipt" },
      { scenario_id: "wrong_item", message: "Can I talk to a person?" },
      { scenario_id: "account_locked", message: "purple river yesterday" },
      { scenario_id: "duplicate_charge", message: "My package has not arrived" },
    ] as const;
    for (const fields of inputs) {
      const result = createPublicDemoSupportResponse(
        parseSupportChatRequest({ ...request(), ...fields }),
      );
      assert.equal(result.response_source, "host_bot");
      assert.equal(result.review_required, false);
      assert.equal(result.suggestion_id, null);
      assert.equal(result.choices.length, 0);
    }
  });

  it("retries once with the exact same body, key, and signature", async () => {
    const calls: Array<{ body: BodyInit | null | undefined; headers: Headers }> = [];
    const fakeFetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ body: init?.body, headers: new Headers(init?.headers) });
      return calls.length === 1
        ? new Response('{"error":"temporary"}', { status: 503 })
        : new Response('{"ok":true}', {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
    }) as typeof globalThis.fetch;
    const body = '{"message":"same bytes"}';
    const response = await fetchProductWithSafeRetry({
      target: new URL("https://wordless.example/v1/chat/assist"),
      requestSignal: new AbortController().signal,
      timeoutMs: 1_000,
      retryOnce: true,
      fetchImplementation: fakeFetch,
      init: {
        method: "POST",
        body,
        headers: {
          "Idempotency-Key": "console-chat:stable-request-id",
          "X-Wordless-Timestamp": "1785015000",
          "X-Wordless-Signature": "v1=abc123",
        },
      },
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.body), [body, body]);
    assert.deepEqual(
      calls.map((call) => call.headers.get("idempotency-key")),
      ["console-chat:stable-request-id", "console-chat:stable-request-id"],
    );
    assert.deepEqual(
      calls.map((call) => call.headers.get("x-wordless-signature")),
      ["v1=abc123", "v1=abc123"],
    );
  });

  it("keeps the retry bounded and does not retry a non-transient response", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response('{"error":"invalid"}', { status: 400 });
    }) as typeof globalThis.fetch;
    const response = await fetchProductWithSafeRetry({
      target: new URL("https://wordless.example/v1/chat/assist"),
      requestSignal: new AbortController().signal,
      timeoutMs: 1_000,
      retryOnce: true,
      fetchImplementation: fakeFetch,
      init: { method: "POST", body: "{}" },
    });
    assert.equal(response.status, 400);
    assert.equal(calls, 1);
  });

  it("keeps host-bot copy narrow and makes no handoff claim", () => {
    assert.match(resolveKnownSupportMessage("hello")?.message ?? "", /billing/);
    assert.match(resolveKnownSupportMessage("I need an invoice")?.message ?? "", /receipt/);
    assert.match(resolveKnownSupportMessage("I want to return this")?.message ?? "", /return/);
    assert.match(resolveKnownSupportMessage("What are your support hours?")?.message ?? "", /available/);
    assert.match(resolveKnownSupportMessage("Where is my package?")?.message ?? "", /tracking/);
    assert.match(resolveKnownSupportMessage("I forgot my password")?.message ?? "", /verified email/);
    assert.match(resolveKnownSupportMessage("My card was declined")?.message ?? "", /billing address/);
    assert.match(resolveKnownSupportMessage("Cancel my subscription")?.message ?? "", /cancellation/);
    assert.match(resolveKnownSupportMessage("I need to change my address")?.message ?? "", /shipped/);
    assert.match(resolveKnownSupportMessage("My item is broken")?.message ?? "", /warranty/);
    assert.match(resolveKnownSupportMessage("My promo code failed")?.message ?? "", /checkout/);
    assert.match(resolveKnownSupportMessage("Delete my account")?.message ?? "", /confirm identity/);
    assert.match(resolveKnownSupportMessage("Can I talk to a person?")?.message ?? "", /not contacted/);
    assert.match(resolveKnownSupportMessage("I need a human to cancel my order")?.message ?? "", /not contacted/);
    assert.match(resolveKnownSupportMessage("I need a support person.")?.message ?? "", /not contacted/);
    for (const message of [
      "I need a human to cancel my order",
      "I need a support person.",
      "I would like a support agent.",
      "Can I be connected to a representative?",
      "Could you put me through to a live agent?",
      "Can I speak to an operator?",
      "Please escalate this to a supervisor.",
      "Can I speak with someone?",
      "I need a manager",
      "Please let me talk to a real person",
      "Let me talk to a person",
      "Can I speak to your supervisor?",
      "Is there a human I can talk to?",
      "A real person would be better",
      "Can I talk to support?",
      "plese humna",
      "need humen",
      "tak to persn",
      "want agnet",
      "manger plese",
      "represntative please",
      "plz humna",
      "humn pls",
      "humna plz",
      "persn pls",
      "agent pls",
      "spk to human",
      "I'm asking for a manager",
      "I am requesting a supervisor",
      "Send me to a person",
      "Give me a human",
      "Please have a human call me",
      "Can someone help me?",
      "Can I talk to somebody?",
      "A human should take over",
      "Can someone please help me?",
      "a live human",
      "human help",
      "I need help from a human",
      "Can I speak to a different agent?",
      "I don't want a bot, just a human",
      "I don't want a bot and just want a human",
      "uman pls",
      "mgr pls",
      "need mangr",
      "hlp human",
      "Can't I speak to a human?",
      "Why can't I talk to a person?",
      "I can't get through to a person",
      "No I want a human",
      "I do not want a bot I want a human",
      "Can I not talk to the bot and get a human?",
      "Can I speak to another agent?",
      "Can I talk to customer support?",
      "Talk to a team member",
      "Actual human please",
      "A human being please",
      "Human assistance please",
      "Please escalate this",
      "Hand me off",
      "Let the human take over",
      "human hlp",
      "humna hlp",
      "persn hlp",
      "wnt humna",
      "I used to want a bot. Now I need a human",
      "I never asked for an agent. Please connect me to a person now",
      "Do I need a human? Actually connect me to a manager",
      "I need someone to deliver my order, but now connect me to an agent",
      "Transfer me",
      "Put me through",
      "Can I be transferred?",
      "human need",
      "humna need",
      "persn talk",
      "agent want",
      "manger need",
      "I don't want a bot and want a human",
      "I don't want to keep talking to a bot—connect me to a person",
      "I don't want a bot: connect me to a human",
      "I don't want a bot - connect me to a human",
      "I don't want a bot / connect me to a human",
      "I need a human because the bot is broken",
      "I want the bot to connect me to a person",
      "The bot can't connect me to a human",
      "I never said: I want a human. Connect me to a manager now",
      "Can you transfer me?",
      "I want to be transferred",
      "Pass me to a person",
      "Route me to an agent",
      "Forward me to support",
      "Can I speak to a member of your team?",
      "Can I speak to the customer service team?",
      "Can I speak to someone else?",
      "human connect",
      "humna transfer",
      "persn connect me",
      "I want a human. No, not the bot.",
      "Human please. No, don't keep the bot.",
      "Can you please transfer me?",
      "Could you put me through?",
      "Can you hand me off?",
      "Could you escalate this?",
      "I want you to transfer me",
      "I need to be transferred now.",
      "Please connect me now.",
      "Please transfer me right now.",
      "Connect me to a manager anyway.",
      "Can I speak to an advisor?",
      "Can I speak to a specialist?",
      "Can I speak to a member of staff?",
      "I need a human to guide me.",
      "I want an agent to email me.",
      "I need a person to verify my account.",
      "I need someone to open a ticket.",
      "Why can't you connect me to a human?",
      "This won't let me talk to a human.",
      "human send me",
      "person need help",
      "agen pls",
      "I never said: I want a human; now connect me to a manager.",
      "I never said: I want a human, please connect me to a manager now.",
      "I never said: I want a human, and now connect me to a manager.",
      "I need someone to send me the form.",
      "I would like you to put me through.",
      "Can I get transferred?",
      "Could I be put through?",
      "Could you forward me?",
      "Can you route me?",
      "Can I talk to a customer care agent?",
      "Can I talk to an agent on your team?",
      "Can I speak to a person from support?",
      "I need an agent to schedule an appointment.",
      "I need a human to authorize this.",
      "I need someone to walk me through this.",
      "I need a person to complete the refund.",
      "I need an agent to escalate this.",
      "I need someone to resend the email.",
      "I need someone to add a note.",
      "advser pls",
      "hmn pls",
      "transfr me",
      "put me thru",
      "I never said I wanted a human. Connect me to one now.",
      "I wasn't asking for a human before, but I am now.",
      "I need to escalate this",
      "Can you hand this chat off?",
      "Would you escalate the chat?",
      "Could you transfer this chat?",
      "I need you to put me through",
      "I want you to hand me off",
      "I would like you to escalate this",
      "I want this escalated",
      "person get",
      "agent give",
      "manager ask",
      "human can connect",
      "humon pls",
      "peerson pls",
      "maneger pls",
      "represenative pls",
      "opertor pls",
      "person get me",
      "send human me",
      "me human help",
      "I want to be put through.",
      "Can somebody step in?",
      "Please get someone involved.",
      "Bring in a person.",
      "Can I speak to an associate?",
      "Can I talk to an employee?",
      "speclist plz",
      "agent step in",
      "I never said: I want a human — now connect me to a manager.",
      "Could you pass me on?",
      "Can you bring in a human?",
      "Please loop in an agent.",
      "I need this handed off.",
      "I want the chat transferred.",
      "Can I talk to a service rep?",
      "Could this be escalated?",
      "I need this conversation escalated",
      "person get help",
    ]) assert.equal(isExplicitHumanSupportRequest(message), true, message);
    for (const message of [
      "I do not want to talk to a person.",
      "Do not transfer me to an agent.",
      "I need to update the delivery person instructions.",
      "I need customer service hours.",
      "The delivery person left my package",
      "I never said I want a human",
      "I didn’t say I want a human",
      "I’m not asking for an agent",
      "Please contact the person who delivered it",
      "I need the person who delivered my package",
      "dont conect me humna",
      "dont trasnfer humna",
      "dnt transfer human",
      "never sed want human",
      "didnt sy want humna",
      "task manager",
      "contract manager",
      "please be humane",
      "manage please",
      "I want to manage",
      "I no longer want a human",
      "I used to want a human",
      "I don't think I need a human",
      "I don't really want a human",
      "I did not tell you I want a human",
      "Do I need a human?",
      "Why do I need a human?",
      "Do you want a person?",
      "If I want a human, what happens?",
      "I used to really want a human",
      "I never said: I want a human",
      "I never said, I want a human",
      "I never said - I want a human",
      "I never said / I want a human",
      "I need someone to deliver my order",
      "I want a person to bring my package",
      "Why would I want a human?",
      "Did I ask for a human?",
      "Who said I want a human?",
      "Do I still want a human?",
      "I cannot talk to a human because I prefer the bot",
      "I can't reach a human because I don't want one",
      "Don't let the bot transfer me to an agent",
      "I don't want the chatbot to transfer me to an agent",
      "No bot should transfer me to a human",
      "I need someone to pick up my return",
      "I need someone to collect my return",
      "I need a person to sign for my package",
      "I want an agent to take my parcel",
      "Connect me to a human. Actually, do not transfer me.",
      "I want a human—wait, no",
      "Talk to a person—no, keep the bot",
      "Human please, actually never mind",
      "I can't reach a person; don't transfer me",
      "Did I say I want a human?",
      "Are you saying I need a human?",
      "Am I asking for a manager?",
      "Should I ask for a human?",
      "Would a human help?",
      "When do I need a human?",
      "What if I need a human?",
      "I used to desperately want a human",
      "Earlier I said I want a human",
      "I cannot talk to a human because I only use the bot",
      "I can't speak to a human because I refuse",
      "I can't reach a person and I am not asking for one",
      "I need someone to receive my package",
      "I need a person to accept the delivery",
      "somebody to return the parcel",
      "a person to install the item",
      "I want a human. Actually don't.",
      "I want a human. No thanks.",
      "Connect me to a human. I changed my mind.",
      "Human please—scratch that",
      "Talk to a person. Forget it.",
      "Transfer me. Stop.",
      "Connect me to a human. Actually keep me with the bot",
      "How do I know if I need a human?",
      "Does this mean I need a human?",
      "Is the bot saying I need a human?",
      "Did I tell you I want a human?",
      "Yesterday I said I need a human",
      "Earlier I told you I need a human",
      "The customer wrote I want a human.",
      "My message says connect me to a human.",
      "Repeat after me: connect me to a person.",
      "I can't talk to a human because I don't consent",
      "I can't reach a person, nor do I want one",
      "I need someone for delivery",
      "I need someone to help deliver my order",
      "I need a person to assist with carrying the package",
      "I want someone with a van",
      "I want a human. Actually no.",
      "I want a human. I changed my mind about that.",
      "Connect me to a human. Cancel the request.",
      "Talk to a person. I would rather stay with the bot.",
      "A human? No thank you.",
      "Connect me to a human. I've changed my mind.",
      "Human please—I take that back",
      "Connect me to a person. Forget that.",
      "Would I need a human?",
      "Could I need a human?",
      "Do you think I need a human?",
      "My friend said I need a human.",
      "The email says connect me to a human.",
      "Last week I said I need a human.",
      "Do customers need a human?",
      "Why would customers want a human?",
      "Does my message mean I need a human?",
      "Are you suggesting I need a human?",
      "Are you telling me to ask for a human?",
      "She said I need a human",
      "Last month I said I need a human",
      "Yesterday I mentioned I need a human",
      "I can't talk to a human because I decline.",
      "I can't talk to a human, and I would rather not.",
      "I can't speak to a person because I stay with the bot",
      "I can't talk to a human because I opt out",
      "I can't talk to a human. I do not consent.",
      "I need someone for a home delivery.",
      "I need someone for package delivery.",
      "I need a person with a pickup truck.",
      "I need someone to fix my car",
      "I need someone to help carry my order",
      "Human please. Please cancel.",
      "Transfer me. Never mind that.",
      "I want a human. Keep talking to the bot.",
      "The customer told me to ask for a human.",
      "For example, say I want a human.",
      "I said yesterday that I need a human.",
      "I need an agent for shipping.",
      "I want someone to call the courier",
      "Human please—no, thanks",
      "A minute ago I said I need a human",
      "I can't reach a person, nor want one",
      "I need someone for delivery tomorrow",
      "I need a human. I'd rather not.",
      "I want a human. Nevermind.",
      "I need a human. Please don't.",
      "Should customers get a human?",
      "My chat says I need a human.",
      "A moment ago I said I need a human.",
      "I told you last week I need a human.",
      "I can't talk to a human. Please keep me with the bot.",
      "I need someone for grocery delivery.",
      "I need an agent for my novel.",
      "I need a manager for my band.",
      "Human please—never mind actually",
      "Human please—cancel it",
      "Human please—not anymore",
      "Human please—actually no thanks",
      "Human please—I’d rather stay with the bot",
      "Human please—remain with the chatbot",
      "Human please—on second thought, no.",
      "Connect me to a human. Please cancel it.",
      "Does a customer need a human?",
      "Is the customer saying they need a human?",
      "My previous message said I need a human",
      "This morning I said I need a human",
      "Is my message suggesting I need a human?",
      "Did the customer say they want a human?",
      "Why does the customer need a human?",
      "Two days ago I said I need a human",
      "I can't reach a person because I’d rather stay with the bot",
      "I can't talk to a human; please don't.",
      "I can't reach a person. I decline the handoff.",
      "I need someone with a car",
      "I need someone to help me deliver my order",
      "I need a person to assist in carrying the package",
      "I need someone with a delivery van",
      "I need someone to help move my package",
    ]) assert.equal(isExplicitHumanSupportRequest(message), false, message);
    assert.equal(resolveKnownSupportMessage("purple river yesterday"), null);
    assert.match(unresolvedSupportMessage().message, /I don’t know what to say/);
    for (const scenario of supportScenarios) {
      assert.match(scenario.confirmedReply, /synthetic (record|records|shipment)/i);
      assert.match(scenario.confirmedReply, /demo/);
      assert.match(scenario.confirmedReply, /host chatbot/);
      assert.doesNotMatch(scenario.confirmedReply, /I can (send|connect|create|unlock)/i);
    }
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseLiveFeedbackInput,
  parseLiveFeedbackResponse,
  parseLiveSuggestionInput,
  parseLiveSuggestionResponse,
} from "../lib/live-suggestion-schema.ts";
import { buildLiveDemoProductRequest } from "../lib/live-demo-request.ts";
import {
  canReuseLiveSuggestionAttempt,
  liveSuggestionRetryWindowMs,
  type LiveSuggestionAttempt,
} from "../lib/live-retry.ts";
import { createLiveRequestSignature } from "../lib/live-signature.ts";
import { assertRequestSameOrigin } from "../lib/same-origin.ts";

const suggestionId = "sg_0123456789abcdef0123456789abcdef";
const requestId = "019f98c8-59fa-7f61-9aee-ba5f3cb7ca2a";

function suggestionResponse(): Record<string, unknown> {
  return {
    schema_version: 1,
    suggestion_id: suggestionId,
    status: "completed",
    outcome: "candidates",
    abstained: false,
    abstention_reason: null,
    review_required: true,
    candidates: [
      {
        id: `${suggestionId}:duplicate_charge`,
        detector_id: "duplicate_charge",
        title: "You were charged twice",
        detail: "Two successful $84.00 charges were recorded within one hour.",
        rank: 1,
        ranking_score: 1.42,
        evidence: [
          {
            input_index: 0,
            ref: "ev_0123456789abcdef01234567",
            source: "billing",
            kind: "charge",
            occurred_at: "2026-07-25T12:00:00+00:00",
            provenance: "exported",
          },
        ],
      },
    ],
    processing_ms: 24,
    redaction_entity_counts: { PERSON: 1 },
    policy: {
      detector_set_version: "det_0123456789abcdef",
      threshold_version: "pilot-v1",
      threshold: 0,
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

describe("live suggestion schema", () => {
  it("accepts the exact versioned request and response contracts", () => {
    assert.deepEqual(
      parseLiveSuggestionInput({
        schema_version: 1,
        request_id: requestId,
        observed_at: "2026-07-25T12:00:00+00:00",
        utterance: "I think I got charged again.",
      }),
      {
        schema_version: 1,
        request_id: requestId,
        observed_at: "2026-07-25T12:00:00+00:00",
        utterance: "I think I got charged again.",
      },
    );
    const response = parseLiveSuggestionResponse(suggestionResponse());
    assert.equal(response.suggestion_id, suggestionId);
    assert.equal(response.candidates[0]?.detector_id, "duplicate_charge");
    assert.equal(response.candidates[0]?.evidence[0]?.input_index, 0);
  });

  it("requires a non-negative input evidence index", () => {
    const missingIndex = suggestionResponse();
    const missingCandidate = (missingIndex.candidates as Array<Record<string, unknown>>)[0]!;
    const missingEvidence = (missingCandidate.evidence as Array<Record<string, unknown>>)[0]!;
    delete missingEvidence.input_index;
    assert.throws(() => parseLiveSuggestionResponse(missingIndex), /invalid shape/);

    const negativeIndex = suggestionResponse();
    const negativeCandidate = (negativeIndex.candidates as Array<Record<string, unknown>>)[0]!;
    const negativeEvidence = (negativeCandidate.evidence as Array<Record<string, unknown>>)[0]!;
    negativeEvidence.input_index = -1;
    assert.throws(() => parseLiveSuggestionResponse(negativeIndex), /non-negative integer/);
  });

  it("rejects extra response fields and inconsistent ranks", () => {
    assert.throws(
      () => parseLiveSuggestionResponse({ ...suggestionResponse(), untrusted: true }),
      /invalid shape/,
    );
    const wrongRank = suggestionResponse();
    (wrongRank.candidates as Array<Record<string, unknown>>)[0]!.rank = 2;
    assert.throws(() => parseLiveSuggestionResponse(wrongRank), /contiguous/);
  });

  it("rejects outcome fields that disagree with candidate presence", () => {
    const inconsistent = suggestionResponse();
    inconsistent.abstained = true;
    inconsistent.outcome = "abstained";
    inconsistent.abstention_reason = "below_confidence_floor";
    assert.throws(() => parseLiveSuggestionResponse(inconsistent), /disagree/);
  });

  it("accepts matching feedback and rejects mismatched none feedback", () => {
    assert.deepEqual(
      parseLiveFeedbackInput({
        schema_version: 1,
        request_id: requestId,
        outcome: "confirmed",
        selected_detector_id: "duplicate_charge",
      }),
      {
        schema_version: 1,
        request_id: requestId,
        outcome: "confirmed",
        selected_detector_id: "duplicate_charge",
      },
    );
    assert.throws(
      () =>
        parseLiveFeedbackInput({
          schema_version: 1,
          request_id: requestId,
          outcome: "none",
          selected_detector_id: "duplicate_charge",
        }),
      /does not match/,
    );
  });

  it("strictly validates a recorded feedback response", () => {
    const parsed = parseLiveFeedbackResponse({
      schema_version: 1,
      feedback_id: "fb_0123456789abcdef0123456789abcdef",
      suggestion_id: suggestionId,
      recorded: true,
      outcome: "confirmed",
      selected_detector_id: "duplicate_charge",
      actor: "agent",
      recorded_at: "2026-07-25T12:01:00+00:00",
    });
    assert.equal(parsed.recorded, true);
    assert.equal(parsed.actor, "agent");
  });

  it("builds byte-identical upstream bodies for an idempotent retry", () => {
    const input = parseLiveSuggestionInput({
      schema_version: 1,
      request_id: requestId,
      observed_at: "2026-07-25T12:00:00+00:00",
      utterance: "I think I got charged again.",
    });
    const first = buildLiveDemoProductRequest(input);
    const second = buildLiveDemoProductRequest(input);
    assert.equal(first, second);
    const body = JSON.parse(first) as Record<string, unknown>;
    assert.equal(body.observed_at, input.observed_at);
  });

  it("signs the exact canonical v1 request bytes", () => {
    const signature = createLiveRequestSignature({
      body: '{"utterance":"hello 👋"}',
      idempotencyKey: `console-suggestion:${requestId}`,
      path: "/v1/suggestions",
      secret: "local-only-signing-secret-2026-07-25",
      timestamp: "1785015000",
    });
    assert.equal(
      signature,
      "6db4d9aae49dfe4decccede74a44914e55c1364adb504fda236c3a3faf611aa8",
    );
  });

  it("reuses suggestion attempts only while their proxy retry window is open", () => {
    const nowMs = Date.parse("2026-07-25T12:15:00.000Z");
    const attempt: LiveSuggestionAttempt = {
      fingerprint: "same message",
      requestId,
      observedAt: new Date(nowMs - liveSuggestionRetryWindowMs + 1).toISOString(),
    };

    assert.equal(canReuseLiveSuggestionAttempt(attempt, "same message", nowMs), true);
    assert.equal(
      canReuseLiveSuggestionAttempt(
        { ...attempt, observedAt: new Date(nowMs - liveSuggestionRetryWindowMs).toISOString() },
        "same message",
        nowMs,
      ),
      false,
    );
    assert.equal(canReuseLiveSuggestionAttempt(attempt, "different message", nowMs), false);
    assert.equal(
      canReuseLiveSuggestionAttempt({ ...attempt, observedAt: "not-a-date" }, "same message", nowMs),
      false,
    );
  });

  it("accepts the browser host even when the framework request URL is localhost", () => {
    assert.doesNotThrow(() =>
      assertRequestSameOrigin(
        new Request("http://localhost:3000/api/live/suggestions", {
          headers: {
            Host: "127.0.0.1:3000",
            Origin: "http://127.0.0.1:3000",
          },
        }),
      ),
    );
    assert.doesNotThrow(() =>
      assertRequestSameOrigin(
        new Request("http://internal:3000/api/live/suggestions", {
          headers: {
            Host: "console.example.com",
            Origin: "https://console.example.com",
            "X-Forwarded-Proto": "https",
          },
        }),
      ),
    );
  });

  it("rejects cross-origin or malformed browser origins", () => {
    for (const origin of ["https://evil.example", "null", "not a URL"]) {
      assert.throws(
        () =>
          assertRequestSameOrigin(
            new Request("http://localhost:3000/api/live/suggestions", {
              headers: { Host: "127.0.0.1:3000", Origin: origin },
            }),
          ),
        /cross_origin/,
      );
    }
  });
});

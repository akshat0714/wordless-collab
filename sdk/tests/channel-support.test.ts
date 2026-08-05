import { describe, expect, it } from "vitest";
import {
  classifyChoiceFeedback,
  createSignedChoicePayload,
  verifySignedChoicePayload,
} from "../src/channel-support.js";

const SECRET = "unit-test-signing-secret-000000000000";
const base = {
  bindingParts: ["app1", "conv1", "user1"] as const,
  suggestionId: "sg_" + "a".repeat(32),
  choiceId: "choice-1",
  issuedAtSeconds: 1_000,
  expiresAtSeconds: 2_000,
  nonce: "nonce123",
  signingSecret: SECRET,
};

describe("classifyChoiceFeedback", () => {
  it("maps detector, none, and skip", () => {
    expect(classifyChoiceFeedback("clarification_choices", "duplicate_charge")).toBe("confirmed");
    expect(classifyChoiceFeedback("clarification_choices", null)).toBe("none");
    expect(classifyChoiceFeedback("grounded_reply", null)).toBe("skip");
    expect(classifyChoiceFeedback("clarifying_fallback", null)).toBe("skip");
  });
});

describe("signed choice payloads", () => {
  it("round-trips a detector choice", () => {
    const payload = createSignedChoicePayload({ ...base, detectorId: "duplicate_charge", feedback: "confirmed" });
    const verified = verifySignedChoicePayload({ payload, bindingParts: base.bindingParts, signingSecret: SECRET, nowSeconds: 1_500 });
    expect(verified).toEqual({
      suggestionId: base.suggestionId, choiceId: "choice-1", detectorId: "duplicate_charge",
      feedback: "confirmed", issuedAtSeconds: 1_000, expiresAtSeconds: 2_000, nonce: "nonce123",
    });
  });

  it("round-trips a none choice", () => {
    const payload = createSignedChoicePayload({ ...base, detectorId: null, feedback: "none" });
    const verified = verifySignedChoicePayload({ payload, bindingParts: base.bindingParts, signingSecret: SECRET, nowSeconds: 1_500 });
    expect(verified?.detectorId).toBeNull();
    expect(verified?.feedback).toBe("none");
  });

  it("rejects a tampered payload", () => {
    const payload = createSignedChoicePayload({ ...base, detectorId: "duplicate_charge", feedback: "confirmed" });
    const tampered = payload.replace("duplicate_charge", "locked_account");
    expect(verifySignedChoicePayload({ payload: tampered, bindingParts: base.bindingParts, signingSecret: SECRET, nowSeconds: 1_500 })).toBeNull();
  });

  it("rejects a different binding", () => {
    const payload = createSignedChoicePayload({ ...base, detectorId: null, feedback: "none" });
    expect(verifySignedChoicePayload({ payload, bindingParts: ["app1", "conv1", "OTHER"], signingSecret: SECRET, nowSeconds: 1_500 })).toBeNull();
  });

  it("rejects an expired payload", () => {
    const payload = createSignedChoicePayload({ ...base, detectorId: null, feedback: "none" });
    expect(verifySignedChoicePayload({ payload, bindingParts: base.bindingParts, signingSecret: SECRET, nowSeconds: 2_001 })).toBeNull();
  });

  it("rejects a malformed payload", () => {
    expect(verifySignedChoicePayload({ payload: "not-a-payload", bindingParts: base.bindingParts, signingSecret: SECRET, nowSeconds: 1_500 })).toBeNull();
  });
});

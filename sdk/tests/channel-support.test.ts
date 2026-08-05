import { describe, expect, it } from "vitest";
import {
  classifyChoiceFeedback,
  createSignedChoicePayload,
  verifySignedChoicePayload,
} from "../src/channel-support.js";
import { detectHumanRequest, isShowChoicesRequest } from "../src/channel-support.js";

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

describe("isShowChoicesRequest", () => {
  it("is true for empty text, the phrase, or a matched payload", () => {
    expect(isShowChoicesRequest("", false)).toBe(true);
    expect(isShowChoicesRequest("   ", false)).toBe(true);
    expect(isShowChoicesRequest("I don't know what to say", false)).toBe(true);
    expect(isShowChoicesRequest("i dont know what to say", false)).toBe(true);
    expect(isShowChoicesRequest("anything", true)).toBe(true);
  });
  it("is false for ordinary text", () => {
    expect(isShowChoicesRequest("where is my order", false)).toBe(false);
  });
});

describe("detectHumanRequest", () => {
  it("detects explicit handoff requests", () => {
    for (const text of [
      "talk to a human", "I want to speak to an agent", "connect me to a person",
      "can I talk to a real person", "transfer me to a representative", "get me a manager please",
      "let me speak with someone", "I need a live agent",
    ]) expect(detectHumanRequest(text), text).toBe(true);
  });
  it("ignores negated, retracted, reported, or bot-preferring text", () => {
    for (const text of [
      "I don't want to talk to a human", "never mind, cancel that",
      "I never asked for an agent", "keep me with the bot",
      "where is my refund", "the courier is a real person",
    ]) expect(detectHumanRequest(text), text).toBe(false);
  });
  it("still recognizes genuine requests phrased with a role word near the cue", () => {
    for (const text of [
      "can I talk to a person", "connect me to a human", "I need to speak to someone",
      "transfer me to an agent", "let me speak with a representative",
    ]) expect(detectHumanRequest(text), text).toBe(true);
  });
  it("treats a bare role word, or role word plus polite tokens, as a genuine minimal request", () => {
    expect(detectHumanRequest("human")).toBe(true);
    expect(detectHumanRequest("agent")).toBe(true);
    expect(detectHumanRequest("agent please")).toBe(true);
  });
  it("does not treat a sentence that merely starts with a role word as a handoff request", () => {
    for (const text of [
      "Manager approved the refund yesterday", "Agent Smith called about the package",
    ]) expect(detectHumanRequest(text), text).toBe(false);
  });
  it("requires the request cue to be near the role word, not merely present earlier in the message", () => {
    for (const text of [
      "I need to know if someone already used this coupon",
      "Can I get a refund if a person already claimed the item",
    ]) expect(detectHumanRequest(text), text).toBe(false);
  });
});

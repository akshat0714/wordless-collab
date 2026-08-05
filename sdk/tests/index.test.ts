import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CandidateValidationError,
  SuggestionValidationError,
  mountConfirmCards,
  parseSuggestionResponse,
  suggestionCandidates,
} from "../src/index";

const candidates = [
  { id: "duplicate", title: "You were charged twice", detail: "Two $84.00 charges succeeded within six minutes." },
  { id: "locked", title: "Your account is locked", detail: "3 failed attempts locked the account today." },
  { id: "wrong", title: "The wrong item arrived", detail: "Order 40218 lists a kettle, not a toaster." },
] as const;

beforeEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => null,
  });
});

describe("mountConfirmCards", () => {
  it("renders real buttons and reports no axe violations", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    mountConfirmCards(root, { candidates, onConfirm: vi.fn() });

    expect(root.querySelectorAll("button.wl-confirm__choice")).toHaveLength(3);
    expect(root.querySelector("[aria-live='polite']")).not.toBeNull();
    expect((await axe.run(root)).violations).toEqual([]);
  });

  it("uses text and a glyph to expose selection state", () => {
    const root = document.createElement("div");
    const onConfirm = vi.fn();
    mountConfirmCards(root, { candidates, onConfirm });

    (root.querySelector("button") as HTMLButtonElement).click();
    const selected = root.querySelector("[aria-pressed='true']");
    expect(selected?.textContent).toContain("✓ Selected");
    expect(onConfirm).toHaveBeenCalledWith(candidates[0]);
  });

  it("moves focus with arrow keys", () => {
    const root = document.createElement("div");
    document.body.append(root);
    mountConfirmCards(root, { candidates, onConfirm: vi.fn() });
    const buttons = root.querySelectorAll<HTMLButtonElement>(".wl-confirm__choice");
    buttons[0]?.focus();
    buttons[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(buttons[1]);
  });

  it("rejects more than three candidates and invalid copy", () => {
    const root = document.createElement("div");
    expect(() =>
      mountConfirmCards(root, { candidates: [...candidates, candidates[0]], onConfirm: vi.fn() }),
    ).toThrow(CandidateValidationError);
    expect(() =>
      mountConfirmCards(root, {
        candidates: [{ id: "short", title: "Too short", detail: "A useful detail." }],
        onConfirm: vi.fn(),
      }),
    ).toThrow(/3–7 words/);
    expect(() =>
      mountConfirmCards(root, {
        candidates: [{ id: "punctuation", title: "!!! ??? ###", detail: "Order 40218 remains delayed." }],
        onConfirm: vi.fn(),
      }),
    ).toThrow(/3–7 words/);
    expect(() =>
      mountConfirmCards(root, {
        candidates: [{ id: "punctuation-detail", title: "Your order is delayed", detail: "1 ???" }],
        onConfirm: vi.fn(),
      }),
    ).toThrow(/meaningful words/);
  });

  it("uses a control boundary with at least 3:1 non-text contrast", () => {
    const root = document.createElement("div");
    document.body.append(root);
    mountConfirmCards(root, { candidates, onConfirm: vi.fn() });
    const styles = document.getElementById("wordless-confirm-cards-styles")?.textContent ?? "";

    expect(styles).toContain("border: 1px solid #4a5462");
  });

  it.each([
    ["has no evidence value", "A useful detail describes the observed failure."],
    ["mentions an order without an identifier", "The order was delayed yesterday."],
    ["is not a complete sentence", "Order 40218 remains delayed"],
    ["contains two sentences", "Order 40218 was delayed. It arrived today."],
    ["uses a word instead of a concrete number", "Three failed attempts locked the account today."],
  ])("rejects detail copy that %s", (_case, detail) => {
    const root = document.createElement("div");
    expect(() =>
      mountConfirmCards(root, {
        candidates: [{ id: "invalid", title: "Your order is delayed", detail }],
        onConfirm: vi.fn(),
      }),
    ).toThrow(CandidateValidationError);
  });

  it("accepts concrete alphanumeric SKU evidence", () => {
    const root = document.createElement("div");
    mountConfirmCards(root, {
      candidates: [{ id: "sku", title: "The wrong item arrived", detail: "SKU KETTLE_BLUE appears on the delivered item." }],
      onConfirm: vi.fn(),
    });
    expect(root.querySelector(".wl-confirm__detail")?.textContent).toContain("KETTLE_BLUE");
  });

  it("accepts an opaque order reference without requiring digits", () => {
    const root = document.createElement("div");
    mountConfirmCards(root, {
      candidates: [{
        id: "order",
        title: "The wrong item arrived",
        detail: "Order ord_alpha lists SKU_A ordered and SKU_B received.",
      }],
      onConfirm: vi.fn(),
    });
    expect(root.querySelector(".wl-confirm__detail")?.textContent).toContain("ord_alpha");
  });

  it.each([
    ["heading", "   "],
    ["instruction", "\t\n"],
    ["none", "\u200B"],
    ["selected", ""],
  ] as const)("rejects an empty %s accessible label", (name, value) => {
    const root = document.createElement("div");
    expect(() =>
      mountConfirmCards(root, {
        candidates,
        labels: { [name]: value },
        onConfirm: vi.fn(),
      }),
    ).toThrow(new CandidateValidationError(`Label ${name} must contain accessible text.`));
  });

  it("applies the evidence-copy contract to updates", () => {
    const root = document.createElement("div");
    const controller = mountConfirmCards(root, { candidates, onConfirm: vi.fn() });
    expect(() =>
      controller.update([
        { id: "invalid", title: "Your order is delayed", detail: "No evidence appears here." },
      ]),
    ).toThrow(/concrete number/);
    expect(root.querySelectorAll(".wl-confirm__choice")).toHaveLength(3);
  });

  it("updates and destroys without retaining stale content", () => {
    const root = document.createElement("div");
    const controller = mountConfirmCards(root, { candidates, onConfirm: vi.fn() });
    controller.update(candidates.slice(0, 1));
    expect(root.querySelectorAll(".wl-confirm__choice")).toHaveLength(1);
    controller.destroy();
    expect(root.childElementCount).toBe(0);
  });
});

describe("real-time suggestion adapter", () => {
  const suggestion = {
    schema_version: 1,
    suggestion_id: "sg_0123456789abcdef0123456789abcdef",
    status: "completed",
    outcome: "candidates",
    abstained: false,
    abstention_reason: null,
    review_required: true,
    candidates: [{
      id: "sg_0123456789abcdef0123456789abcdef:duplicate_charge",
      detector_id: "duplicate_charge",
      title: "You were charged twice",
      detail: "Two successful $84.00 charges were recorded for order ord_alpha within one hour.",
      rank: 1,
      ranking_score: 1.42,
      evidence: [{
        ref: "ev_0123456789abcdef01234567",
        source: "billing",
        kind: "charge",
        input_index: 0,
        occurred_at: "2026-07-25T12:00:00Z",
        provenance: "exported",
      }],
    }],
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
      self: "/v1/suggestions/sg_0123456789abcdef0123456789abcdef",
      events: "/v1/suggestions/sg_0123456789abcdef0123456789abcdef/events",
      feedback: "/v1/suggestions/sg_0123456789abcdef0123456789abcdef/feedback",
    },
  };

  it("validates and maps a versioned product response", () => {
    expect(parseSuggestionResponse(suggestion).suggestion_id).toBe(suggestion.suggestion_id);
    expect(suggestionCandidates(suggestion)).toEqual([{
      id: suggestion.candidates[0]?.id,
      title: "You were charged twice",
      detail: suggestion.candidates[0]?.detail,
      score: 1.42,
      detectorId: "duplicate_charge",
    }]);
  });

  it("accepts an explicit abstention with no cards", () => {
    expect(suggestionCandidates({
      ...suggestion,
      outcome: "abstained",
      abstained: true,
      abstention_reason: "no_evidence_hypotheses",
      candidates: [],
    })).toEqual([]);
  });

  it.each([
    [{ ...suggestion, schema_version: 2 }, "version"],
    [{ ...suggestion, abstained: true }, "disagree"],
    [{ ...suggestion, review_required: false }, "review policy"],
    [{ ...suggestion, unexpected: true }, "exact versioned"],
    [{
      ...suggestion,
      candidates: [{ ...suggestion.candidates[0], evidence: [] }],
    }, "cite 1–20"],
    [{ ...suggestion, policy: undefined }, "policy must be an object"],
    [{
      ...suggestion,
      candidates: [{
        ...suggestion.candidates[0],
        evidence: suggestion.candidates[0]!.evidence.map(({ input_index: _inputIndex, ...item }) => item),
      }],
    }, "exact versioned"],
    [{
      ...suggestion,
      candidates: [{
        ...suggestion.candidates[0],
        evidence: [{ ...suggestion.candidates[0]!.evidence[0], input_index: 100 }],
      }],
    }, "below 100"],
    [{
      ...suggestion,
      candidates: [{ ...suggestion.candidates[0], rank: 2 }],
    }, "ranks"],
  ])("rejects malformed product JSON", (value, message) => {
    expect(() => suggestionCandidates(value)).toThrow(SuggestionValidationError);
    expect(() => suggestionCandidates(value)).toThrow(message);
  });
});

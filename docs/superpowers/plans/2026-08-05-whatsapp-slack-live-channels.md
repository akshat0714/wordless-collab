# WhatsApp & Slack live channels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new Wordless SDK live channels — WhatsApp Cloud API (PR 1) and Slack (PR 2) — on the existing framework-neutral support-chatbot adapter, sharing one channel-neutral helper module.

**Architecture:** Each channel is a zero-runtime-dependency TypeScript module in `sdk/src/` that verifies its platform webhook, parses the envelope, resolves an authenticated account via a host callback, calls `chatbot.processMessage()`, and maps the returned turn to native send-request objects with signed, expiring, one-time choice payloads. A shared `channel-support.ts` module holds the signing, feedback-classification, choice-store contract, and human/show-choices detection so the two channels don't duplicate it. `zendesk.ts` is not modified.

**Tech Stack:** TypeScript (ESM, `type: module`), Node `crypto` only, vitest, tsc. No third-party runtime deps.

## Global Constraints

- Node `>=20`; ESM only; no third-party runtime dependencies (Node built-ins only). — verbatim from `sdk/package.json`.
- Read-only: adapter result unions contain no account-mutating request shape. No refund/cancel/unlock/edit.
- At most **3** choices per turn; the null-detector "not sure" choice is the only zero-evidence choice.
- Choice payloads are HMAC-signed, nonce-bound, expiring, and one-time; carry only ids, a feedback code, timestamps, a nonce, and a signature — never secrets or PII.
- All time is injected via a `now?: () => Date` option; **no module-scope `Date.now()` / `new Date()`** in mapping logic (tests inject a fixed clock).
- A `WordlessSdkError` from `chatbot.processMessage` always degrades to a safe `continue` (host bot proceeds). A `resolveAuthenticatedAccount` (resolver) outage propagates by default (`accountResolutionFailureMode` defaults to `"throw"` — fail-closed: the host webhook returns non-2xx and the platform retries), and only degrades to a safe `continue` when the host opts in with `accountResolutionFailureMode: "continue"`. Neither case is ever turned into a fabricated intent.
- English-only; locale gating is the host's responsibility before calling the adapter.
- Branch `feature/whatsapp-slack-live-channels`; PRs into `main`; never commit to `main`, never deploy, never add real credentials or customer data (`COLLABORATING.md`).
- Verify each task from `sdk/`: `npm run typecheck && npm test`.

---

# Phase 1 — PR 1: shared module + WhatsApp Cloud API channel

## Task 1: Shared signing & feedback primitives (`channel-support.ts`)

**Files:**
- Create: `sdk/src/channel-support.ts`
- Test: `sdk/tests/channel-support.test.ts`

**Interfaces:**
- Consumes: `WordlessSupportChatTurn` from `./server.js` (only the `kind` field union).
- Produces:
  - `type ChoiceFeedback = "confirmed" | "none" | "skip"`
  - `class ChannelSupportError extends Error`
  - `function classifyChoiceFeedback(turnKind: WordlessSupportChatTurn["kind"], detectorId: string | null): ChoiceFeedback`
  - `function createSignedChoicePayload(input: SignedChoiceInput): string`
  - `interface SignedChoiceInput { bindingParts: readonly string[]; suggestionId: string; choiceId: string; detectorId: string | null; feedback: ChoiceFeedback; issuedAtSeconds: number; expiresAtSeconds: number; nonce: string; signingSecret: string; }`
  - `interface VerifiedChoicePayload { suggestionId: string; choiceId: string; detectorId: string | null; feedback: ChoiceFeedback; issuedAtSeconds: number; expiresAtSeconds: number; nonce: string; }`
  - `function verifySignedChoicePayload(input: { payload: string; bindingParts: readonly string[]; signingSecret: string; nowSeconds: number; }): VerifiedChoicePayload | null`

- [ ] **Step 1: Write the failing test**

```ts
// sdk/tests/channel-support.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdk && npx vitest run tests/channel-support.test.ts`
Expected: FAIL — cannot find module `../src/channel-support.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// sdk/src/channel-support.ts
import { createHmac, timingSafeEqual } from "node:crypto";

import type { WordlessSupportChatTurn } from "./server.js";

export type ChoiceFeedback = "confirmed" | "none" | "skip";

const SUGGESTION_ID_PATTERN = /^sg_[0-9a-f]{32}$/u;
const CHOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const DETECTOR_ID_PATTERN = /^[a-z][a-z0-9_]{1,48}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export class ChannelSupportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelSupportError";
  }
}

export function classifyChoiceFeedback(
  turnKind: WordlessSupportChatTurn["kind"],
  detectorId: string | null,
): ChoiceFeedback {
  if (detectorId !== null) return "confirmed";
  return turnKind === "clarification_choices" ? "none" : "skip";
}

function feedbackCode(detectorId: string | null, feedback: ChoiceFeedback): string {
  if (feedback === "confirmed" && detectorId !== null) return `c_${detectorId}`;
  if (feedback === "none" && detectorId === null) return "none";
  if (feedback === "skip" && detectorId === null) return "skip";
  throw new ChannelSupportError("Wordless choice feedback metadata is inconsistent.");
}

function decodeFeedback(code: string): { detectorId: string | null; feedback: ChoiceFeedback } | null {
  if (code === "none") return { detectorId: null, feedback: "none" };
  if (code === "skip") return { detectorId: null, feedback: "skip" };
  if (code.startsWith("c_")) {
    const detectorId = code.slice(2);
    if (!DETECTOR_ID_PATTERN.test(detectorId)) return null;
    return { detectorId, feedback: "confirmed" };
  }
  return null;
}

function signature(bindingParts: readonly string[], core: string, signingSecret: string): string {
  return createHmac("sha256", Buffer.from(signingSecret, "utf8"))
    .update(`${bindingParts.join("\n")}\n${core}`, "utf8")
    .digest("base64url")
    .slice(0, 22);
}

export interface SignedChoiceInput {
  readonly bindingParts: readonly string[];
  readonly suggestionId: string;
  readonly choiceId: string;
  readonly detectorId: string | null;
  readonly feedback: ChoiceFeedback;
  readonly issuedAtSeconds: number;
  readonly expiresAtSeconds: number;
  readonly nonce: string;
  readonly signingSecret: string;
}

export function createSignedChoicePayload(input: SignedChoiceInput): string {
  if (!SUGGESTION_ID_PATTERN.test(input.suggestionId)) throw new ChannelSupportError("Invalid suggestion id.");
  if (!CHOICE_ID_PATTERN.test(input.choiceId)) throw new ChannelSupportError("Invalid choice id.");
  if (!NONCE_PATTERN.test(input.nonce)) throw new ChannelSupportError("Invalid nonce.");
  if (!Number.isSafeInteger(input.issuedAtSeconds) || !Number.isSafeInteger(input.expiresAtSeconds)) {
    throw new ChannelSupportError("Invalid choice timestamps.");
  }
  const code = feedbackCode(input.detectorId, input.feedback);
  const core = `wl2.${input.suggestionId}.${input.choiceId}.${code}.${input.issuedAtSeconds.toString(36)}.${input.expiresAtSeconds.toString(36)}.${input.nonce}`;
  return `${core}.${signature(input.bindingParts, core, input.signingSecret)}`;
}

export function verifySignedChoicePayload(input: {
  readonly payload: string;
  readonly bindingParts: readonly string[];
  readonly signingSecret: string;
  readonly nowSeconds: number;
}): VerifiedChoicePayload | null {
  if (typeof input.payload !== "string" || input.payload.length > 256) return null;
  const parts = input.payload.split(".");
  if (parts.length !== 8 || parts[0] !== "wl2") return null;
  const [, suggestionId, choiceId, code, issuedB36, expiresB36, nonce, sig] = parts;
  if (!SUGGESTION_ID_PATTERN.test(suggestionId!) || !CHOICE_ID_PATTERN.test(choiceId!) || !NONCE_PATTERN.test(nonce!)) {
    return null;
  }
  const decoded = decodeFeedback(code!);
  if (decoded === null) return null;
  const issuedAtSeconds = Number.parseInt(issuedB36!, 36);
  const expiresAtSeconds = Number.parseInt(expiresB36!, 36);
  if (!Number.isSafeInteger(issuedAtSeconds) || !Number.isSafeInteger(expiresAtSeconds)) return null;
  const core = `wl2.${suggestionId}.${choiceId}.${code}.${issuedB36}.${expiresB36}.${nonce}`;
  const expected = signature(input.bindingParts, core, input.signingSecret);
  const actualBuf = Buffer.from(sig!, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) return null;
  if (input.nowSeconds > expiresAtSeconds) return null;
  return Object.freeze({
    suggestionId: suggestionId!,
    choiceId: choiceId!,
    detectorId: decoded.detectorId,
    feedback: decoded.feedback,
    issuedAtSeconds,
    expiresAtSeconds,
    nonce: nonce!,
  });
}

export interface VerifiedChoicePayload {
  readonly suggestionId: string;
  readonly choiceId: string;
  readonly detectorId: string | null;
  readonly feedback: ChoiceFeedback;
  readonly issuedAtSeconds: number;
  readonly expiresAtSeconds: number;
  readonly nonce: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdk && npx vitest run tests/channel-support.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add sdk/src/channel-support.ts sdk/tests/channel-support.test.ts
git commit -m "feat(sdk): shared signed choice payload + feedback helpers"
```

---

## Task 2: Shared show-choices & human-request detection (`channel-support.ts`)

**Files:**
- Modify: `sdk/src/channel-support.ts`
- Test: `sdk/tests/channel-support.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `const SHOW_CHOICES_TEXT_PATTERN: RegExp`
  - `function isShowChoicesRequest(text: string | null, payloadMatched: boolean): boolean`
  - `function detectHumanRequest(text: string): boolean`

Design note: `detectHumanRequest` is a focused, newly-written detector (not a relocation of Zendesk's battery — see plan header). It must (a) return true for explicit handoff phrasings and role mentions with a request cue, (b) return false for negated/retracted/reported requests and bot-preference statements. It errs toward false; a missed positive degrades only to a safe `continue`.

- [ ] **Step 1: Write the failing test (append to the file)**

```ts
// append to sdk/tests/channel-support.test.ts
import { detectHumanRequest, isShowChoicesRequest } from "../src/channel-support.js";

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdk && npx vitest run tests/channel-support.test.ts`
Expected: FAIL — `isShowChoicesRequest`/`detectHumanRequest` not exported.

- [ ] **Step 3: Add the implementation (append to `channel-support.ts`)**

```ts
// append to sdk/src/channel-support.ts
export const SHOW_CHOICES_TEXT_PATTERN =
  /^(?:i\s+)?(?:do not|don't|dont)\s+know\s+what\s+to\s+say[.!?]?$/iu;

export function isShowChoicesRequest(text: string | null, payloadMatched: boolean): boolean {
  if (payloadMatched) return true;
  const trimmed = (text ?? "").trim();
  return trimmed.length === 0 || SHOW_CHOICES_TEXT_PATTERN.test(trimmed);
}

const HUMAN_ROLE = new Set([
  "human", "person", "agent", "representative", "rep", "operator", "supervisor",
  "manager", "someone", "somebody", "advisor", "associate", "specialist", "staff",
]);
const REQUEST_CUE = new Set([
  "talk", "speak", "chat", "connect", "transfer", "escalate", "reach", "contact",
  "want", "need", "prefer", "get", "let", "put", "give", "call", "route", "forward", "pass",
]);
const NEGATION = new Set([
  "not", "dont", "don", "cant", "cannot", "never", "no", "wont", "wouldnt", "didnt", "stop",
]);
const REPORTING = new Set(["said", "asked", "told", "requested", "mentioned", "say", "ask"]);
const BOT_PREFERENCE = /\bkeep\s+(?:me\s+)?(?:with\s+)?(?:the\s+)?(?:bot|chatbot|robot)\b/iu;
const RETRACTION = /^(?:never\s*mind|cancel\s+that|forget\s+it|scratch\s+that|no\s+thanks?)\b/iu;
const NON_SUPPORT = /\b(?:courier|driver|delivery|postman|mailman)\b/iu;

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/['’]/gu, "").split(/[^a-z]+/u).filter((t) => t.length > 0);
}

export function detectHumanRequest(text: string): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 400) return false;
  if (RETRACTION.test(trimmed) || BOT_PREFERENCE.test(trimmed) || NON_SUPPORT.test(trimmed)) return false;
  const tokens = tokenize(trimmed);
  const roleIndex = tokens.findIndex((t) => HUMAN_ROLE.has(t));
  if (roleIndex < 0) return false;
  const leading = tokens.slice(0, roleIndex);
  if (leading.some((t) => NEGATION.has(t)) || leading.some((t) => REPORTING.has(t))) return false;
  // A bare role ("human") or a role preceded by a request cue counts.
  if (tokens.length === 1) return true;
  return leading.some((t) => REQUEST_CUE.has(t)) || roleIndex === 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdk && npx vitest run tests/channel-support.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/channel-support.ts sdk/tests/channel-support.test.ts
git commit -m "feat(sdk): shared show-choices and human-request detection"
```

---

## Task 3: WhatsApp signature & subscription verification (`whatsapp.ts`)

**Files:**
- Create: `sdk/src/whatsapp.ts`
- Test: `sdk/tests/whatsapp.test.ts`

**Interfaces:**
- Produces:
  - `class WhatsAppIntegrationError extends Error`
  - `class WhatsAppWebhookValidationError extends WhatsAppIntegrationError`
  - `function verifyWhatsAppSignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean`
  - `function verifyWhatsAppSubscription(query: { mode: string | null; token: string | null; challenge: string | null }, verifyToken: string): string` — returns the challenge to echo, throws `WhatsAppWebhookValidationError` on mismatch.

- [ ] **Step 1: Write the failing test**

```ts
// sdk/tests/whatsapp.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyWhatsAppSignature,
  verifyWhatsAppSubscription,
  WhatsAppWebhookValidationError,
} from "../src/whatsapp.js";

const APP_SECRET = "meta-app-secret-000000000000000000";
function sign(body: string): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex");
}

describe("verifyWhatsAppSignature", () => {
  it("accepts a correct signature and rejects wrong/absent ones", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    expect(verifyWhatsAppSignature(body, sign(body), APP_SECRET)).toBe(true);
    expect(verifyWhatsAppSignature(body, "sha256=deadbeef", APP_SECRET)).toBe(false);
    expect(verifyWhatsAppSignature(body, null, APP_SECRET)).toBe(false);
    expect(verifyWhatsAppSignature(body + " ", sign(body), APP_SECRET)).toBe(false);
  });
});

describe("verifyWhatsAppSubscription", () => {
  it("echoes the challenge on a valid subscribe and throws otherwise", () => {
    expect(verifyWhatsAppSubscription({ mode: "subscribe", token: "vt", challenge: "42" }, "vt")).toBe("42");
    expect(() => verifyWhatsAppSubscription({ mode: "subscribe", token: "bad", challenge: "42" }, "vt")).toThrow(WhatsAppWebhookValidationError);
    expect(() => verifyWhatsAppSubscription({ mode: "unsubscribe", token: "vt", challenge: "42" }, "vt")).toThrow(WhatsAppWebhookValidationError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdk && npx vitest run tests/whatsapp.test.ts`
Expected: FAIL — cannot find module `../src/whatsapp.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// sdk/src/whatsapp.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export class WhatsAppIntegrationError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message);
    this.name = "WhatsAppIntegrationError";
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", { configurable: true, value: options.cause, writable: true });
    }
  }
}

export class WhatsAppWebhookValidationError extends WhatsAppIntegrationError {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppWebhookValidationError";
  }
}

export function verifyWhatsAppSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (typeof rawBody !== "string" || typeof signatureHeader !== "string") return false;
  if (!signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  const expected = createHmac("sha256", Buffer.from(appSecret, "utf8")).update(rawBody, "utf8").digest("hex");
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

export function verifyWhatsAppSubscription(
  query: { readonly mode: string | null; readonly token: string | null; readonly challenge: string | null },
  verifyToken: string,
): string {
  if (query.mode !== "subscribe") throw new WhatsAppWebhookValidationError("Unexpected hub.mode.");
  const provided = Buffer.from(query.token ?? "", "utf8");
  const expected = Buffer.from(verifyToken, "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new WhatsAppWebhookValidationError("hub.verify_token mismatch.");
  }
  if (typeof query.challenge !== "string" || query.challenge.length === 0) {
    throw new WhatsAppWebhookValidationError("Missing hub.challenge.");
  }
  return query.challenge;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdk && npx vitest run tests/whatsapp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/whatsapp.ts sdk/tests/whatsapp.test.ts
git commit -m "feat(sdk): WhatsApp webhook signature and subscription verification"
```

---

## Task 4: WhatsApp envelope parsing (`whatsapp.ts`)

**Files:**
- Modify: `sdk/src/whatsapp.ts`
- Test: `sdk/tests/whatsapp.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `interface WhatsAppInboundMessage { phoneNumberId: string; waId: string; messageId: string; receivedAt: string; type: "text" | "button_reply"; text: string | null; buttonPayload: string | null; }`
  - `type WhatsAppParsedEntry = { kind: "message"; inbound: WhatsAppInboundMessage } | { kind: "ignored"; reason: "status" | "unsupported_type" | "wrong_number"; messageId: string | null }`
  - `function parseWhatsAppEnvelope(value: unknown, expectedPhoneNumberId: string): readonly WhatsAppParsedEntry[]`

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to sdk/tests/whatsapp.test.ts
import { parseWhatsAppEnvelope } from "../src/whatsapp.js";

const PN = "111222333";
function textEnvelope(body: string) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "e1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "1555", phone_number_id: PN },
      contacts: [{ wa_id: "15551230000" }],
      messages: [{ from: "15551230000", id: "wamid.1", timestamp: "1700000000", type: "text", text: { body } }],
    } }] }],
  };
}

describe("parseWhatsAppEnvelope", () => {
  it("parses a text message", () => {
    const parsed = parseWhatsAppEnvelope(textEnvelope("where is my order"), PN);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ kind: "message", inbound: {
      phoneNumberId: PN, waId: "15551230000", messageId: "wamid.1",
      receivedAt: "2023-11-14T22:13:20.000Z", type: "text", text: "where is my order", buttonPayload: null,
    } });
  });

  it("parses an interactive button_reply", () => {
    const env = textEnvelope("x");
    env.entry[0].changes[0].value.messages[0] = { from: "15551230000", id: "wamid.2", timestamp: "1700000000",
      type: "interactive", interactive: { type: "button_reply", button_reply: { id: "wl2.sg.x", title: "Yes" } } } as any;
    const parsed = parseWhatsAppEnvelope(env, PN);
    expect(parsed[0]).toMatchObject({ kind: "message", inbound: { type: "button_reply", buttonPayload: "wl2.sg.x", text: null } });
  });

  it("ignores delivery statuses, unsupported types, and wrong phone numbers", () => {
    const status = { object: "whatsapp_business_account", entry: [{ id: "e", changes: [{ field: "messages", value: {
      metadata: { phone_number_id: PN }, statuses: [{ id: "wamid.s", status: "delivered" }] } }] }] };
    expect(parseWhatsAppEnvelope(status, PN)[0]).toMatchObject({ kind: "ignored", reason: "status" });

    const image = textEnvelope("x");
    image.entry[0].changes[0].value.messages[0] = { from: "1", id: "wamid.i", timestamp: "1700000000", type: "image", image: {} } as any;
    expect(parseWhatsAppEnvelope(image, PN)[0]).toMatchObject({ kind: "ignored", reason: "unsupported_type" });

    expect(parseWhatsAppEnvelope(textEnvelope("x"), "999")[0]).toMatchObject({ kind: "ignored", reason: "wrong_number" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdk && npx vitest run tests/whatsapp.test.ts`
Expected: FAIL — `parseWhatsAppEnvelope` not exported.

- [ ] **Step 3: Add the implementation (append to `whatsapp.ts`)**

```ts
// append to sdk/src/whatsapp.ts
const MAX_ENTRIES = 50;
const MAX_MESSAGES = 50;
const MAX_TEXT_LENGTH = 4_000;

export interface WhatsAppInboundMessage {
  readonly phoneNumberId: string;
  readonly waId: string;
  readonly messageId: string;
  readonly receivedAt: string;
  readonly type: "text" | "button_reply";
  readonly text: string | null;
  readonly buttonPayload: string | null;
}

export type WhatsAppParsedEntry =
  | { readonly kind: "message"; readonly inbound: WhatsAppInboundMessage }
  | { readonly kind: "ignored"; readonly reason: "status" | "unsupported_type" | "wrong_number"; readonly messageId: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function isoFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{1,15}$/u.test(value)) return null;
  const ms = Number.parseInt(value, 10) * 1_000;
  if (!Number.isSafeInteger(ms)) return null;
  return new Date(ms).toISOString();
}

export function parseWhatsAppEnvelope(
  value: unknown,
  expectedPhoneNumberId: string,
): readonly WhatsAppParsedEntry[] {
  if (!isRecord(value) || !Array.isArray(value.entry) || value.entry.length > MAX_ENTRIES) {
    throw new WhatsAppWebhookValidationError("WhatsApp webhook envelope is invalid.");
  }
  const results: WhatsAppParsedEntry[] = [];
  for (const entry of value.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change) || change.field !== "messages" || !isRecord(change.value)) continue;
      const val = change.value;
      const metadata = isRecord(val.metadata) ? val.metadata : {};
      const phoneNumberId = optionalString(metadata.phone_number_id, 128);
      if (phoneNumberId !== expectedPhoneNumberId) {
        results.push({ kind: "ignored", reason: "wrong_number", messageId: null });
        continue;
      }
      if (Array.isArray(val.statuses) && val.statuses.length > 0) {
        results.push({ kind: "ignored", reason: "status", messageId: null });
      }
      if (!Array.isArray(val.messages)) continue;
      if (val.messages.length > MAX_MESSAGES) {
        throw new WhatsAppWebhookValidationError("Too many WhatsApp messages in one webhook.");
      }
      const contacts = Array.isArray(val.contacts) ? val.contacts : [];
      const firstWaId = contacts.length > 0 && isRecord(contacts[0]) ? optionalString(contacts[0].wa_id, 128) : null;
      for (const message of val.messages) {
        if (!isRecord(message)) continue;
        const messageId = optionalString(message.id, 256);
        const receivedAt = isoFromUnixSeconds(message.timestamp);
        const waId = optionalString(message.from, 128) ?? firstWaId;
        if (messageId === null || receivedAt === null || waId === null) {
          throw new WhatsAppWebhookValidationError("WhatsApp message is missing required fields.");
        }
        if (message.type === "text" && isRecord(message.text)) {
          results.push({ kind: "message", inbound: Object.freeze({
            phoneNumberId, waId, messageId, receivedAt, type: "text",
            text: optionalString(message.text.body, MAX_TEXT_LENGTH) ?? "", buttonPayload: null,
          }) });
        } else if (
          message.type === "interactive" && isRecord(message.interactive) &&
          message.interactive.type === "button_reply" && isRecord(message.interactive.button_reply)
        ) {
          const payload = optionalString(message.interactive.button_reply.id, 256);
          if (payload === null) { results.push({ kind: "ignored", reason: "unsupported_type", messageId }); continue; }
          results.push({ kind: "message", inbound: Object.freeze({
            phoneNumberId, waId, messageId, receivedAt, type: "button_reply", text: null, buttonPayload: payload,
          }) });
        } else {
          results.push({ kind: "ignored", reason: "unsupported_type", messageId });
        }
      }
    }
  }
  return Object.freeze(results);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdk && npx vitest run tests/whatsapp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/whatsapp.ts sdk/tests/whatsapp.test.ts
git commit -m "feat(sdk): WhatsApp webhook envelope parsing"
```

---

## Task 5: WhatsApp turn → send-request mapping (`whatsapp.ts`)

**Files:**
- Modify: `sdk/src/whatsapp.ts`
- Test: `sdk/tests/whatsapp.test.ts` (add cases)

**Interfaces:**
- Consumes: `WordlessSupportChatTurn`, `WordlessSupportChoice` from `./server.js`; `createSignedChoicePayload`, `classifyChoiceFeedback` from `./channel-support.js`.
- Produces:
  - `const WHATSAPP_SHOW_CHOICES_LABEL = "Not sure what to say"`
  - `interface WhatsAppSendRequest { method: "POST"; path: string; body: WhatsAppJsonValue }` (path is `/${phoneNumberId}/messages`)
  - `function buildWhatsAppSendRequest(inbound: WhatsAppInboundMessage, turn: WordlessSupportChatTurn, signingSecret: string, nonce: string, issuedAtSeconds: number, expiresAtSeconds: number): { request: WhatsAppSendRequest; pendingChoices: WhatsAppPendingChoiceSet | null }`
  - `interface WhatsAppPendingChoiceSet { phoneNumberId: string; waId: string; suggestionId: string; sourceMessageId: string; nonce: string; issuedAt: string; expiresAt: string; choices: readonly WhatsAppPendingChoice[] }`
  - `interface WhatsAppPendingChoice { payload: string; id: string; label: string; reply: string; detectorId: string | null; feedback: ChoiceFeedback; evidenceIndexes: readonly number[] }`

Constraints enforced here: WhatsApp reply-button title ≤ 20 chars; ≤ 3 buttons; button id ≤ 256 chars. The show-choices (null-detector) choice renders with `WHATSAPP_SHOW_CHOICES_LABEL`. Any other choice whose label > 20 chars raises `WhatsAppIntegrationError`.

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to sdk/tests/whatsapp.test.ts
import { buildWhatsAppSendRequest, WHATSAPP_SHOW_CHOICES_LABEL } from "../src/whatsapp.js";
import { WhatsAppIntegrationError } from "../src/whatsapp.js";
import type { WordlessSupportChatTurn } from "../src/server.js";

const INBOUND = { phoneNumberId: "111", waId: "1555", messageId: "wamid.1",
  receivedAt: "2023-11-14T22:13:20.000Z", type: "text", text: "charged twice", buttonPayload: null } as const;
const SIG = "sig-secret-000000000000000000000000";
const SUG = "sg_" + "b".repeat(32);

function turnBase(kind: WordlessSupportChatTurn["kind"]) {
  return { suggestionId: SUG, reviewRequired: true, readOnly: true, processingMs: 5, kind } as const;
}

describe("buildWhatsAppSendRequest", () => {
  it("maps a grounded_reply to a text message", () => {
    const turn = { ...turnBase("grounded_reply"), hostAction: "show_wordless", renderMode: "message",
      message: "Your last charge was $20 on Tuesday.", choices: [], detectorId: null, evidenceIndexes: [0], reason: null } as any;
    const { request, pendingChoices } = buildWhatsAppSendRequest(INBOUND, turn, SIG, "nonceAA", 1000, 2000);
    expect(request.path).toBe("/111/messages");
    expect((request.body as any).type).toBe("text");
    expect((request.body as any).text.body).toContain("last charge");
    expect(pendingChoices).toBeNull();
  });

  it("maps clarification_choices to interactive buttons with the short show-choices label", () => {
    const turn = { ...turnBase("clarification_choices"), hostAction: "show_wordless", renderMode: "choices",
      message: "Did you mean:", detectorId: "duplicate_charge", evidenceIndexes: [0], reason: null,
      choices: [
        { id: "c1", label: "A duplicate charge", reply: "I think I was charged twice.", detectorId: "duplicate_charge", evidenceIndexes: [0] },
        { id: "c2", label: "I don't know what to say", reply: "", detectorId: null, evidenceIndexes: [] },
      ] } as any;
    const { request, pendingChoices } = buildWhatsAppSendRequest(INBOUND, turn, SIG, "nonceAA", 1000, 2000);
    const buttons = (request.body as any).interactive.action.buttons;
    expect(buttons).toHaveLength(2);
    expect(buttons[0].reply.title).toBe("A duplicate charge");
    expect(buttons[1].reply.title).toBe(WHATSAPP_SHOW_CHOICES_LABEL);
    expect(buttons[0].reply.id.startsWith("wl2.")).toBe(true);
    expect(pendingChoices?.choices).toHaveLength(2);
  });

  it("raises on an over-long detector label", () => {
    const turn = { ...turnBase("clarification_choices"), hostAction: "show_wordless", renderMode: "choices",
      message: "Did you mean:", detectorId: "duplicate_charge", evidenceIndexes: [0], reason: null,
      choices: [
        { id: "c1", label: "This label is definitely longer than twenty", reply: "x", detectorId: "duplicate_charge", evidenceIndexes: [0] },
        { id: "c2", label: "I don't know what to say", reply: "", detectorId: null, evidenceIndexes: [] },
      ] } as any;
    expect(() => buildWhatsAppSendRequest(INBOUND, turn, SIG, "nonceAA", 1000, 2000)).toThrow(WhatsAppIntegrationError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdk && npx vitest run tests/whatsapp.test.ts`
Expected: FAIL — `buildWhatsAppSendRequest` not exported.

- [ ] **Step 3: Add the implementation (append to `whatsapp.ts`)**

Add imports at the top of `whatsapp.ts`:

```ts
import {
  classifyChoiceFeedback,
  createSignedChoicePayload,
  type ChoiceFeedback,
} from "./channel-support.js";
import type {
  WordlessSupportChatTurn,
  WordlessSupportChoice,
} from "./server.js";
```

Then append:

```ts
export type WhatsAppJsonValue =
  | null | boolean | number | string
  | readonly WhatsAppJsonValue[]
  | { readonly [key: string]: WhatsAppJsonValue };

export const WHATSAPP_SHOW_CHOICES_LABEL = "Not sure what to say";
const MAX_BUTTON_TITLE = 20;
const MAX_BUTTONS = 3;
const MAX_BUTTON_ID = 256;

export interface WhatsAppSendRequest {
  readonly method: "POST";
  readonly path: string;
  readonly body: WhatsAppJsonValue;
}

export interface WhatsAppPendingChoice {
  readonly payload: string;
  readonly id: string;
  readonly label: string;
  readonly reply: string;
  readonly detectorId: string | null;
  readonly feedback: ChoiceFeedback;
  readonly evidenceIndexes: readonly number[];
}

export interface WhatsAppPendingChoiceSet {
  readonly phoneNumberId: string;
  readonly waId: string;
  readonly suggestionId: string;
  readonly sourceMessageId: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly choices: readonly WhatsAppPendingChoice[];
}

function buttonTitle(turn: WordlessSupportChatTurn, choice: WordlessSupportChoice): string {
  const label = choice.detectorId === null ? WHATSAPP_SHOW_CHOICES_LABEL : choice.label;
  if (label.length > MAX_BUTTON_TITLE) {
    throw new WhatsAppIntegrationError(
      `WhatsApp reply-button title must be at most ${MAX_BUTTON_TITLE} characters: "${label}".`,
    );
  }
  return label;
}

function textBody(waId: string, text: string): WhatsAppJsonValue {
  return Object.freeze({
    messaging_product: "whatsapp", recipient_type: "individual", to: waId,
    type: "text", text: Object.freeze({ body: text, preview_url: false }),
  });
}

export function buildWhatsAppSendRequest(
  inbound: WhatsAppInboundMessage,
  turn: WordlessSupportChatTurn,
  signingSecret: string,
  nonce: string,
  issuedAtSeconds: number,
  expiresAtSeconds: number,
): { readonly request: WhatsAppSendRequest; readonly pendingChoices: WhatsAppPendingChoiceSet | null } {
  if (turn.message === null) {
    throw new WhatsAppIntegrationError("A visible WhatsApp turn must contain a message.");
  }
  const path = `/${encodeURIComponent(inbound.phoneNumberId)}/messages`;
  if (turn.renderMode !== "choices" || turn.choices.length === 0) {
    return Object.freeze({ request: Object.freeze({ method: "POST" as const, path, body: textBody(inbound.waId, turn.message) }), pendingChoices: null });
  }
  if (turn.choices.length > MAX_BUTTONS) {
    throw new WhatsAppIntegrationError(`WhatsApp supports at most ${MAX_BUTTONS} reply buttons.`);
  }
  const pending: WhatsAppPendingChoice[] = [];
  const buttons = turn.choices.map((choice) => {
    const feedback = classifyChoiceFeedback(turn.kind, choice.detectorId);
    const payload = createSignedChoicePayload({
      bindingParts: [inbound.phoneNumberId, inbound.waId],
      suggestionId: turn.suggestionId, choiceId: choice.id, detectorId: choice.detectorId,
      feedback, issuedAtSeconds, expiresAtSeconds, nonce, signingSecret,
    });
    if (payload.length > MAX_BUTTON_ID) {
      throw new WhatsAppIntegrationError("WhatsApp reply-button id exceeds 256 characters.");
    }
    const title = buttonTitle(turn, choice);
    pending.push(Object.freeze({
      payload, id: choice.id, label: title, reply: choice.reply,
      detectorId: choice.detectorId, feedback, evidenceIndexes: choice.evidenceIndexes,
    }));
    return Object.freeze({ type: "reply", reply: Object.freeze({ id: payload, title }) });
  });
  const body: WhatsAppJsonValue = Object.freeze({
    messaging_product: "whatsapp", recipient_type: "individual", to: inbound.waId,
    type: "interactive",
    interactive: Object.freeze({
      type: "button",
      body: Object.freeze({ text: turn.message }),
      action: Object.freeze({ buttons: Object.freeze(buttons) }),
    }),
  });
  const pendingChoices: WhatsAppPendingChoiceSet = Object.freeze({
    phoneNumberId: inbound.phoneNumberId, waId: inbound.waId, suggestionId: turn.suggestionId,
    sourceMessageId: inbound.messageId, nonce,
    issuedAt: new Date(issuedAtSeconds * 1_000).toISOString(),
    expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
    choices: Object.freeze(pending),
  });
  return Object.freeze({ request: Object.freeze({ method: "POST" as const, path, body }), pendingChoices });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdk && npx vitest run tests/whatsapp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/whatsapp.ts sdk/tests/whatsapp.test.ts
git commit -m "feat(sdk): WhatsApp turn-to-send-request mapping with button constraints"
```

---

## Task 6: WhatsApp adapter — full inbound flow (`whatsapp.ts`)

**Files:**
- Modify: `sdk/src/whatsapp.ts`
- Test: `sdk/tests/whatsapp.test.ts` (add cases)

**Interfaces:**
- Consumes: `WordlessSupportChatbot`, `WordlessSupportChatTurn`, `WordlessEvidence`, `WordlessJsonValue`, `WordlessSdkError` from `./server.js`; `verifySignedChoicePayload` from `./channel-support.js`; the Task 3–5 exports.
- Produces:
  - `interface WhatsAppAuthenticatedAccount { authenticated: true; customerId: string; observedAt: string; evidence: readonly WordlessEvidence[]; metadata?: Readonly<Record<string, WordlessJsonValue>> }`
  - `interface WhatsAppChoiceStore { save(set: WhatsAppPendingChoiceSet): Promise<void>; resolve(input: WhatsAppChoiceResolveInput): Promise<WhatsAppResolvedChoice | null> }`
  - `interface WhatsAppChoiceResolveInput { phoneNumberId: string; waId: string; payload: string; selectionMessageId: string; selectionReceivedAt: string; nonce: string }`
  - `interface WhatsAppResolvedChoice { suggestionId: string; choiceId: string; detectorId: string | null; reply: string; feedback: ChoiceFeedback }`
  - `type WhatsAppResult = WhatsAppPostMessageResult | WhatsAppContinueResult | WhatsAppHandoffResult | WhatsAppIgnoredResult`
  - `function createWhatsAppCloudAdapter(options: WhatsAppCloudAdapterOptions): { processWebhook(rawBody: string, signatureHeader: string | null): Promise<readonly WhatsAppResult[]> }`

Result shapes (each carries `deduplicationKey = inbound.messageId` where applicable):
- `WhatsAppPostMessageResult { kind: "post_message"; inbound; deduplicationKey; request: WhatsAppSendRequest; pendingChoices: WhatsAppPendingChoiceSet | null; wordless: { suggestionId; outcome; evidenceIndexes } }`
- `WhatsAppContinueResult { kind: "continue"; inbound; deduplicationKey; reason: WhatsAppContinueReason }`
- `WhatsAppHandoffResult { kind: "handoff"; inbound; deduplicationKey; reason: "human_requested" }`
- `WhatsAppIgnoredResult { kind: "ignored"; reason: "status" | "unsupported_type" | "wrong_number"; messageId: string | null }`
- `type WhatsAppContinueReason = "account_not_authenticated" | "wordless_unavailable" | "continue_host_bot" | "choice_replayed"`

`WhatsAppCloudAdapterOptions`: `{ chatbot; appSecret; phoneNumberId; choiceSigningSecret; resolveAuthenticatedAccount; choiceStore; humanHandoff?: { enabled: boolean }; accountResolutionFailureMode?: "throw" | "continue"; choiceTtlMs?: number; now?: () => Date; onWordlessError?; onAccountResolutionError?; onFeedbackError? }`.

- [ ] **Step 1: Write the failing test (append)** — an in-memory store + fake chatbot exercise the happy paths and safe fallbacks.

```ts
// append to sdk/tests/whatsapp.test.ts
import { createWhatsAppCloudAdapter } from "../src/whatsapp.js";
import type { WhatsAppChoiceStore, WhatsAppPendingChoiceSet, WhatsAppResolvedChoice } from "../src/whatsapp.js";

const APP = "meta-app-secret-000000000000000000";
function signBody(b: string) { return "sha256=" + createHmac("sha256", APP).update(b, "utf8").digest("hex"); }
const FIXED = () => new Date("2023-11-14T22:13:30.000Z");

function memoryStore(): WhatsAppChoiceStore {
  const sets = new Map<string, WhatsAppPendingChoiceSet>();
  const consumed = new Map<string, WhatsAppResolvedChoice>();
  return {
    async save(set) { for (const c of set.choices) sets.set(`${set.phoneNumberId}:${set.waId}:${c.payload}`, set); },
    async resolve(input) {
      const key = `${input.phoneNumberId}:${input.waId}:${input.payload}`;
      const set = sets.get(key);
      if (!set) return consumed.get(input.selectionMessageId) ?? null;
      const choice = set.choices.find((c) => c.payload === input.payload)!;
      const resolved: WhatsAppResolvedChoice = { suggestionId: set.suggestionId, choiceId: choice.id,
        detectorId: choice.detectorId, reply: choice.reply, feedback: choice.feedback };
      sets.delete(key); consumed.set(input.selectionMessageId, resolved);
      return resolved;
    },
  };
}

function clarifyChatbot() {
  return {
    async processMessage() {
      return { kind: "clarification_choices", hostAction: "show_wordless", renderMode: "choices",
        suggestionId: "sg_" + "c".repeat(32), reviewRequired: true, readOnly: true, processingMs: 3,
        message: "Did you mean:", detectorId: "duplicate_charge", evidenceIndexes: [0], reason: null,
        choices: [
          { id: "c1", label: "A duplicate charge", reply: "I was charged twice.", detectorId: "duplicate_charge", evidenceIndexes: [0] },
          { id: "c2", label: "x", reply: "", detectorId: null, evidenceIndexes: [] },
        ] } as any;
    },
    async recordConfirmation() { return { feedback_id: "fb_" + "0".repeat(32), recorded: true } as any; },
  };
}

const account = { authenticated: true as const, customerId: "acct_42",
  observedAt: "2023-11-14T22:13:25.000Z", evidence: [] };

function textWebhook(body: string) {
  return JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "e1", changes: [{ field: "messages", value: {
    metadata: { phone_number_id: "111" }, contacts: [{ wa_id: "1555" }],
    messages: [{ from: "1555", id: "wamid.text", timestamp: "1700000000", type: "text", text: { body } }] } }] }] });
}

describe("createWhatsAppCloudAdapter", () => {
  it("posts clarification buttons for a supportable message", async () => {
    const store = memoryStore();
    const adapter = createWhatsAppCloudAdapter({ chatbot: clarifyChatbot() as any, appSecret: APP, phoneNumberId: "111",
      choiceSigningSecret: "sig-secret-000000000000000000000000", resolveAuthenticatedAccount: async () => account,
      choiceStore: store, now: FIXED });
    const raw = textWebhook("charged twice");
    const [result] = await adapter.processWebhook(raw, signBody(raw));
    expect(result.kind).toBe("post_message");
    expect((result as any).request.body.type).toBe("interactive");
  });

  it("rejects a bad signature", async () => {
    const adapter = createWhatsAppCloudAdapter({ chatbot: clarifyChatbot() as any, appSecret: APP, phoneNumberId: "111",
      choiceSigningSecret: "sig-secret-000000000000000000000000", resolveAuthenticatedAccount: async () => account,
      choiceStore: memoryStore(), now: FIXED });
    await expect(adapter.processWebhook(textWebhook("x"), "sha256=bad")).rejects.toThrow();
  });

  it("continues the host bot when the account is unauthenticated", async () => {
    const adapter = createWhatsAppCloudAdapter({ chatbot: clarifyChatbot() as any, appSecret: APP, phoneNumberId: "111",
      choiceSigningSecret: "sig-secret-000000000000000000000000", resolveAuthenticatedAccount: async () => null,
      choiceStore: memoryStore(), now: FIXED });
    const raw = textWebhook("charged twice");
    const [result] = await adapter.processWebhook(raw, signBody(raw));
    expect(result).toMatchObject({ kind: "continue", reason: "account_not_authenticated" });
  });

  it("continues safely on a Wordless error", async () => {
    const failing = { processMessage: async () => { const e: any = new Error("boom"); e.name = "WordlessSdkError"; throw e; },
      recordConfirmation: async () => ({}) } as any;
    const errors: unknown[] = [];
    const adapter = createWhatsAppCloudAdapter({ chatbot: failing, appSecret: APP, phoneNumberId: "111",
      choiceSigningSecret: "sig-secret-000000000000000000000000", resolveAuthenticatedAccount: async () => account,
      choiceStore: memoryStore(), now: FIXED, onWordlessError: (e) => errors.push(e) });
    const raw = textWebhook("charged twice");
    const [result] = await adapter.processWebhook(raw, signBody(raw));
    expect(result).toMatchObject({ kind: "continue", reason: "wordless_unavailable" });
    expect(errors).toHaveLength(1);
  });

  it("resolves a tapped button once and records confirmation", async () => {
    const store = memoryStore();
    const recorded: unknown[] = [];
    const chatbot = { ...clarifyChatbot(), recordConfirmation: async (c: unknown) => { recorded.push(c); return {} as any; } };
    const adapter = createWhatsAppCloudAdapter({ chatbot: chatbot as any, appSecret: APP, phoneNumberId: "111",
      choiceSigningSecret: "sig-secret-000000000000000000000000", resolveAuthenticatedAccount: async () => account,
      choiceStore: store, now: FIXED });
    const raw = textWebhook("charged twice");
    const [posted] = await adapter.processWebhook(raw, signBody(raw));
    const payload = (posted as any).request.body.interactive.action.buttons[0].reply.id as string;
    const tap = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "e", changes: [{ field: "messages", value: {
      metadata: { phone_number_id: "111" }, contacts: [{ wa_id: "1555" }],
      messages: [{ from: "1555", id: "wamid.tap", timestamp: "1700000005", type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: payload, title: "A duplicate charge" } } }] } }] }] });
    const [replyResult] = await adapter.processWebhook(tap, signBody(tap));
    expect(replyResult.kind).toBe("post_message");
    expect((replyResult as any).request.body.text.body).toContain("charged twice");
    expect(recorded).toHaveLength(1);
    // A replay of the same payload with a new message id resolves to null → continue.
    const replay = tap.replace("wamid.tap", "wamid.tap2");
    const [replayResult] = await adapter.processWebhook(replay, signBody(replay));
    expect(replayResult).toMatchObject({ kind: "continue", reason: "choice_replayed" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdk && npx vitest run tests/whatsapp.test.ts`
Expected: FAIL — `createWhatsAppCloudAdapter` not exported.

- [ ] **Step 3: Add the implementation (append to `whatsapp.ts`)**

Extend the top imports of `whatsapp.ts`:

```ts
import {
  classifyChoiceFeedback,
  createSignedChoicePayload,
  verifySignedChoicePayload,
  type ChoiceFeedback,
} from "./channel-support.js";
import {
  WordlessSdkError,
  type WordlessEvidence,
  type WordlessJsonValue,
  type WordlessSupportChatbot,
  type WordlessSupportChatTurn,
  type WordlessSupportChoice,
} from "./server.js";
```

Then append:

```ts
const DEFAULT_CHOICE_TTL_MS = 30 * 60 * 1_000;
const MAX_CHOICE_TTL_MS = 24 * 60 * 60 * 1_000;

export interface WhatsAppAuthenticatedAccount {
  readonly authenticated: true;
  readonly customerId: string;
  readonly observedAt: string;
  readonly evidence: readonly WordlessEvidence[];
  readonly metadata?: Readonly<Record<string, WordlessJsonValue>>;
}

export interface WhatsAppChoiceResolveInput {
  readonly phoneNumberId: string;
  readonly waId: string;
  readonly payload: string;
  readonly selectionMessageId: string;
  readonly selectionReceivedAt: string;
  readonly nonce: string;
}

export interface WhatsAppResolvedChoice {
  readonly suggestionId: string;
  readonly choiceId: string;
  readonly detectorId: string | null;
  readonly reply: string;
  readonly feedback: ChoiceFeedback;
}

export interface WhatsAppChoiceStore {
  save(set: WhatsAppPendingChoiceSet): Promise<void>;
  resolve(input: WhatsAppChoiceResolveInput): Promise<WhatsAppResolvedChoice | null>;
}

export type WhatsAppContinueReason =
  | "account_not_authenticated" | "wordless_unavailable" | "continue_host_bot" | "choice_replayed";

interface WhatsAppResultBase { readonly inbound: WhatsAppInboundMessage; readonly deduplicationKey: string; }

export interface WhatsAppPostMessageResult extends WhatsAppResultBase {
  readonly kind: "post_message";
  readonly request: WhatsAppSendRequest;
  readonly pendingChoices: WhatsAppPendingChoiceSet | null;
  readonly wordless: { readonly suggestionId: string; readonly outcome: WordlessSupportChatTurn["kind"]; readonly evidenceIndexes: readonly number[]; };
}
export interface WhatsAppContinueResult extends WhatsAppResultBase { readonly kind: "continue"; readonly reason: WhatsAppContinueReason; }
export interface WhatsAppHandoffResult extends WhatsAppResultBase { readonly kind: "handoff"; readonly reason: "human_requested"; }
export interface WhatsAppIgnoredResult { readonly kind: "ignored"; readonly reason: "status" | "unsupported_type" | "wrong_number"; readonly messageId: string | null; }
export type WhatsAppResult = WhatsAppPostMessageResult | WhatsAppContinueResult | WhatsAppHandoffResult | WhatsAppIgnoredResult;

export interface WhatsAppCloudAdapterOptions {
  readonly chatbot: WordlessSupportChatbot;
  readonly appSecret: string;
  readonly phoneNumberId: string;
  readonly choiceSigningSecret: string;
  readonly resolveAuthenticatedAccount: (inbound: WhatsAppInboundMessage) => Promise<WhatsAppAuthenticatedAccount | null>;
  readonly choiceStore: WhatsAppChoiceStore;
  readonly humanHandoff?: { readonly enabled: boolean };
  readonly accountResolutionFailureMode?: "throw" | "continue";
  readonly choiceTtlMs?: number;
  readonly now?: () => Date;
  readonly onWordlessError?: (error: WordlessSdkError, inbound: WhatsAppInboundMessage) => void;
  readonly onAccountResolutionError?: (error: unknown, inbound: WhatsAppInboundMessage) => void;
  readonly onFeedbackError?: (error: unknown, inbound: WhatsAppInboundMessage) => void;
}

export interface WhatsAppCloudAdapter {
  processWebhook(rawBody: string, signatureHeader: string | null): Promise<readonly WhatsAppResult[]>;
}

function randomNonce(): string {
  // A per-choice-set random value; not time-derived, so it does not violate the injected-clock rule.
  return randomBytes(12).toString("base64url");
}

export function createWhatsAppCloudAdapter(options: WhatsAppCloudAdapterOptions): WhatsAppCloudAdapter {
  const ttl = options.choiceTtlMs ?? DEFAULT_CHOICE_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > MAX_CHOICE_TTL_MS) {
    throw new WhatsAppIntegrationError("choiceTtlMs must be between one minute and 24 hours.");
  }
  const now = options.now ?? (() => new Date());
  const humanEnabled = options.humanHandoff?.enabled === true;

  async function handleTextMessage(inbound: WhatsAppInboundMessage): Promise<WhatsAppResult> {
    if (humanEnabled && inbound.text !== null && detectHumanRequest(inbound.text)) {
      return Object.freeze({ kind: "handoff" as const, inbound, deduplicationKey: inbound.messageId, reason: "human_requested" as const });
    }
    let account: WhatsAppAuthenticatedAccount | null;
    try {
      account = await options.resolveAuthenticatedAccount(inbound);
    } catch (error) {
      if ((options.accountResolutionFailureMode ?? "throw") === "continue") {
        options.onAccountResolutionError?.(error, inbound);
        return Object.freeze({ kind: "continue" as const, inbound, deduplicationKey: inbound.messageId, reason: "account_not_authenticated" as const });
      }
      throw error;
    }
    if (account === null) {
      return Object.freeze({ kind: "continue" as const, inbound, deduplicationKey: inbound.messageId, reason: "account_not_authenticated" as const });
    }
    let turn: WordlessSupportChatTurn;
    try {
      turn = await options.chatbot.processMessage({
        messageId: inbound.messageId, customerId: account.customerId, text: inbound.text ?? "",
        sentAt: inbound.receivedAt, observedAt: account.observedAt, channel: "chat",
        evidence: account.evidence, metadata: account.metadata,
        showChoices: isShowChoicesRequest(inbound.text, false),
      });
    } catch (error) {
      if (error instanceof WordlessSdkError) {
        options.onWordlessError?.(error, inbound);
        return Object.freeze({ kind: "continue" as const, inbound, deduplicationKey: inbound.messageId, reason: "wordless_unavailable" as const });
      }
      throw error;
    }
    if (turn.hostAction === "continue_host_bot") {
      return Object.freeze({ kind: "continue" as const, inbound, deduplicationKey: inbound.messageId, reason: "continue_host_bot" as const });
    }
    const issuedAtSeconds = Math.floor(now().getTime() / 1_000);
    const expiresAtSeconds = issuedAtSeconds + Math.ceil(ttl / 1_000);
    const { request, pendingChoices } = buildWhatsAppSendRequest(inbound, turn, options.choiceSigningSecret, randomNonce(), issuedAtSeconds, expiresAtSeconds);
    if (pendingChoices !== null) await options.choiceStore.save(pendingChoices);
    return Object.freeze({ kind: "post_message" as const, inbound, deduplicationKey: inbound.messageId, request, pendingChoices,
      wordless: Object.freeze({ suggestionId: turn.suggestionId, outcome: turn.kind, evidenceIndexes: turn.evidenceIndexes }) });
  }

  async function handleButtonReply(inbound: WhatsAppInboundMessage): Promise<WhatsAppResult> {
    const payload = inbound.buttonPayload!;
    const verified = verifySignedChoicePayload({
      payload, bindingParts: [inbound.phoneNumberId, inbound.waId],
      signingSecret: options.choiceSigningSecret, nowSeconds: Math.floor(now().getTime() / 1_000),
    });
    if (verified === null) {
      return Object.freeze({ kind: "continue" as const, inbound, deduplicationKey: inbound.messageId, reason: "choice_replayed" as const });
    }
    const resolved = await options.choiceStore.resolve({
      phoneNumberId: inbound.phoneNumberId, waId: inbound.waId, payload,
      selectionMessageId: inbound.messageId, selectionReceivedAt: inbound.receivedAt, nonce: verified.nonce,
    });
    if (resolved === null) {
      return Object.freeze({ kind: "continue" as const, inbound, deduplicationKey: inbound.messageId, reason: "choice_replayed" as const });
    }
    try {
      await options.chatbot.recordConfirmation({
        suggestionId: resolved.suggestionId, selectedDetectorId: resolved.detectorId,
        actor: "customer", decisionId: inbound.messageId,
      });
    } catch (error) {
      options.onFeedbackError?.(error, inbound);
    }
    const request: WhatsAppSendRequest = Object.freeze({ method: "POST" as const,
      path: `/${encodeURIComponent(inbound.phoneNumberId)}/messages`,
      body: textBody(inbound.waId, resolved.reply.length > 0 ? resolved.reply : "Thanks — noted.") });
    return Object.freeze({ kind: "post_message" as const, inbound, deduplicationKey: inbound.messageId, request, pendingChoices: null,
      wordless: Object.freeze({ suggestionId: resolved.suggestionId, outcome: "clarification_choices" as const, evidenceIndexes: Object.freeze([]) }) });
  }

  return Object.freeze({
    async processWebhook(rawBody, signatureHeader) {
      if (!verifyWhatsAppSignature(rawBody, signatureHeader, options.appSecret)) {
        throw new WhatsAppWebhookValidationError("WhatsApp webhook signature is invalid.");
      }
      let parsedBody: unknown;
      try { parsedBody = JSON.parse(rawBody); } catch { throw new WhatsAppWebhookValidationError("WhatsApp webhook body is not valid JSON."); }
      const entries = parseWhatsAppEnvelope(parsedBody, options.phoneNumberId);
      const results: WhatsAppResult[] = [];
      for (const entry of entries) {
        if (entry.kind === "ignored") { results.push(entry); continue; }
        results.push(entry.inbound.type === "text" ? await handleTextMessage(entry.inbound) : await handleButtonReply(entry.inbound));
      }
      return Object.freeze(results);
    },
  });
}
```

Also add `detectHumanRequest` and `isShowChoicesRequest` to the `./channel-support.js` import, and add `randomBytes` to the `node:crypto` import at the top of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdk && npx vitest run tests/whatsapp.test.ts`
Expected: PASS (all cases, including replay → continue).

- [ ] **Step 5: Commit**

```bash
git add sdk/src/whatsapp.ts sdk/tests/whatsapp.test.ts
git commit -m "feat(sdk): WhatsApp Cloud adapter with safe fallbacks and one-time choices"
```

---

## Task 7: WhatsApp packaging — export, example, README, full build

**Files:**
- Modify: `sdk/package.json` (add `./whatsapp` export)
- Create: `sdk/examples/whatsapp-cloud-handler.ts`
- Create: `sdk/integrations/whatsapp/README.md`

**Interfaces:**
- Consumes: all Task 3–6 exports; `createSupportChatbotAdapter`, `createWordlessClient` from `@wordless/sdk/server`.

- [ ] **Step 1: Add the subpath export to `sdk/package.json`**

Insert after the `./zendesk` export block:

```json
    "./whatsapp": {
      "types": "./dist/types/whatsapp.d.ts",
      "node": {
        "import": "./dist/esm/whatsapp.js",
        "default": "./dist/esm/whatsapp.js"
      }
    },
```

- [ ] **Step 2: Write the example handler**

```ts
// sdk/examples/whatsapp-cloud-handler.ts
import {
  createSupportChatbotAdapter,
  createWordlessClient,
} from "@wordless/sdk/server";
import {
  createWhatsAppCloudAdapter,
  verifyWhatsAppSubscription,
  type WhatsAppAuthenticatedAccount,
  type WhatsAppChoiceStore,
  type WhatsAppInboundMessage,
} from "@wordless/sdk/whatsapp";

interface Config {
  readonly appSecret: string;
  readonly phoneNumberId: string;
  readonly verifyToken: string;
  readonly choiceSigningSecret: string;
  readonly wordlessBaseUrl: string;
  readonly wordlessApiKey: string;
  readonly wordlessSigningSecret: string;
}

interface Dependencies {
  readonly resolveAuthenticatedAccount: (inbound: WhatsAppInboundMessage) => Promise<WhatsAppAuthenticatedAccount | null>;
  readonly choiceStore: WhatsAppChoiceStore;
  readonly sendToWhatsApp: (request: { readonly method: "POST"; readonly path: string; readonly body: unknown }) => Promise<void>;
}

export function createWhatsAppHttpHandlers(config: Config, deps: Dependencies) {
  const chatbot = createSupportChatbotAdapter({
    client: createWordlessClient({ baseUrl: config.wordlessBaseUrl, apiKey: config.wordlessApiKey, signingSecret: config.wordlessSigningSecret }),
    sourceSystem: "whatsapp",
  });
  const adapter = createWhatsAppCloudAdapter({
    chatbot, appSecret: config.appSecret, phoneNumberId: config.phoneNumberId,
    choiceSigningSecret: config.choiceSigningSecret,
    resolveAuthenticatedAccount: deps.resolveAuthenticatedAccount,
    choiceStore: deps.choiceStore, humanHandoff: { enabled: true },
  });

  return {
    // GET /webhooks/whatsapp — Meta subscription handshake.
    verifySubscription(query: { mode: string | null; token: string | null; challenge: string | null }): string {
      return verifyWhatsAppSubscription(query, config.verifyToken);
    },
    // POST /webhooks/whatsapp — deliver the exact raw body and the X-Hub-Signature-256 header.
    async handleWebhook(rawBody: string, signatureHeader: string | null): Promise<void> {
      const results = await adapter.processWebhook(rawBody, signatureHeader);
      for (const result of results) {
        if (result.kind === "post_message") {
          await deps.sendToWhatsApp(result.request); // host claims result.deduplicationKey first for idempotency
        }
        // "continue" → let the host's own bot answer; "handoff" → route to a human inbox; "ignored" → no-op.
      }
    },
  };
}
```

- [ ] **Step 3: Write the integration README**

Create `sdk/integrations/whatsapp/README.md` with: the universal-preference and read-only framing (mirroring `sdk/integrations/zendesk/README.md`), the WhatsApp Cloud API surface used (`/{phone-number-id}/messages`, interactive reply buttons, `X-Hub-Signature-256`, the GET verify handshake), the 3-button / 20-char-title constraint and the `WHATSAPP_SHOW_CHOICES_LABEL` substitution, links to Meta's current docs (Cloud API webhooks, interactive messages), and the exact `resolveAuthenticatedAccount` contract (map an authenticated WhatsApp identity to a company account; never treat `wa_id` as the account id; load point-in-time read-only evidence at or before the message time).

- [ ] **Step 4: Typecheck, test, and build the whole SDK**

Run:
```bash
cd sdk && npm install && npm run typecheck && npm test && npm run build
```
Expected: typecheck clean; all tests (channel-support, whatsapp, plus existing zendesk/server/index/chatbot) PASS; build emits `dist/esm/whatsapp.js` and `dist/types/whatsapp.d.ts`.

- [ ] **Step 5: Commit and open PR 1**

```bash
git add sdk/package.json sdk/examples/whatsapp-cloud-handler.ts sdk/integrations/whatsapp/README.md
git commit -m "feat(sdk): WhatsApp packaging, example handler, and integration guide"
git push -u origin feature/whatsapp-slack-live-channels
gh pr create --base main --title "WhatsApp Cloud API evidence-first live channel" --body "Adds a read-only WhatsApp Cloud API live channel on the existing support-chatbot adapter, plus a shared channel-support module. Mirrors the Zendesk module's signed-payload, one-time-choice, and safe-fallback discipline. Offline-tested via vitest; no new service or credentials."
```

---

# Phase 2 — PR 2: Slack channel

## Task 8: Slack signature & URL verification (`slack.ts`)

**Files:**
- Create: `sdk/src/slack.ts`
- Test: `sdk/tests/slack.test.ts`

**Interfaces:**
- Produces:
  - `class SlackIntegrationError extends Error`, `class SlackWebhookValidationError extends SlackIntegrationError`
  - `function verifySlackSignature(rawBody: string, headers: { signature: string | null; timestamp: string | null }, signingSecret: string, now: () => Date): boolean`
  - `function verifySlackUrlVerification(parsedBody: unknown): string | null` — returns `challenge` when `type === "url_verification"`, else `null`.

- [ ] **Step 1: Write the failing test**

```ts
// sdk/tests/slack.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature, verifySlackUrlVerification } from "../src/slack.js";

const SECRET = "slack-signing-secret-0000000000000000";
const NOW = () => new Date("2023-11-14T22:13:30.000Z");
const TS = String(Math.floor(NOW().getTime() / 1000));
function sign(body: string, ts = TS) {
  return "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${body}`, "utf8").digest("hex");
}

describe("verifySlackSignature", () => {
  it("accepts a valid signature and rejects tampering, wrong secret, and stale timestamps", () => {
    const body = "payload=x";
    expect(verifySlackSignature(body, { signature: sign(body), timestamp: TS }, SECRET, NOW)).toBe(true);
    expect(verifySlackSignature(body, { signature: "v0=bad", timestamp: TS }, SECRET, NOW)).toBe(false);
    const staleTs = String(Math.floor(NOW().getTime() / 1000) - 600);
    expect(verifySlackSignature(body, { signature: sign(body, staleTs), timestamp: staleTs }, SECRET, NOW)).toBe(false);
    expect(verifySlackSignature(body, { signature: null, timestamp: TS }, SECRET, NOW)).toBe(false);
  });
});

describe("verifySlackUrlVerification", () => {
  it("returns the challenge only for url_verification", () => {
    expect(verifySlackUrlVerification({ type: "url_verification", challenge: "c1" })).toBe("c1");
    expect(verifySlackUrlVerification({ type: "event_callback" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdk && npx vitest run tests/slack.test.ts`
Expected: FAIL — cannot find module `../src/slack.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// sdk/src/slack.ts
import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export class SlackIntegrationError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message);
    this.name = "SlackIntegrationError";
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", { configurable: true, value: options.cause, writable: true });
    }
  }
}
export class SlackWebhookValidationError extends SlackIntegrationError {
  constructor(message: string) { super(message); this.name = "SlackWebhookValidationError"; }
}

export function verifySlackSignature(
  rawBody: string,
  headers: { readonly signature: string | null; readonly timestamp: string | null },
  signingSecret: string,
  now: () => Date,
): boolean {
  if (typeof rawBody !== "string" || typeof headers.signature !== "string" || typeof headers.timestamp !== "string") return false;
  if (!/^\d{1,15}$/u.test(headers.timestamp)) return false;
  const nowSeconds = Math.floor(now().getTime() / 1_000);
  if (Math.abs(nowSeconds - Number.parseInt(headers.timestamp, 10)) > MAX_TIMESTAMP_SKEW_SECONDS) return false;
  const expected = "v0=" + createHmac("sha256", Buffer.from(signingSecret, "utf8"))
    .update(`v0:${headers.timestamp}:${rawBody}`, "utf8").digest("hex");
  const providedBuf = Buffer.from(headers.signature, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

export function verifySlackUrlVerification(parsedBody: unknown): string | null {
  if (typeof parsedBody !== "object" || parsedBody === null) return null;
  const body = parsedBody as Record<string, unknown>;
  if (body.type !== "url_verification") return null;
  if (typeof body.challenge !== "string" || body.challenge.length === 0) {
    throw new SlackWebhookValidationError("Missing Slack url_verification challenge.");
  }
  return body.challenge;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdk && npx vitest run tests/slack.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/slack.ts sdk/tests/slack.test.ts
git commit -m "feat(sdk): Slack request signing and URL verification"
```

---

## Task 9: Slack event & interaction parsing (`slack.ts`)

**Files:**
- Modify: `sdk/src/slack.ts`
- Test: `sdk/tests/slack.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `interface SlackInboundMessage { teamId: string; channelId: string; userId: string; messageTs: string; text: string }`
  - `interface SlackInboundAction { teamId: string; channelId: string; userId: string; actionTs: string; responseUrl: string | null; value: string }`
  - `function parseSlackMessageEvent(parsedBody: unknown, selfBotUserId: string): SlackInboundMessage | { ignored: "not_a_user_message" }`
  - `function parseSlackBlockActions(parsedPayload: unknown): SlackInboundAction | { ignored: "not_a_button_action" }`

Ignore rules: ignore events with `bot_id`, a `subtype` (e.g. `bot_message`, `message_changed`, `message_deleted`), or `user === selfBotUserId`.

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to sdk/tests/slack.test.ts
import { parseSlackBlockActions, parseSlackMessageEvent } from "../src/slack.js";

describe("parseSlackMessageEvent", () => {
  it("parses a user message and ignores bot/self/subtype events", () => {
    const body = { type: "event_callback", team_id: "T1",
      event: { type: "message", channel: "C1", user: "U1", ts: "1700000000.1", text: "charged twice" } };
    expect(parseSlackMessageEvent(body, "UBOT")).toMatchObject({ teamId: "T1", channelId: "C1", userId: "U1", messageTs: "1700000000.1", text: "charged twice" });
    expect(parseSlackMessageEvent({ type: "event_callback", team_id: "T1", event: { type: "message", channel: "C1", user: "U1", ts: "1", text: "x", bot_id: "B1" } }, "UBOT")).toMatchObject({ ignored: "not_a_user_message" });
    expect(parseSlackMessageEvent({ type: "event_callback", team_id: "T1", event: { type: "message", channel: "C1", user: "U1", ts: "1", subtype: "message_changed" } }, "UBOT")).toMatchObject({ ignored: "not_a_user_message" });
    expect(parseSlackMessageEvent({ type: "event_callback", team_id: "T1", event: { type: "message", channel: "C1", user: "UBOT", ts: "1", text: "x" } }, "UBOT")).toMatchObject({ ignored: "not_a_user_message" });
  });
});

describe("parseSlackBlockActions", () => {
  it("parses a button action and ignores non-button payloads", () => {
    const payload = { type: "block_actions", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
      response_url: "https://hooks.slack.test/1", actions: [{ type: "button", action_id: "c1", value: "wl2.sg.x", action_ts: "1700000005.5" }] };
    expect(parseSlackBlockActions(payload)).toMatchObject({ teamId: "T1", channelId: "C1", userId: "U1", value: "wl2.sg.x", responseUrl: "https://hooks.slack.test/1" });
    expect(parseSlackBlockActions({ type: "shortcut" })).toMatchObject({ ignored: "not_a_button_action" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdk && npx vitest run tests/slack.test.ts`
Expected: FAIL — parsers not exported.

- [ ] **Step 3: Add the implementation (append to `slack.ts`)**

```ts
// append to sdk/src/slack.ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

export interface SlackInboundMessage {
  readonly teamId: string; readonly channelId: string; readonly userId: string;
  readonly messageTs: string; readonly text: string;
}
export interface SlackInboundAction {
  readonly teamId: string; readonly channelId: string; readonly userId: string;
  readonly actionTs: string; readonly responseUrl: string | null; readonly value: string;
}

export function parseSlackMessageEvent(parsedBody: unknown, selfBotUserId: string): SlackInboundMessage | { readonly ignored: "not_a_user_message" } {
  if (!isRecord(parsedBody) || parsedBody.type !== "event_callback" || !isRecord(parsedBody.event)) return { ignored: "not_a_user_message" };
  const event = parsedBody.event;
  if (event.type !== "message" || event.bot_id !== undefined || event.subtype !== undefined) return { ignored: "not_a_user_message" };
  const teamId = str(parsedBody.team_id, 64);
  const channelId = str(event.channel, 64);
  const userId = str(event.user, 64);
  const messageTs = str(event.ts, 64);
  const text = typeof event.text === "string" ? event.text.slice(0, 4_000) : "";
  if (teamId === null || channelId === null || userId === null || messageTs === null || userId === selfBotUserId) {
    return { ignored: "not_a_user_message" };
  }
  return Object.freeze({ teamId, channelId, userId, messageTs, text });
}

export function parseSlackBlockActions(parsedPayload: unknown): SlackInboundAction | { readonly ignored: "not_a_button_action" } {
  if (!isRecord(parsedPayload) || parsedPayload.type !== "block_actions" || !Array.isArray(parsedPayload.actions)) return { ignored: "not_a_button_action" };
  const action = parsedPayload.actions.find((a) => isRecord(a) && a.type === "button");
  if (!isRecord(action)) return { ignored: "not_a_button_action" };
  const team = isRecord(parsedPayload.team) ? str(parsedPayload.team.id, 64) : null;
  const user = isRecord(parsedPayload.user) ? str(parsedPayload.user.id, 64) : null;
  const channel = isRecord(parsedPayload.channel) ? str(parsedPayload.channel.id, 64) : null;
  const value = str(action.value, 2_000);
  const actionTs = str(action.action_ts, 64) ?? str(parsedPayload.action_ts as unknown, 64) ?? "0";
  if (team === null || user === null || channel === null || value === null) return { ignored: "not_a_button_action" };
  return Object.freeze({ teamId: team, channelId: channel, userId: user, actionTs, responseUrl: str(parsedPayload.response_url, 1_024), value });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdk && npx vitest run tests/slack.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/slack.ts sdk/tests/slack.test.ts
git commit -m "feat(sdk): Slack event and block_actions parsing"
```

---

## Task 10: Slack turn → chat.postMessage mapping (`slack.ts`)

**Files:**
- Modify: `sdk/src/slack.ts`
- Test: `sdk/tests/slack.test.ts` (add cases)

**Interfaces:**
- Consumes: `createSignedChoicePayload`, `classifyChoiceFeedback`, `ChoiceFeedback` from `./channel-support.js`; `WordlessSupportChatTurn` from `./server.js`.
- Produces:
  - `const SLACK_SHOW_CHOICES_LABEL = "I don't know what to say"`
  - `interface SlackPostMessageRequest { method: "POST"; path: "/chat.postMessage"; body: SlackJsonValue }`
  - `interface SlackPendingChoice { payload; id; label; reply; detectorId; feedback; evidenceIndexes }` and `interface SlackPendingChoiceSet { teamId; channelId; userId; suggestionId; sourceMessageTs; nonce; issuedAt; expiresAt; choices }`
  - `function buildSlackPostMessage(inbound: { teamId: string; channelId: string; userId: string; messageTs: string }, turn: WordlessSupportChatTurn, signingSecret: string, nonce: string, issuedAtSeconds: number, expiresAtSeconds: number): { request: SlackPostMessageRequest; pendingChoices: SlackPendingChoiceSet | null }`

Slack allows longer labels than WhatsApp, so no title-length constraint: the full `SLACK_SHOW_CHOICES_LABEL` is used for the null-detector choice. Cap at 3 buttons for contract parity; button `text` ≤ 75, `value` ≤ 2000.

- [ ] **Step 1: Write the failing test (append)**

```ts
// append to sdk/tests/slack.test.ts
import { buildSlackPostMessage, SLACK_SHOW_CHOICES_LABEL } from "../src/slack.js";
import type { WordlessSupportChatTurn } from "../src/server.js";

const SIG = "slack-choice-secret-000000000000000000";
const IN = { teamId: "T1", channelId: "C1", userId: "U1", messageTs: "1700000000.1" };
const SUG = "sg_" + "d".repeat(32);

describe("buildSlackPostMessage", () => {
  it("maps a grounded_reply to a text postMessage", () => {
    const turn = { kind: "grounded_reply", hostAction: "show_wordless", renderMode: "message", suggestionId: SUG,
      reviewRequired: true, readOnly: true, processingMs: 2, message: "Your last charge was $20.", choices: [], detectorId: null, evidenceIndexes: [0], reason: null } as any;
    const { request, pendingChoices } = buildSlackPostMessage(IN, turn, SIG, "nonceBB", 1000, 2000);
    expect(request.path).toBe("/chat.postMessage");
    expect((request.body as any).channel).toBe("C1");
    expect((request.body as any).text).toContain("$20");
    expect(pendingChoices).toBeNull();
  });

  it("maps clarification_choices to a Block Kit actions block with the full label", () => {
    const turn = { kind: "clarification_choices", hostAction: "show_wordless", renderMode: "choices", suggestionId: SUG,
      reviewRequired: true, readOnly: true, processingMs: 2, message: "Did you mean:", detectorId: "duplicate_charge", evidenceIndexes: [0], reason: null,
      choices: [
        { id: "c1", label: "A duplicate charge", reply: "I was charged twice.", detectorId: "duplicate_charge", evidenceIndexes: [0] },
        { id: "c2", label: "x", reply: "", detectorId: null, evidenceIndexes: [] },
      ] } as any;
    const { request, pendingChoices } = buildSlackPostMessage(IN, turn, SIG, "nonceBB", 1000, 2000);
    const blocks = (request.body as any).blocks;
    const actions = blocks.find((b: any) => b.type === "actions");
    expect(actions.elements).toHaveLength(2);
    expect(actions.elements[1].text.text).toBe(SLACK_SHOW_CHOICES_LABEL);
    expect(actions.elements[0].value.startsWith("wl2.")).toBe(true);
    expect(pendingChoices?.choices).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdk && npx vitest run tests/slack.test.ts`
Expected: FAIL — `buildSlackPostMessage` not exported.

- [ ] **Step 3: Add the implementation (append to `slack.ts`)**

Add imports at the top of `slack.ts`:

```ts
import { classifyChoiceFeedback, createSignedChoicePayload, type ChoiceFeedback } from "./channel-support.js";
import type { WordlessSupportChatTurn } from "./server.js";
```

Then append (mirrors the WhatsApp mapper, Block Kit output, no title-length limit):

```ts
export type SlackJsonValue =
  | null | boolean | number | string
  | readonly SlackJsonValue[]
  | { readonly [key: string]: SlackJsonValue };

export const SLACK_SHOW_CHOICES_LABEL = "I don't know what to say";
const SLACK_MAX_BUTTONS = 3;
const SLACK_MAX_BUTTON_TEXT = 75;
const SLACK_MAX_BUTTON_VALUE = 2_000;

export interface SlackPostMessageRequest { readonly method: "POST"; readonly path: "/chat.postMessage"; readonly body: SlackJsonValue; }
export interface SlackPendingChoice {
  readonly payload: string; readonly id: string; readonly label: string; readonly reply: string;
  readonly detectorId: string | null; readonly feedback: ChoiceFeedback; readonly evidenceIndexes: readonly number[];
}
export interface SlackPendingChoiceSet {
  readonly teamId: string; readonly channelId: string; readonly userId: string; readonly suggestionId: string;
  readonly sourceMessageTs: string; readonly nonce: string; readonly issuedAt: string; readonly expiresAt: string;
  readonly choices: readonly SlackPendingChoice[];
}

export function buildSlackPostMessage(
  inbound: { readonly teamId: string; readonly channelId: string; readonly userId: string; readonly messageTs: string },
  turn: WordlessSupportChatTurn,
  signingSecret: string,
  nonce: string,
  issuedAtSeconds: number,
  expiresAtSeconds: number,
): { readonly request: SlackPostMessageRequest; readonly pendingChoices: SlackPendingChoiceSet | null } {
  if (turn.message === null) throw new SlackIntegrationError("A visible Slack turn must contain a message.");
  const path = "/chat.postMessage" as const;
  if (turn.renderMode !== "choices" || turn.choices.length === 0) {
    return Object.freeze({ request: Object.freeze({ method: "POST" as const, path, body: Object.freeze({ channel: inbound.channelId, text: turn.message }) }), pendingChoices: null });
  }
  if (turn.choices.length > SLACK_MAX_BUTTONS) throw new SlackIntegrationError(`Slack channel supports at most ${SLACK_MAX_BUTTONS} buttons.`);
  const pending: SlackPendingChoice[] = [];
  const elements = turn.choices.map((choice) => {
    const feedback = classifyChoiceFeedback(turn.kind, choice.detectorId);
    const payload = createSignedChoicePayload({
      bindingParts: [inbound.teamId, inbound.channelId, inbound.userId],
      suggestionId: turn.suggestionId, choiceId: choice.id, detectorId: choice.detectorId,
      feedback, issuedAtSeconds, expiresAtSeconds, nonce, signingSecret,
    });
    if (payload.length > SLACK_MAX_BUTTON_VALUE) throw new SlackIntegrationError("Slack button value exceeds 2000 characters.");
    const label = choice.detectorId === null ? SLACK_SHOW_CHOICES_LABEL : choice.label;
    if (label.length > SLACK_MAX_BUTTON_TEXT) throw new SlackIntegrationError(`Slack button text exceeds ${SLACK_MAX_BUTTON_TEXT} characters.`);
    pending.push(Object.freeze({ payload, id: choice.id, label, reply: choice.reply, detectorId: choice.detectorId, feedback, evidenceIndexes: choice.evidenceIndexes }));
    return Object.freeze({ type: "button", action_id: choice.id, text: Object.freeze({ type: "plain_text", text: label }), value: payload });
  });
  const body: SlackJsonValue = Object.freeze({
    channel: inbound.channelId, text: turn.message,
    blocks: Object.freeze([
      Object.freeze({ type: "section", text: Object.freeze({ type: "mrkdwn", text: turn.message }) }),
      Object.freeze({ type: "actions", elements: Object.freeze(elements) }),
    ]),
  });
  const pendingChoices: SlackPendingChoiceSet = Object.freeze({
    teamId: inbound.teamId, channelId: inbound.channelId, userId: inbound.userId, suggestionId: turn.suggestionId,
    sourceMessageTs: inbound.messageTs, nonce,
    issuedAt: new Date(issuedAtSeconds * 1_000).toISOString(), expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
    choices: Object.freeze(pending),
  });
  return Object.freeze({ request: Object.freeze({ method: "POST" as const, path, body }), pendingChoices });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdk && npx vitest run tests/slack.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/slack.ts sdk/tests/slack.test.ts
git commit -m "feat(sdk): Slack turn-to-Block-Kit mapping"
```

---

## Task 11: Slack adapter — event & interaction processing (`slack.ts`)

**Files:**
- Modify: `sdk/src/slack.ts`
- Test: `sdk/tests/slack.test.ts` (add cases)

**Interfaces:**
- Consumes: `WordlessSupportChatbot`, `WordlessSupportChatTurn`, `WordlessEvidence`, `WordlessJsonValue`, `WordlessSdkError` from `./server.js`; `detectHumanRequest`, `isShowChoicesRequest`, `verifySignedChoicePayload` from `./channel-support.js`; Task 8–10 exports.
- Produces:
  - `interface SlackAuthenticatedAccount { authenticated: true; customerId: string; observedAt: string; evidence: readonly WordlessEvidence[]; metadata? }`
  - `interface SlackChoiceStore { save(set: SlackPendingChoiceSet): Promise<void>; resolve(input: SlackChoiceResolveInput): Promise<SlackResolvedChoice | null> }` (same one-time/idempotent/expiry contract as WhatsApp, bound to team+channel+user, keyed by action ts)
  - `type SlackResult = SlackPostMessageResult | SlackContinueResult | SlackHandoffResult | SlackIgnoredResult`
  - `function createSlackAdapter(options: SlackAdapterOptions): { processEvent(rawBody, headers): Promise<SlackEventOutcome>; processInteraction(rawBody, headers): Promise<SlackResult> }`

`processEvent` returns `{ kind: "url_verification"; challenge } | { kind: "result"; result: SlackResult } | { kind: "ignored" }`. `processInteraction` verifies the signature, URL-decodes the `payload=` form field, JSON-parses it, and handles the button. `SlackAdapterOptions` mirrors WhatsApp plus `selfBotUserId: string`.

- [ ] **Step 1: Write the failing test (append)** — same fake-chatbot + memory-store shape as WhatsApp Task 6, adapted to Slack transports (event happy path → post_message; unauthenticated → continue; Wordless error → continue; valid button → post_message + recordConfirmation; replay → continue).

```ts
// append to sdk/tests/slack.test.ts
import { createSlackAdapter } from "../src/slack.js";
import type { SlackChoiceStore, SlackPendingChoiceSet, SlackResolvedChoice } from "../src/slack.js";

const SS = "slack-signing-secret-0000000000000000";
const CS = "slack-choice-secret-000000000000000000";
const CLOCK = () => new Date("2023-11-14T22:13:30.000Z");
const TS2 = String(Math.floor(CLOCK().getTime() / 1000));
function sig(body: string) { return "v0=" + createHmac("sha256", SS).update(`v0:${TS2}:${body}`, "utf8").digest("hex"); }

function store(): SlackChoiceStore {
  const sets = new Map<string, SlackPendingChoiceSet>(); const used = new Map<string, SlackResolvedChoice>();
  return {
    async save(s) { for (const c of s.choices) sets.set(`${s.teamId}:${s.channelId}:${s.userId}:${c.payload}`, s); },
    async resolve(i) {
      const key = `${i.teamId}:${i.channelId}:${i.userId}:${i.payload}`; const s = sets.get(key);
      if (!s) return used.get(i.selectionActionTs) ?? null;
      const c = s.choices.find((x) => x.payload === i.payload)!;
      const r: SlackResolvedChoice = { suggestionId: s.suggestionId, choiceId: c.id, detectorId: c.detectorId, reply: c.reply, feedback: c.feedback };
      sets.delete(key); used.set(i.selectionActionTs, r); return r;
    },
  };
}
function chatbot(recorded: unknown[] = []) {
  return { async processMessage() {
      return { kind: "clarification_choices", hostAction: "show_wordless", renderMode: "choices", suggestionId: "sg_" + "e".repeat(32),
        reviewRequired: true, readOnly: true, processingMs: 1, message: "Did you mean:", detectorId: "duplicate_charge", evidenceIndexes: [0], reason: null,
        choices: [ { id: "c1", label: "A duplicate charge", reply: "I was charged twice.", detectorId: "duplicate_charge", evidenceIndexes: [0] },
                   { id: "c2", label: "x", reply: "", detectorId: null, evidenceIndexes: [] } ] } as any; },
    async recordConfirmation(c: unknown) { recorded.push(c); return {} as any; } };
}
const acct = { authenticated: true as const, customerId: "acct_9", observedAt: "2023-11-14T22:13:25.000Z", evidence: [] };
function eventBody(text: string) {
  return JSON.stringify({ type: "event_callback", team_id: "T1", event: { type: "message", channel: "C1", user: "U1", ts: "1700000000.1", text } });
}

describe("createSlackAdapter", () => {
  it("posts clarification buttons for a supportable message", async () => {
    const adapter = createSlackAdapter({ chatbot: chatbot() as any, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => acct, choiceStore: store(), now: CLOCK });
    const body = eventBody("charged twice");
    const outcome = await adapter.processEvent(body, { signature: sig(body), timestamp: TS2 });
    expect(outcome.kind).toBe("result");
    expect((outcome as any).result.kind).toBe("post_message");
  });

  it("handles the url_verification handshake", async () => {
    const adapter = createSlackAdapter({ chatbot: chatbot() as any, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => acct, choiceStore: store(), now: CLOCK });
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const outcome = await adapter.processEvent(body, { signature: sig(body), timestamp: TS2 });
    expect(outcome).toMatchObject({ kind: "url_verification", challenge: "abc" });
  });

  it("resolves a tapped button once and records confirmation", async () => {
    const recorded: unknown[] = []; const shared = store();
    const adapter = createSlackAdapter({ chatbot: chatbot(recorded) as any, signingSecret: SS, choiceSigningSecret: CS, selfBotUserId: "UBOT",
      resolveAuthenticatedAccount: async () => acct, choiceStore: shared, now: CLOCK });
    const body = eventBody("charged twice");
    const posted = await adapter.processEvent(body, { signature: sig(body), timestamp: TS2 });
    const payload = (posted as any).result.request.body.blocks.find((b: any) => b.type === "actions").elements[0].value as string;
    const interaction = "payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions", team: { id: "T1" }, user: { id: "U1" }, channel: { id: "C1" },
      response_url: "https://hooks.slack.test/1", actions: [{ type: "button", action_id: "c1", value: payload, action_ts: "1700000005.5" }] }));
    const result = await adapter.processInteraction(interaction, { signature: sig(interaction), timestamp: TS2 });
    expect(result.kind).toBe("post_message");
    expect(recorded).toHaveLength(1);
    const result2 = await adapter.processInteraction(interaction.replace("1700000005.5", "1700000009.9"), { signature: sig(interaction.replace("1700000005.5", "1700000009.9")), timestamp: TS2 });
    expect(result2).toMatchObject({ kind: "continue", reason: "choice_replayed" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sdk && npx vitest run tests/slack.test.ts`
Expected: FAIL — `createSlackAdapter` not exported.

- [ ] **Step 3: Add the implementation (append to `slack.ts`)**

Extend the top imports of `slack.ts`:

```ts
import { randomBytes } from "node:crypto";
import {
  classifyChoiceFeedback, createSignedChoicePayload, detectHumanRequest,
  isShowChoicesRequest, verifySignedChoicePayload, type ChoiceFeedback,
} from "./channel-support.js";
import {
  WordlessSdkError, type WordlessEvidence, type WordlessJsonValue,
  type WordlessSupportChatbot, type WordlessSupportChatTurn,
} from "./server.js";
```

Then append the adapter. It mirrors the WhatsApp adapter's control flow (human check → resolve account → processMessage → map turn / continue on continue_host_bot / continue on WordlessSdkError; button path → verify payload → store.resolve → recordConfirmation best-effort → post reply, else continue with `choice_replayed`). Binding is `[teamId, channelId, userId]`; the store key for idempotency is the action ts.

```ts
const S_DEFAULT_TTL_MS = 30 * 60 * 1_000;
const S_MAX_TTL_MS = 24 * 60 * 60 * 1_000;

export interface SlackAuthenticatedAccount {
  readonly authenticated: true; readonly customerId: string; readonly observedAt: string;
  readonly evidence: readonly WordlessEvidence[]; readonly metadata?: Readonly<Record<string, WordlessJsonValue>>;
}
export interface SlackChoiceResolveInput {
  readonly teamId: string; readonly channelId: string; readonly userId: string; readonly payload: string;
  readonly selectionActionTs: string; readonly nonce: string;
}
export interface SlackResolvedChoice {
  readonly suggestionId: string; readonly choiceId: string; readonly detectorId: string | null;
  readonly reply: string; readonly feedback: ChoiceFeedback;
}
export interface SlackChoiceStore {
  save(set: SlackPendingChoiceSet): Promise<void>;
  resolve(input: SlackChoiceResolveInput): Promise<SlackResolvedChoice | null>;
}

export type SlackContinueReason = "account_not_authenticated" | "wordless_unavailable" | "continue_host_bot" | "choice_replayed";
interface SlackResultBase { readonly deduplicationKey: string; }
export interface SlackPostMessageResult extends SlackResultBase {
  readonly kind: "post_message"; readonly request: SlackPostMessageRequest; readonly pendingChoices: SlackPendingChoiceSet | null;
  readonly wordless: { readonly suggestionId: string; readonly outcome: WordlessSupportChatTurn["kind"]; readonly evidenceIndexes: readonly number[]; };
}
export interface SlackContinueResult extends SlackResultBase { readonly kind: "continue"; readonly reason: SlackContinueReason; }
export interface SlackHandoffResult extends SlackResultBase { readonly kind: "handoff"; readonly reason: "human_requested"; }
export interface SlackIgnoredResult { readonly kind: "ignored"; readonly reason: "not_a_user_message" | "not_a_button_action"; }
export type SlackResult = SlackPostMessageResult | SlackContinueResult | SlackHandoffResult | SlackIgnoredResult;
export type SlackEventOutcome = { readonly kind: "url_verification"; readonly challenge: string } | { readonly kind: "result"; readonly result: SlackResult } | { readonly kind: "ignored" };

export interface SlackAdapterOptions {
  readonly chatbot: WordlessSupportChatbot;
  readonly signingSecret: string;
  readonly choiceSigningSecret: string;
  readonly selfBotUserId: string;
  readonly resolveAuthenticatedAccount: (inbound: SlackInboundMessage) => Promise<SlackAuthenticatedAccount | null>;
  readonly choiceStore: SlackChoiceStore;
  readonly humanHandoff?: { readonly enabled: boolean };
  readonly accountResolutionFailureMode?: "throw" | "continue";
  readonly choiceTtlMs?: number;
  readonly now?: () => Date;
  readonly onWordlessError?: (error: WordlessSdkError, inbound: SlackInboundMessage) => void;
  readonly onAccountResolutionError?: (error: unknown, inbound: SlackInboundMessage) => void;
  readonly onFeedbackError?: (error: unknown, inbound: SlackInboundAction) => void;
}

export interface SlackAdapter {
  processEvent(rawBody: string, headers: { readonly signature: string | null; readonly timestamp: string | null }): Promise<SlackEventOutcome>;
  processInteraction(rawBody: string, headers: { readonly signature: string | null; readonly timestamp: string | null }): Promise<SlackResult>;
}

export function createSlackAdapter(options: SlackAdapterOptions): SlackAdapter {
  const ttl = options.choiceTtlMs ?? S_DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > S_MAX_TTL_MS) throw new SlackIntegrationError("choiceTtlMs must be between one minute and 24 hours.");
  const now = options.now ?? (() => new Date());
  const humanEnabled = options.humanHandoff?.enabled === true;

  async function onMessage(inbound: SlackInboundMessage): Promise<SlackResult> {
    if (humanEnabled && detectHumanRequest(inbound.text)) {
      return Object.freeze({ kind: "handoff" as const, deduplicationKey: inbound.messageTs, reason: "human_requested" as const });
    }
    let account: SlackAuthenticatedAccount | null;
    try { account = await options.resolveAuthenticatedAccount(inbound); }
    catch (error) {
      if ((options.accountResolutionFailureMode ?? "throw") === "continue") { options.onAccountResolutionError?.(error, inbound); return Object.freeze({ kind: "continue" as const, deduplicationKey: inbound.messageTs, reason: "account_not_authenticated" as const }); }
      throw error;
    }
    if (account === null) return Object.freeze({ kind: "continue" as const, deduplicationKey: inbound.messageTs, reason: "account_not_authenticated" as const });
    let turn: WordlessSupportChatTurn;
    try {
      turn = await options.chatbot.processMessage({ messageId: inbound.messageTs, customerId: account.customerId, text: inbound.text,
        sentAt: new Date(Math.floor(Number.parseFloat(inbound.messageTs) * 1_000)).toISOString(), observedAt: account.observedAt, channel: "chat",
        evidence: account.evidence, metadata: account.metadata, showChoices: isShowChoicesRequest(inbound.text, false) });
    } catch (error) {
      if (error instanceof WordlessSdkError) { options.onWordlessError?.(error, inbound); return Object.freeze({ kind: "continue" as const, deduplicationKey: inbound.messageTs, reason: "wordless_unavailable" as const }); }
      throw error;
    }
    if (turn.hostAction === "continue_host_bot") return Object.freeze({ kind: "continue" as const, deduplicationKey: inbound.messageTs, reason: "continue_host_bot" as const });
    const issuedAtSeconds = Math.floor(now().getTime() / 1_000);
    const expiresAtSeconds = issuedAtSeconds + Math.ceil(ttl / 1_000);
    const { request, pendingChoices } = buildSlackPostMessage(inbound, turn, options.choiceSigningSecret, randomBytes(12).toString("base64url"), issuedAtSeconds, expiresAtSeconds);
    if (pendingChoices !== null) await options.choiceStore.save(pendingChoices);
    return Object.freeze({ kind: "post_message" as const, deduplicationKey: inbound.messageTs, request, pendingChoices,
      wordless: Object.freeze({ suggestionId: turn.suggestionId, outcome: turn.kind, evidenceIndexes: turn.evidenceIndexes }) });
  }

  return Object.freeze({
    async processEvent(rawBody, headers) {
      if (!verifySlackSignature(rawBody, headers, options.signingSecret, now)) throw new SlackWebhookValidationError("Slack signature is invalid.");
      let parsed: unknown; try { parsed = JSON.parse(rawBody); } catch { throw new SlackWebhookValidationError("Slack event body is not valid JSON."); }
      const challenge = verifySlackUrlVerification(parsed);
      if (challenge !== null) return Object.freeze({ kind: "url_verification" as const, challenge });
      const message = parseSlackMessageEvent(parsed, options.selfBotUserId);
      if ("ignored" in message) return Object.freeze({ kind: "ignored" as const });
      return Object.freeze({ kind: "result" as const, result: await onMessage(message) });
    },
    async processInteraction(rawBody, headers) {
      if (!verifySlackSignature(rawBody, headers, options.signingSecret, now)) throw new SlackWebhookValidationError("Slack signature is invalid.");
      const params = new URLSearchParams(rawBody);
      const raw = params.get("payload");
      if (raw === null) throw new SlackWebhookValidationError("Slack interaction is missing a payload.");
      let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new SlackWebhookValidationError("Slack interaction payload is not valid JSON."); }
      const action = parseSlackBlockActions(parsed);
      if ("ignored" in action) return Object.freeze({ kind: "ignored" as const, reason: "not_a_button_action" as const });
      const verified = verifySignedChoicePayload({ payload: action.value, bindingParts: [action.teamId, action.channelId, action.userId], signingSecret: options.choiceSigningSecret, nowSeconds: Math.floor(now().getTime() / 1_000) });
      if (verified === null) return Object.freeze({ kind: "continue" as const, deduplicationKey: action.actionTs, reason: "choice_replayed" as const });
      const resolved = await options.choiceStore.resolve({ teamId: action.teamId, channelId: action.channelId, userId: action.userId, payload: action.value, selectionActionTs: action.actionTs, nonce: verified.nonce });
      if (resolved === null) return Object.freeze({ kind: "continue" as const, deduplicationKey: action.actionTs, reason: "choice_replayed" as const });
      try { await options.chatbot.recordConfirmation({ suggestionId: resolved.suggestionId, selectedDetectorId: resolved.detectorId, actor: "customer", decisionId: action.actionTs }); }
      catch (error) { options.onFeedbackError?.(error, action); }
      const request: SlackPostMessageRequest = Object.freeze({ method: "POST" as const, path: "/chat.postMessage" as const, body: Object.freeze({ channel: action.channelId, text: resolved.reply.length > 0 ? resolved.reply : "Thanks — noted." }) });
      return Object.freeze({ kind: "post_message" as const, deduplicationKey: action.actionTs, request, pendingChoices: null,
        wordless: Object.freeze({ suggestionId: resolved.suggestionId, outcome: "clarification_choices" as const, evidenceIndexes: Object.freeze([]) }) });
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sdk && npx vitest run tests/slack.test.ts`
Expected: PASS (all cases, including replay → continue).

- [ ] **Step 5: Commit**

```bash
git add sdk/src/slack.ts sdk/tests/slack.test.ts
git commit -m "feat(sdk): Slack adapter with event and interaction processing"
```

---

## Task 12: Slack packaging — export, example, README, full build, PR 2

**Files:**
- Modify: `sdk/package.json` (add `./slack` export)
- Create: `sdk/examples/slack-events-handler.ts`
- Create: `sdk/integrations/slack/README.md`

- [ ] **Step 1: Add the subpath export to `sdk/package.json`**

Insert after the `./whatsapp` export block:

```json
    "./slack": {
      "types": "./dist/types/slack.d.ts",
      "node": {
        "import": "./dist/esm/slack.js",
        "default": "./dist/esm/slack.js"
      }
    },
```

- [ ] **Step 2: Write the example handler**

```ts
// sdk/examples/slack-events-handler.ts
import { createSupportChatbotAdapter, createWordlessClient } from "@wordless/sdk/server";
import {
  createSlackAdapter,
  type SlackAuthenticatedAccount,
  type SlackChoiceStore,
  type SlackInboundMessage,
} from "@wordless/sdk/slack";

interface Config {
  readonly signingSecret: string; readonly choiceSigningSecret: string; readonly selfBotUserId: string;
  readonly wordlessBaseUrl: string; readonly wordlessApiKey: string; readonly wordlessSigningSecret: string;
}
interface Dependencies {
  readonly resolveAuthenticatedAccount: (inbound: SlackInboundMessage) => Promise<SlackAuthenticatedAccount | null>;
  readonly choiceStore: SlackChoiceStore;
  readonly postToSlack: (request: { readonly method: "POST"; readonly path: string; readonly body: unknown }) => Promise<void>;
}

export function createSlackHttpHandlers(config: Config, deps: Dependencies) {
  const chatbot = createSupportChatbotAdapter({
    client: createWordlessClient({ baseUrl: config.wordlessBaseUrl, apiKey: config.wordlessApiKey, signingSecret: config.wordlessSigningSecret }),
    sourceSystem: "slack",
  });
  const adapter = createSlackAdapter({
    chatbot, signingSecret: config.signingSecret, choiceSigningSecret: config.choiceSigningSecret,
    selfBotUserId: config.selfBotUserId, resolveAuthenticatedAccount: deps.resolveAuthenticatedAccount,
    choiceStore: deps.choiceStore, humanHandoff: { enabled: true },
  });
  return {
    // POST /slack/events — deliver the raw body + X-Slack-Signature / X-Slack-Request-Timestamp headers.
    async handleEvent(rawBody: string, headers: { signature: string | null; timestamp: string | null }): Promise<{ challenge?: string }> {
      const outcome = await adapter.processEvent(rawBody, headers);
      if (outcome.kind === "url_verification") return { challenge: outcome.challenge };
      if (outcome.kind === "result" && outcome.result.kind === "post_message") await deps.postToSlack(outcome.result.request);
      return {};
    },
    // POST /slack/interactions — application/x-www-form-urlencoded body with a `payload` field.
    async handleInteraction(rawBody: string, headers: { signature: string | null; timestamp: string | null }): Promise<void> {
      const result = await adapter.processInteraction(rawBody, headers);
      if (result.kind === "post_message") await deps.postToSlack(result.request);
    },
  };
}
```

- [ ] **Step 3: Write the integration README**

Create `sdk/integrations/slack/README.md` with the universal-preference + read-only framing, the two Slack endpoints (Events API `/slack/events`, interactivity `/slack/interactions`), `v0` request signing and the URL-verification handshake, Block Kit `actions` rendering with the full `SLACK_SHOW_CHOICES_LABEL`, the `selfBotUserId` requirement to avoid loops, the `resolveAuthenticatedAccount` contract (map a verified Slack user to a company account; load point-in-time read-only evidence), and links to Slack's current docs (verifying requests, Events API, interactivity payloads, `chat.postMessage`).

- [ ] **Step 4: Typecheck, test, and build the whole SDK**

Run:
```bash
cd sdk && npm run typecheck && npm test && npm run build
```
Expected: typecheck clean; all suites PASS; build emits `dist/esm/slack.js` and `dist/types/slack.d.ts`.

- [ ] **Step 5: Commit and open PR 2**

```bash
git add sdk/package.json sdk/examples/slack-events-handler.ts sdk/integrations/slack/README.md
git commit -m "feat(sdk): Slack packaging, example handler, and integration guide"
git push
gh pr create --base main --title "Slack evidence-first live channel" --body "Adds a read-only Slack live channel (Events API + interactivity) on the shared channel-support module, reusing the signed-payload, one-time-choice, and safe-fallback discipline. Offline-tested via vitest."
```

---

## Self-Review notes

- **Spec coverage:** shared module (Tasks 1–2), WhatsApp verify/parse/map/adapter/package (Tasks 3–7), Slack verify/parse/map/adapter/package (Tasks 8–12). Safety invariants (§8) are enforced in Tasks 5/6/10/11. §11 decision recorded in the header (self-contained `detectHumanRequest`, `zendesk.ts` untouched) — a deliberate move to the spec's documented fallback; flag to the owner in the PR/description.
- **Open questions (§12):** handoff surfaces as its own `handoff` result (Tasks 6/11); WhatsApp over-long labels raise (Task 5); Slack outbound returns `chat.postMessage` request objects (Tasks 10/12). Confirm with the owner at review.
- **Type consistency:** `ChoiceFeedback`, `createSignedChoicePayload`, `verifySignedChoicePayload`, `classifyChoiceFeedback`, `WordlessSupportChatbot.processMessage/recordConfirmation`, and the `WhatsApp*`/`Slack*` result unions are used consistently across tasks.
- **Assumption to verify during Task 3/8 (first real import):** confirm the exact names `createWordlessClient` and `createSupportChatbotAdapter` and the `WordlessSupportMessageInput` field names against `sdk/src/server.ts` before finalizing the examples; adjust the example imports if the option names differ. This is the one place the plan depends on option-name details not fully quoted here.

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

// Tokens that make a message "essentially just a role word" (e.g. "human",
// "agent please") rather than a sentence that happens to start with one.
const POLITE_TOKEN = new Set(["please", "pls", "thanks", "thank", "you", "now"]);
// Pure grammatical glue (and the couple of adjectives that commonly modify a
// role word, e.g. "a live agent" / "a real person") that doesn't break
// proximity between a request cue and the role word it precedes.
const ADJACENCY_FILLER = new Set(["a", "an", "the", "to", "with", "for", "me", "us", "live", "real"]);

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/['’]/gu, "").split(/[^a-z]+/u).filter((t) => t.length > 0);
}

// True only if some request cue appears before roleIndex with nothing but
// filler tokens between it and the role word — i.e. the cue is adjacent to
// the role, not merely present somewhere earlier in the message.
function hasAdjacentRequestCue(tokens: readonly string[], roleIndex: number): boolean {
  for (let cueIndex = 0; cueIndex < roleIndex; cueIndex++) {
    if (!REQUEST_CUE.has(tokens[cueIndex]!)) continue;
    let blockedByContent = false;
    for (let between = cueIndex + 1; between < roleIndex; between++) {
      if (!ADJACENCY_FILLER.has(tokens[between]!)) {
        blockedByContent = true;
        break;
      }
    }
    if (!blockedByContent) return true;
  }
  return false;
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
  // A bare role word ("human"), or a role word plus only polite filler
  // tokens ("agent please"), is a genuine minimal request on its own —
  // regardless of where the role word sits in the message.
  const otherTokens = tokens.filter((_, index) => index !== roleIndex);
  if (otherTokens.length === 0 || otherTokens.every((t) => POLITE_TOKEN.has(t))) return true;
  // Otherwise this must be a real sentence: only count it as a handoff
  // request when a request cue sits immediately (or near-immediately, via
  // grammatical glue) before the role word — not merely anywhere earlier.
  return hasAdjacentRequestCue(tokens, roleIndex);
}

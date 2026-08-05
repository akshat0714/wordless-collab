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

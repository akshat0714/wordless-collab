import { createHostSupportChatResponse } from "./support-chat-adapter.ts";
import {
  parseSupportChatResponse,
  type SupportChatRequest,
  type SupportChatResponse,
  type SupportScenarioId,
} from "./support-chat-schema.ts";

type PublicDemoEnvironment = Readonly<Record<string, string | undefined>>;

type SyntheticOutcome = {
  detectorId: string;
  prompt: string;
  label: string;
  reply: string;
  messagePatterns: readonly RegExp[];
};

type SingleEvidenceScenarioId = Exclude<SupportScenarioId, "full_account">;

const syntheticOutcomes: Readonly<Record<SingleEvidenceScenarioId, SyntheticOutcome>> = {
  duplicate_charge: {
    detectorId: "duplicate_charge",
    prompt: "I found two matching completed charges. Is that what you need help with?",
    label: "Charged twice",
    reply: "I was charged twice for the same order.",
    messagePatterns: [
      /\b(?:twice|duplicate(?:d)?|double[- ]?charged)\b/,
      /\btwo (?:charges|payments|transactions)\b/,
      /\bcharged\b.{0,32}\b(?:again|two times)\b/,
      /\bmoney\b.{0,40}\b(?:again|twice|two times)\b/,
      /\bmney\b.{0,24}\b(?:twcie|two)\b/,
    ],
  },
  late_delivery: {
    detectorId: "late_delivery",
    prompt: "I found a delivery marked late or overdue. Is that what you need help with?",
    label: "Delivery is late",
    reply: "My delivery is late.",
    messagePatterns: [
      /\b(?:late|overdue|delay(?:ed)?)\b/,
      /\b(?:package|parcel|delivery|shipment|order)\b.{0,56}\b(?:not here|not arrived|not come|missing)\b/,
      /\bwhere\b.{0,32}\b(?:package|parcel|delivery|shipment|order)\b/,
      /\b(?:pakg|delvry)\b.{0,24}\b(?:no|nvr)\b.{0,24}\b(?:com|cme)\b/,
    ],
  },
  wrong_item: {
    detectorId: "wrong_item",
    prompt: "I found that the delivered item does not match the ordered item. Is that the problem?",
    label: "Wrong item",
    reply: "I received the wrong item.",
    messagePatterns: [
      /\bwrong (?:item|thing|product|order)\b/,
      /\b(?:box|received|arrived|delivered)\b.{0,64}\b(?:different|does not match|doesn't match|not what|wrong)\b/,
      /\bnot what\b.{0,40}\b(?:ordered|picked|bought|chose)\b/,
      /\bthing\b.{0,24}\bbox\b.{0,24}\bdifrent\b/,
    ],
  },
  account_locked: {
    detectorId: "account_lock",
    prompt: "I found that the account is locked. Is that what you need help with?",
    label: "Account is locked",
    reply: "I cannot get into my account.",
    messagePatterns: [
      /\b(?:account|login|sign[- ]?in)\b.{0,40}\b(?:lock(?:ed)?|blocked)\b/,
      /\b(?:can'?t|cannot|unable to) (?:sign|log|get) in\b/,
      /\blocked out\b/,
      /\b(?:stops|blocks) me\b/,
      /\bcant\b.{0,24}\b(?:in|acount)\b/,
    ],
  },
};

function normalizeMessage(message: string): string {
  return message.toLowerCase().replaceAll("’", "'").replace(/\s+/g, " ").trim();
}

function matchingOutcomes(input: SupportChatRequest): SyntheticOutcome[] {
  const text = normalizeMessage(input.message);
  const outcomes = input.scenario_id === "full_account"
    ? Object.values(syntheticOutcomes)
    : [syntheticOutcomes[input.scenario_id]];
  return outcomes.filter((outcome) =>
    outcome.messagePatterns.some((pattern) => pattern.test(text)));
}

/** Production is always synthetic-only; local development opts in explicitly. */
export function publicSupportDemoEnabled(environment: PublicDemoEnvironment): boolean {
  if (environment.NODE_ENV === "production") return true;
  const explicit = environment.WORDLESS_PUBLIC_DEMO?.trim().toLowerCase();
  return explicit === "1" || explicit === "true";
}

/**
 * Resolve a public-demo turn without network access, persistence, credentials, or actions.
 * The selected scenario is the complete evidence boundary; arbitrary client evidence is not accepted.
 */
export function createPublicDemoSupportResponse(
  input: SupportChatRequest,
): SupportChatResponse {
  const matched = matchingOutcomes(input);
  if (input.action === "message" && matched.length === 0) {
    return createHostSupportChatResponse(input);
  }

  const outcomes = input.action === "show_choices"
    ? input.scenario_id === "full_account"
      ? [syntheticOutcomes.account_locked, syntheticOutcomes.late_delivery]
      : [syntheticOutcomes[input.scenario_id]]
    : matched.slice(0, 2);
  const prompt = outcomes.length === 1
    ? outcomes[0]!.prompt
    : "I found a few account details that may match. Which is closest?";
  const backedChoices = outcomes.map((outcome) => {
    const evidenceCount = outcome.detectorId === "duplicate_charge" ? 2 : 1;
    return {
      id: `confirm_${outcome.detectorId}`,
      detector_id: outcome.detectorId,
      label: outcome.label,
      detail: outcome.reply,
      evidence_label: `${evidenceCount} synthetic account ${evidenceCount === 1 ? "record supports" : "records support"} this choice`,
    };
  });
  return parseSupportChatResponse({
    schema_version: 1,
    request_id: input.request_id,
    reply_id: `reply_${input.request_id.replaceAll("-", "")}`,
    kind: "clarification_choices",
    response_source: "synthetic_demo",
    message: prompt,
    choices: [
      ...backedChoices,
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
}

export const maximumSupportMessageLength = 500;

export const supportScenarioIds = [
  "full_account",
  "duplicate_charge",
  "late_delivery",
  "wrong_item",
  "account_locked",
] as const;

export type SupportScenarioId = (typeof supportScenarioIds)[number];
export type SupportChatAction = "message" | "show_choices";
export type SupportReplyKind =
  | "clarification_choices"
  | "grounded_reply"
  | "clarifying_fallback";
/**
 * `wordless` is a reviewed, stored response from the signed product API.
 * `synthetic_demo` is a deterministic, non-persistent public demonstration.
 * `host_bot` is the console's ordinary support-bot continuation.
 */
export type SupportResponseSource = "wordless" | "synthetic_demo" | "host_bot";

export type SupportChatRequest = {
  schema_version: 1;
  request_id: string;
  conversation_id: string;
  observed_at: string;
  scenario_id: SupportScenarioId;
  action: SupportChatAction;
  message: string;
};

export type SupportChatChoice = {
  id: string;
  detector_id: string | null;
  label: string;
  detail: string;
  evidence_label: string | null;
};

export type SupportChatResponse = {
  schema_version: 1;
  request_id: string;
  reply_id: string;
  kind: SupportReplyKind;
  response_source: SupportResponseSource;
  message: string;
  choices: SupportChatChoice[];
  review_required: boolean;
  suggestion_id: string | null;
};

export function hasBackedSupportChoice(choices: readonly SupportChatChoice[]): boolean {
  return choices.some((choice) => choice.detector_id !== null);
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const replyIdPattern = /^reply_[0-9a-f]{32}$/;
const suggestionIdPattern = /^sg_[0-9a-f]{32}$/;
const choiceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const detectorIdPattern = /^[a-z][a-z0-9_]{1,48}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, keys)) {
    throw new Error(`${name} has an invalid shape`);
  }
  return value;
}

function requireString(
  value: unknown,
  name: string,
  options: { allowEmpty?: boolean; maximum?: number; pattern?: RegExp } = {},
): string {
  if (
    typeof value !== "string" ||
    (!options.allowEmpty && value.length === 0) ||
    value !== value.trim() ||
    (options.maximum !== undefined && Array.from(value).length > options.maximum) ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireTimestamp(value: unknown, name: string): string {
  const timestamp = requireString(value, name, { maximum: 64 });
  if (
    !Number.isFinite(Date.parse(timestamp)) ||
    !/T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(timestamp)
  ) {
    throw new Error(`${name} must be an ISO timestamp with a timezone`);
  }
  return timestamp;
}

function requireScenario(value: unknown): SupportScenarioId {
  if (!supportScenarioIds.includes(value as SupportScenarioId)) {
    throw new Error("scenario_id is invalid");
  }
  return value as SupportScenarioId;
}

export function parseSupportChatRequest(value: unknown): SupportChatRequest {
  const record = requireRecord(
    value,
    [
      "action",
      "conversation_id",
      "message",
      "observed_at",
      "request_id",
      "scenario_id",
      "schema_version",
    ],
    "support chat request",
  );
  if (record.schema_version !== 1) {
    throw new Error("support chat schema_version must be 1");
  }
  if (record.action !== "message" && record.action !== "show_choices") {
    throw new Error("support chat action is invalid");
  }
  const message = requireString(record.message, "message", {
    allowEmpty: record.action === "show_choices",
    maximum: maximumSupportMessageLength,
  });
  if (record.action === "message" && message.length === 0) {
    throw new Error("message action requires text");
  }
  return {
    schema_version: 1,
    request_id: requireString(record.request_id, "request_id", { pattern: uuidPattern }),
    conversation_id: requireString(record.conversation_id, "conversation_id", {
      pattern: uuidPattern,
    }),
    observed_at: requireTimestamp(record.observed_at, "observed_at"),
    scenario_id: requireScenario(record.scenario_id),
    action: record.action,
    message,
  };
}

function parseChoice(value: unknown, index: number): SupportChatChoice {
  const record = requireRecord(
    value,
    ["detail", "detector_id", "evidence_label", "id", "label"],
    `support chat choice ${index + 1}`,
  );
  return {
    id: requireString(record.id, "choice.id", { maximum: 128, pattern: choiceIdPattern }),
    detector_id:
      record.detector_id === null
        ? null
        : requireString(record.detector_id, "choice.detector_id", {
            maximum: 49,
            pattern: detectorIdPattern,
          }),
    label: requireString(record.label, "choice.label", { maximum: 80 }),
    detail: requireString(record.detail, "choice.detail", { maximum: 240 }),
    evidence_label:
      record.evidence_label === null
        ? null
        : requireString(record.evidence_label, "choice.evidence_label", { maximum: 180 }),
  };
}

export function parseSupportChatResponse(value: unknown): SupportChatResponse {
  const record = requireRecord(
    value,
    [
      "choices",
      "kind",
      "message",
      "reply_id",
      "request_id",
      "response_source",
      "review_required",
      "schema_version",
      "suggestion_id",
    ],
    "support chat response",
  );
  if (record.schema_version !== 1) {
    throw new Error("support chat response schema_version must be 1");
  }
  if (
    record.kind !== "clarification_choices" &&
    record.kind !== "grounded_reply" &&
    record.kind !== "clarifying_fallback"
  ) {
    throw new Error("support chat response kind is invalid");
  }
  if (!Array.isArray(record.choices) || record.choices.length > 3) {
    throw new Error("support chat choices must contain at most three items");
  }
  const choices = record.choices.map(parseChoice);
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length) {
    throw new Error("support chat choice IDs must be unique");
  }
  const suggestionId =
    record.suggestion_id === null
      ? null
      : requireString(record.suggestion_id, "suggestion_id", { pattern: suggestionIdPattern });
  if (
    record.response_source !== "wordless" &&
    record.response_source !== "synthetic_demo" &&
    record.response_source !== "host_bot"
  ) {
    throw new Error("support chat response source is invalid");
  }
  if (typeof record.review_required !== "boolean") {
    throw new Error("support chat review_required is invalid");
  }
  const backedChoices = choices.filter((choice) => choice.detector_id !== null);
  const isWordless = record.response_source === "wordless";
  const isSyntheticDemo = record.response_source === "synthetic_demo";
  const validSourceBoundary = isWordless
    ? record.review_required === true && suggestionId !== null
    : record.review_required === false && suggestionId === null;
  const validKindShape =
    record.kind === "clarification_choices"
      ? (isWordless || isSyntheticDemo) &&
        choices.length >= 2 &&
        backedChoices.length >= 1 &&
        backedChoices.length <= 2 &&
        choices.some((choice) => choice.detector_id === null) &&
        choices.every((choice) =>
          choice.detector_id === null
            ? choice.evidence_label === null
            : choice.evidence_label !== null,
        )
      : record.kind === "grounded_reply"
        ? !isSyntheticDemo && choices.length === 0
        : isWordless
          ? (choices.length === 0 ||
            (choices.length >= 2 &&
              backedChoices.length === 0 &&
              choices.every((choice) => choice.evidence_label === null)))
          : !isSyntheticDemo && choices.length === 0;
  if (!validSourceBoundary || !validKindShape) {
    throw new Error("support chat response fields disagree with its kind");
  }
  return {
    schema_version: 1,
    request_id: requireString(record.request_id, "request_id", { pattern: uuidPattern }),
    reply_id: requireString(record.reply_id, "reply_id", { pattern: replyIdPattern }),
    kind: record.kind,
    response_source: record.response_source,
    message: requireString(record.message, "message", { maximum: 500 }),
    choices,
    review_required: record.review_required,
    suggestion_id: suggestionId,
  };
}

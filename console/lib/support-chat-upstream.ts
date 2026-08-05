export type UpstreamEvidenceSummary = {
  input_index: number;
  ref: string;
  source: string;
  kind: string;
  occurred_at: string;
  provenance: "exported" | "reconstructed" | "inferred";
};

export type UpstreamChatChoice = {
  id: string;
  label: string;
  reply: string;
  detector_id: string | null;
  evidence: UpstreamEvidenceSummary[];
};

export type UpstreamChatAssistResponse = {
  schema_version: 1;
  suggestion_id: string;
  status: "completed";
  outcome: "clarification_choices" | "grounded_reply" | "clarifying_fallback";
  integration: {
    host_action: "show_wordless" | "continue_host_bot";
    render_mode: "choices" | "message" | "none";
  };
  message: string | null;
  choices: UpstreamChatChoice[];
  detector_id: string | null;
  evidence: UpstreamEvidenceSummary[];
  reason:
    | "no_relevant_evidence"
    | "below_confidence_floor"
    | "insufficient_context"
    | null;
  selection_basis:
    | "evidence_and_message"
    | "explicit_evidence_choices"
    | "contextual_evidence_choices"
    | "grounded_state"
    | "none";
  review_required: true;
  read_only: true;
};

const suggestionIdPattern = /^sg_[0-9a-f]{32}$/;
const detectorIdPattern = /^[a-z][a-z0-9_]{1,48}$/;
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const choiceIdPattern = /^[a-z][a-z0-9_]{1,48}$/;
const detectorVersionPattern = /^det_[0-9a-f]{16}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} has an invalid shape`);
  }
  return value;
}

function requireString(
  value: unknown,
  name: string,
  options: { maximum?: number; pattern?: RegExp } = {},
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    (options.maximum !== undefined && Array.from(value).length > options.maximum) ||
    (options.pattern && !options.pattern.test(value))
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} is invalid`);
  }
  return value as number;
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function parseEvidence(
  value: unknown,
  index: number,
  inputEvidenceCount: number,
): UpstreamEvidenceSummary {
  const record = requireRecord(
    value,
    ["input_index", "kind", "occurred_at", "provenance", "ref", "source"],
    `chat evidence ${index + 1}`,
  );
  if (
    record.provenance !== "exported" &&
    record.provenance !== "reconstructed" &&
    record.provenance !== "inferred"
  ) {
    throw new Error("chat evidence provenance is invalid");
  }
  const occurredAt = requireString(record.occurred_at, "evidence.occurred_at", { maximum: 64 });
  if (
    !Number.isFinite(Date.parse(occurredAt)) ||
    !/T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(occurredAt)
  ) {
    throw new Error("evidence.occurred_at is invalid");
  }
  const inputIndex = requireInteger(record.input_index, "evidence.input_index");
  if (inputIndex >= inputEvidenceCount) {
    throw new Error("evidence.input_index is outside the supplied evidence array");
  }
  return {
    input_index: inputIndex,
    ref: requireString(record.ref, "evidence.ref", {
      maximum: 128,
      pattern: referencePattern,
    }),
    source: requireString(record.source, "evidence.source", { maximum: 64 }),
    kind: requireString(record.kind, "evidence.kind", { maximum: 64 }),
    occurred_at: occurredAt,
    provenance: record.provenance,
  };
}

function parseEvidenceList(
  value: unknown,
  name: string,
  inputEvidenceCount: number,
): UpstreamEvidenceSummary[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${name} is invalid`);
  const parsed = value.map((item, index) => parseEvidence(item, index, inputEvidenceCount));
  if (new Set(parsed.map((item) => item.input_index)).size !== parsed.length) {
    throw new Error(`${name} contains duplicate input_index values`);
  }
  return parsed;
}

function parseChoice(
  value: unknown,
  index: number,
  inputEvidenceCount: number,
): UpstreamChatChoice {
  const record = requireRecord(
    value,
    ["detector_id", "evidence", "id", "label", "reply"],
    `chat choice ${index + 1}`,
  );
  const parsed = {
    id: requireString(record.id, "choice.id", { maximum: 49, pattern: choiceIdPattern }),
    label: requireString(record.label, "choice.label", { maximum: 72 }),
    reply: requireString(record.reply, "choice.reply", { maximum: 240 }),
    detector_id:
      record.detector_id === null
        ? null
        : requireString(record.detector_id, "choice.detector_id", {
            pattern: detectorIdPattern,
          }),
    evidence: parseEvidenceList(record.evidence, "choice.evidence", inputEvidenceCount),
  };
  if ((parsed.detector_id === null) !== (parsed.evidence.length === 0)) {
    throw new Error("chat choice evidence does not match its detector");
  }
  return parsed;
}

export function parseUpstreamChatAssistResponse(
  value: unknown,
  options: { inputEvidenceCount: number },
): UpstreamChatAssistResponse {
  if (
    !Number.isSafeInteger(options.inputEvidenceCount) ||
    options.inputEvidenceCount < 0 ||
    options.inputEvidenceCount > 100
  ) {
    throw new Error("input evidence count is invalid");
  }
  const record = requireRecord(
    value,
    [
      "choices",
      "detector_id",
      "evidence",
      "integration",
      "links",
      "message",
      "outcome",
      "policy",
      "processing_ms",
      "read_only",
      "reason",
      "redaction_entity_counts",
      "review_required",
      "schema_version",
      "selection_basis",
      "status",
      "suggestion_id",
    ],
    "chat assist response",
  );
  if (record.schema_version !== 1 || record.status !== "completed") {
    throw new Error("chat assist response metadata is invalid");
  }
  if (
    record.outcome !== "clarification_choices" &&
    record.outcome !== "grounded_reply" &&
    record.outcome !== "clarifying_fallback"
  ) {
    throw new Error("chat assist outcome is invalid");
  }
  const integration = requireRecord(
    record.integration,
    ["host_action", "render_mode"],
    "chat assist integration",
  );
  if (
    (integration.host_action !== "show_wordless" &&
      integration.host_action !== "continue_host_bot") ||
    (integration.render_mode !== "choices" &&
      integration.render_mode !== "message" &&
      integration.render_mode !== "none")
  ) {
    throw new Error("chat assist integration is invalid");
  }
  if (
    (integration.host_action === "continue_host_bot" && integration.render_mode !== "none") ||
    (integration.host_action === "show_wordless" && integration.render_mode === "none")
  ) {
    throw new Error("chat assist integration fields disagree");
  }
  if (!Array.isArray(record.choices) || record.choices.length > 3) {
    throw new Error("chat assist choices are invalid");
  }
  const choices = record.choices.map((choice, index) =>
    parseChoice(choice, index, options.inputEvidenceCount));
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length) {
    throw new Error("chat assist choice IDs must be unique");
  }
  const message =
    record.message === null
      ? null
      : requireString(record.message, "chat assist message", { maximum: 500 });
  const detectorId =
    record.detector_id === null
      ? null
      : requireString(record.detector_id, "chat assist detector_id", {
          pattern: detectorIdPattern,
        });
  if (
    record.reason !== null &&
    record.reason !== "no_relevant_evidence" &&
    record.reason !== "below_confidence_floor" &&
    record.reason !== "insufficient_context"
  ) {
    throw new Error("chat assist reason is invalid");
  }
  if (
    record.selection_basis !== "evidence_and_message" &&
    record.selection_basis !== "explicit_evidence_choices" &&
    record.selection_basis !== "contextual_evidence_choices" &&
    record.selection_basis !== "grounded_state" &&
    record.selection_basis !== "none"
  ) {
    throw new Error("chat assist selection_basis is invalid");
  }
  if (record.review_required !== true || record.read_only !== true) {
    throw new Error("chat assist must remain read-only and reviewed");
  }
  // Validate the fields not exposed by the browser adapter before discarding them.
  requireInteger(record.processing_ms, "processing_ms");
  if (!isRecord(record.redaction_entity_counts)) throw new Error("redaction counts are invalid");
  for (const [key, count] of Object.entries(record.redaction_entity_counts)) {
    requireString(key, "redaction key", { maximum: 64 });
    requireInteger(count, "redaction count");
  }
  const suggestionId = requireString(record.suggestion_id, "suggestion_id", {
    pattern: suggestionIdPattern,
  });
  const policy = requireRecord(
    record.policy,
    [
      "detector_set_version",
      "embedding_model_id",
      "embedding_model_revision",
      "score_kind",
      "threshold",
      "threshold_version",
    ],
    "chat assist policy",
  );
  requireString(policy.detector_set_version, "policy.detector_set_version", {
    pattern: detectorVersionPattern,
  });
  requireString(policy.threshold_version, "policy.threshold_version", { maximum: 64 });
  requireFiniteNumber(policy.threshold, "policy.threshold");
  if (policy.score_kind !== "ranking_not_probability") {
    throw new Error("chat assist score kind is invalid");
  }
  requireString(policy.embedding_model_id, "policy.embedding_model_id", { maximum: 256 });
  requireString(policy.embedding_model_revision, "policy.embedding_model_revision", {
    maximum: 128,
  });
  const links = requireRecord(
    record.links,
    ["events", "feedback", "self"],
    "chat assist links",
  );
  const base = `/v1/suggestions/${suggestionId}`;
  if (
    links.self !== base ||
    links.events !== `${base}/events` ||
    links.feedback !== `${base}/feedback`
  ) {
    throw new Error("chat assist links do not match suggestion_id");
  }
  const isClarification = record.outcome === "clarification_choices";
  const evidence = parseEvidenceList(record.evidence, "evidence", options.inputEvidenceCount);
  const supportedChoices = choices.filter((choice) => choice.detector_id !== null);
  if (isClarification) {
    if (
      choices.length < 2 ||
      supportedChoices.length < 1 ||
      supportedChoices.length > 2 ||
      !choices.some((choice) => choice.detector_id === null) ||
      detectorId === null ||
      choices[0]?.detector_id !== detectorId ||
      evidence.length === 0 ||
      JSON.stringify(choices[0].evidence) !== JSON.stringify(evidence) ||
      message === null ||
      record.reason !== null ||
      (record.selection_basis !== "evidence_and_message" &&
        record.selection_basis !== "explicit_evidence_choices" &&
        record.selection_basis !== "contextual_evidence_choices") ||
      integration.host_action !== "show_wordless" ||
      integration.render_mode !== "choices"
    ) {
      throw new Error("chat assist clarification fields disagree");
    }
  } else if (record.outcome === "grounded_reply") {
    if (
      choices.length > 0 ||
      detectorId !== null ||
      evidence.length === 0 ||
      message === null ||
      record.reason !== null ||
      record.selection_basis !== "grounded_state" ||
      integration.host_action !== "show_wordless" ||
      integration.render_mode !== "message"
    ) {
      throw new Error("chat assist grounded reply fields disagree");
    }
  } else if (
    detectorId !== null ||
    evidence.length > 0 ||
    record.reason === null ||
    record.selection_basis !== "none" ||
    (integration.host_action === "continue_host_bot" &&
      (message !== null || choices.length > 0)) ||
    (integration.host_action === "show_wordless" &&
      (integration.render_mode === "choices"
        ? message === null ||
          choices.length < 2 ||
          choices.some((choice) => choice.detector_id !== null || choice.evidence.length > 0)
        : integration.render_mode === "message"
          ? message === null || choices.length > 0
          : true))
  ) {
    throw new Error("chat assist fallback fields disagree");
  }
  return {
    schema_version: 1,
    suggestion_id: suggestionId,
    status: "completed",
    outcome: record.outcome,
    integration: {
      host_action: integration.host_action,
      render_mode: integration.render_mode,
    },
    message,
    choices,
    detector_id: detectorId,
    evidence,
    reason: record.reason,
    selection_basis: record.selection_basis,
    review_required: true,
    read_only: true,
  };
}

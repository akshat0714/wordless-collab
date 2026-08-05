export const maximumLiveUtteranceLength = 4_000;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const suggestionIdPattern = /^sg_[0-9a-f]{32}$/;
const feedbackIdPattern = /^fb_[0-9a-f]{32}$/;
const detectorIdPattern = /^[a-z][a-z0-9_]{1,48}$/;
const candidateIdPattern = /^sg_[0-9a-f]{32}:[a-z][a-z0-9_]{1,48}$/;
const detectorVersionPattern = /^det_[0-9a-f]{16}$/;

export type LiveSuggestionInput = {
  schema_version: 1;
  request_id: string;
  observed_at: string;
  utterance: string;
};

export type LiveFeedbackInput = {
  schema_version: 1;
  request_id: string;
  outcome: "confirmed" | "none";
  selected_detector_id: string | null;
};

export type LiveEvidenceSummary = {
  input_index: number;
  ref: string;
  source: string;
  kind: string;
  occurred_at: string;
  provenance: "exported" | "reconstructed" | "inferred";
};

export type LiveSuggestionCandidate = {
  id: string;
  detector_id: string;
  title: string;
  detail: string;
  rank: number;
  ranking_score: number;
  evidence: LiveEvidenceSummary[];
};

export type LiveSuggestionResponse = {
  schema_version: 1;
  suggestion_id: string;
  status: "completed";
  outcome: "candidates" | "abstained";
  abstained: boolean;
  abstention_reason: "no_evidence_hypotheses" | "below_confidence_floor" | null;
  review_required: true;
  candidates: LiveSuggestionCandidate[];
  processing_ms: number;
  redaction_entity_counts: Record<string, number>;
  policy: {
    detector_set_version: string;
    threshold_version: string;
    threshold: number;
    score_kind: "ranking_not_probability";
    embedding_model_id: string;
    embedding_model_revision: string;
  };
  links: {
    self: string;
    events: string;
    feedback: string;
  };
};

export type LiveFeedbackResponse = {
  schema_version: 1;
  feedback_id: string;
  suggestion_id: string;
  recorded: true;
  outcome: "confirmed" | "none";
  selected_detector_id: string | null;
  actor: "customer" | "agent";
  recorded_at: string;
};

export type LiveApiError = {
  error: {
    code: string;
    message: string;
    request_id: string | null;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
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
  options: { maximum?: number; pattern?: RegExp } = {},
): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    (options.maximum !== undefined && Array.from(value).length > options.maximum) ||
    (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value as number;
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

export function parseLiveSuggestionInput(value: unknown): LiveSuggestionInput {
  const record = requireRecord(
    value,
    ["observed_at", "request_id", "schema_version", "utterance"],
    "live suggestion request",
  );
  if (record.schema_version !== 1) {
    throw new Error("live suggestion schema_version must be 1");
  }
  const utterance = requireString(record.utterance, "utterance", {
    maximum: maximumLiveUtteranceLength,
  });
  return {
    schema_version: 1,
    request_id: requireString(record.request_id, "request_id", { pattern: uuidPattern }),
    observed_at: requireTimestamp(record.observed_at, "observed_at"),
    utterance,
  };
}

export function parseLiveFeedbackInput(value: unknown): LiveFeedbackInput {
  const record = requireRecord(
    value,
    ["outcome", "request_id", "schema_version", "selected_detector_id"],
    "live feedback request",
  );
  if (record.schema_version !== 1) {
    throw new Error("live feedback schema_version must be 1");
  }
  if (record.outcome !== "confirmed" && record.outcome !== "none") {
    throw new Error("feedback outcome is invalid");
  }
  const selectedDetectorId =
    record.selected_detector_id === null
      ? null
      : requireString(record.selected_detector_id, "selected_detector_id", {
          pattern: detectorIdPattern,
        });
  if (
    (record.outcome === "confirmed" && selectedDetectorId === null) ||
    (record.outcome === "none" && selectedDetectorId !== null)
  ) {
    throw new Error("feedback selection does not match its outcome");
  }
  return {
    schema_version: 1,
    request_id: requireString(record.request_id, "request_id", { pattern: uuidPattern }),
    outcome: record.outcome,
    selected_detector_id: selectedDetectorId,
  };
}

function parseEvidence(value: unknown, index: number): LiveEvidenceSummary {
  const record = requireRecord(
    value,
    ["input_index", "kind", "occurred_at", "provenance", "ref", "source"],
    `candidate evidence ${index + 1}`,
  );
  if (
    record.provenance !== "exported" &&
    record.provenance !== "reconstructed" &&
    record.provenance !== "inferred"
  ) {
    throw new Error("candidate evidence provenance is invalid");
  }
  return {
    input_index: requireNonNegativeInteger(record.input_index, "evidence.input_index"),
    ref: requireString(record.ref, "evidence.ref", { maximum: 128 }),
    source: requireString(record.source, "evidence.source", { maximum: 64 }),
    kind: requireString(record.kind, "evidence.kind", { maximum: 64 }),
    occurred_at: requireTimestamp(record.occurred_at, "evidence.occurred_at"),
    provenance: record.provenance,
  };
}

function parseCandidate(value: unknown, index: number): LiveSuggestionCandidate {
  const record = requireRecord(
    value,
    ["detail", "detector_id", "evidence", "id", "rank", "ranking_score", "title"],
    `candidate ${index + 1}`,
  );
  if (!Array.isArray(record.evidence) || record.evidence.length < 1 || record.evidence.length > 20) {
    throw new Error("candidate evidence must contain 1–20 records");
  }
  const rank = requireNonNegativeInteger(record.rank, "candidate.rank");
  if (rank < 1 || rank > 3) throw new Error("candidate.rank must be between 1 and 3");
  return {
    id: requireString(record.id, "candidate.id", { pattern: candidateIdPattern }),
    detector_id: requireString(record.detector_id, "candidate.detector_id", {
      pattern: detectorIdPattern,
    }),
    title: requireString(record.title, "candidate.title", { maximum: 120 }),
    detail: requireString(record.detail, "candidate.detail", { maximum: 300 }),
    rank,
    ranking_score: requireFiniteNumber(record.ranking_score, "candidate.ranking_score"),
    evidence: record.evidence.map(parseEvidence),
  };
}

export function parseLiveSuggestionResponse(value: unknown): LiveSuggestionResponse {
  const record = requireRecord(
    value,
    [
      "abstained",
      "abstention_reason",
      "candidates",
      "links",
      "outcome",
      "policy",
      "processing_ms",
      "redaction_entity_counts",
      "review_required",
      "schema_version",
      "status",
      "suggestion_id",
    ],
    "live suggestion response",
  );
  if (record.schema_version !== 1 || record.status !== "completed" || record.review_required !== true) {
    throw new Error("live suggestion response metadata is invalid");
  }
  if (record.outcome !== "candidates" && record.outcome !== "abstained") {
    throw new Error("live suggestion outcome is invalid");
  }
  if (typeof record.abstained !== "boolean") {
    throw new Error("live suggestion abstained flag is invalid");
  }
  if (
    record.abstention_reason !== null &&
    record.abstention_reason !== "no_evidence_hypotheses" &&
    record.abstention_reason !== "below_confidence_floor"
  ) {
    throw new Error("live suggestion abstention reason is invalid");
  }
  if (!Array.isArray(record.candidates) || record.candidates.length > 3) {
    throw new Error("live suggestion candidates must contain at most three records");
  }
  const candidates = record.candidates.map(parseCandidate);
  const suggestionId = requireString(record.suggestion_id, "suggestion_id", {
    pattern: suggestionIdPattern,
  });
  const expectedRanks = candidates.map((_candidate, index) => index + 1);
  if (candidates.some((candidate, index) => candidate.rank !== expectedRanks[index])) {
    throw new Error("candidate ranks must be contiguous from one");
  }
  if (
    new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length ||
    new Set(candidates.map((candidate) => candidate.detector_id)).size !== candidates.length ||
    candidates.some(
      (candidate) =>
        candidate.id !== `${suggestionId}:${candidate.detector_id}`,
    )
  ) {
    throw new Error("candidate identities are invalid");
  }
  const isAbstained = candidates.length === 0;
  if (
    record.abstained !== isAbstained ||
    (record.outcome === "abstained") !== isAbstained ||
    (record.abstention_reason !== null) !== isAbstained
  ) {
    throw new Error("live suggestion outcome fields disagree");
  }

  const redactionCounts = record.redaction_entity_counts;
  if (!isRecord(redactionCounts)) {
    throw new Error("redaction_entity_counts must be an object");
  }
  const parsedCounts: Record<string, number> = {};
  for (const [name, count] of Object.entries(redactionCounts)) {
    const key = requireString(name, "redaction entity name", { maximum: 64 });
    parsedCounts[key] = requireNonNegativeInteger(count, `redaction count ${key}`);
  }

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
    "suggestion policy",
  );
  if (policy.score_kind !== "ranking_not_probability") {
    throw new Error("suggestion score kind is invalid");
  }
  const parsedPolicy: LiveSuggestionResponse["policy"] = {
    detector_set_version: requireString(
      policy.detector_set_version,
      "detector_set_version",
      { pattern: detectorVersionPattern },
    ),
    threshold_version: requireString(policy.threshold_version, "threshold_version", {
      maximum: 64,
    }),
    threshold: requireFiniteNumber(policy.threshold, "threshold"),
    score_kind: "ranking_not_probability",
    embedding_model_id: requireString(policy.embedding_model_id, "embedding_model_id", {
      maximum: 256,
    }),
    embedding_model_revision: requireString(
      policy.embedding_model_revision,
      "embedding_model_revision",
      { maximum: 128 },
    ),
  };

  const links = requireRecord(
    record.links,
    ["events", "feedback", "self"],
    "suggestion links",
  );
  const parsedLinks = {
    self: requireString(links.self, "links.self", { maximum: 100 }),
    events: requireString(links.events, "links.events", { maximum: 120 }),
    feedback: requireString(links.feedback, "links.feedback", { maximum: 120 }),
  };
  const base = `/v1/suggestions/${suggestionId}`;
  if (
    parsedLinks.self !== base ||
    parsedLinks.events !== `${base}/events` ||
    parsedLinks.feedback !== `${base}/feedback`
  ) {
    throw new Error("suggestion links do not match suggestion_id");
  }

  return {
    schema_version: 1,
    suggestion_id: suggestionId,
    status: "completed",
    outcome: record.outcome,
    abstained: record.abstained,
    abstention_reason: record.abstention_reason,
    review_required: true,
    candidates,
    processing_ms: requireNonNegativeInteger(record.processing_ms, "processing_ms"),
    redaction_entity_counts: parsedCounts,
    policy: parsedPolicy,
    links: parsedLinks,
  };
}

export function parseLiveFeedbackResponse(value: unknown): LiveFeedbackResponse {
  const record = requireRecord(
    value,
    [
      "actor",
      "feedback_id",
      "outcome",
      "recorded",
      "recorded_at",
      "schema_version",
      "selected_detector_id",
      "suggestion_id",
    ],
    "live feedback response",
  );
  if (
    record.schema_version !== 1 ||
    record.recorded !== true ||
    (record.outcome !== "confirmed" && record.outcome !== "none") ||
    (record.actor !== "customer" && record.actor !== "agent")
  ) {
    throw new Error("live feedback response metadata is invalid");
  }
  const selectedDetectorId =
    record.selected_detector_id === null
      ? null
      : requireString(record.selected_detector_id, "selected_detector_id", {
          pattern: detectorIdPattern,
        });
  if (
    (record.outcome === "confirmed" && selectedDetectorId === null) ||
    (record.outcome === "none" && selectedDetectorId !== null)
  ) {
    throw new Error("live feedback response selection is invalid");
  }
  return {
    schema_version: 1,
    feedback_id: requireString(record.feedback_id, "feedback_id", {
      pattern: feedbackIdPattern,
    }),
    suggestion_id: requireString(record.suggestion_id, "suggestion_id", {
      pattern: suggestionIdPattern,
    }),
    recorded: true,
    outcome: record.outcome,
    selected_detector_id: selectedDetectorId,
    actor: record.actor,
    recorded_at: requireTimestamp(record.recorded_at, "recorded_at"),
  };
}

export function parseLiveApiError(value: unknown): LiveApiError {
  const root = requireRecord(value, ["error"], "live API error");
  const error = requireRecord(
    root.error,
    ["code", "message", "request_id"],
    "live API error detail",
  );
  return {
    error: {
      code: requireString(error.code, "error.code", { maximum: 80 }),
      message: requireString(error.message, "error.message", { maximum: 300 }),
      request_id:
        error.request_id === null
          ? null
          : requireString(error.request_id, "error.request_id", { maximum: 80 }),
    },
  };
}

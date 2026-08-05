const STYLE_ID = "wordless-confirm-cards-styles";
const MAX_CANDIDATES = 3;
const LABEL_NAMES = ["heading", "instruction", "none", "selected"] as const;
const SENTENCE_END_PATTERN = /[.!?](?=["'’”)}\]]*(?:\s|$))/gu;
const TERMINAL_SENTENCE_END_PATTERN = /[.!?]["'’”)}\]]*$/u;
const NUMERIC_OR_CURRENCY_PATTERN =
  /(?:[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?|\b(?:USD|EUR|GBP|JPY|CAD|AUD)\s?\d[\d,]*(?:\.\d{1,2})?|\b\d+(?:[.,:/-]\d+)*\b)/iu;
const EXPLICIT_REFERENCE_PATTERN =
  /\b(?:order(?:\s+(?:number|no\.?|id))?|sku)(?:\s*(?:#|:|-)\s*[a-z0-9][a-z0-9._:-]{1,}|\s+(?=[a-z0-9._:-]*[0-9._:-])[a-z0-9][a-z0-9._:-]{1,})\b/iu;
const LABELED_SKU_PATTERN = /\bSKU\s+[A-Z][A-Z0-9_-]{2,}\b/u;
const CONTENT_CHARACTER_PATTERN = /[\p{L}\p{N}]/u;
const LETTER_PATTERN = /\p{L}/u;
let instanceCounter = 0;

export interface ConfirmCandidate {
  id: string;
  title: string;
  detail: string;
  score?: number;
  /** Present when the card came from a Wordless product response. */
  detectorId?: string;
}

export interface ConfirmCardsLabels {
  heading: string;
  instruction: string;
  none: string;
  selected: string;
}

export interface ConfirmCardsOptions {
  candidates: readonly ConfirmCandidate[];
  onConfirm: (candidate: ConfirmCandidate) => void;
  onNone?: () => void;
  labels?: Partial<ConfirmCardsLabels>;
}

export interface ConfirmCardsController {
  update(candidates: readonly ConfirmCandidate[]): void;
  destroy(): void;
}

export interface WordlessSuggestionCandidate {
  id: string;
  detector_id: string;
  title: string;
  detail: string;
  rank: number;
  ranking_score: number;
  evidence: readonly WordlessEvidenceSummary[];
}

export interface WordlessEvidenceSummary {
  ref: string;
  source: string;
  kind: string;
  /** Zero-based position of this record in the request evidence array. */
  input_index: number;
  occurred_at: string;
  provenance: "exported" | "reconstructed" | "inferred";
}

export interface WordlessSuggestionPolicy {
  detector_set_version: string;
  threshold_version: string;
  threshold: number;
  score_kind: "ranking_not_probability";
  embedding_model_id: string;
  embedding_model_revision: string;
}

export interface WordlessSuggestionLinks {
  self: string;
  events: string;
  feedback: string;
}

export interface WordlessSuggestionResponse {
  schema_version: 1;
  suggestion_id: string;
  status: "completed";
  outcome: "candidates" | "abstained";
  abstained: boolean;
  abstention_reason: "no_evidence_hypotheses" | "below_confidence_floor" | null;
  review_required: true;
  candidates: readonly WordlessSuggestionCandidate[];
  processing_ms: number;
  redaction_entity_counts: Readonly<Record<string, number>>;
  policy: WordlessSuggestionPolicy;
  links: WordlessSuggestionLinks;
}

const DEFAULT_LABELS: ConfirmCardsLabels = {
  heading: "What do you need help with?",
  instruction: "Choose the option that best matches. You can also choose none of these.",
  none: "None of these",
  selected: "Selected",
};

export class CandidateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateValidationError";
  }
}

export class SuggestionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuggestionValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  name: string,
  keys: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new SuggestionValidationError(`${name} does not match the exact versioned API contract.`);
  }
}

function requiredString(
  value: Record<string, unknown>,
  name: string,
  pattern?: RegExp,
  maximum = Number.POSITIVE_INFINITY,
): string {
  const item = value[name];
  if (
    typeof item !== "string" ||
    item.length === 0 ||
    item !== item.trim() ||
    Array.from(item).length > maximum
  ) {
    throw new SuggestionValidationError(`${name} must be a non-empty trimmed string.`);
  }
  if (pattern && !pattern.test(item)) {
    throw new SuggestionValidationError(`${name} does not match the versioned API contract.`);
  }
  return item;
}

function requiredFiniteNumber(
  value: Record<string, unknown>,
  name: string,
  { integer = false, nonNegative = false } = {},
): number {
  const item = value[name];
  if (
    typeof item !== "number" ||
    !Number.isFinite(item) ||
    (integer && !Number.isSafeInteger(item)) ||
    (nonNegative && item < 0)
  ) {
    throw new SuggestionValidationError(`${name} must be a valid finite number.`);
  }
  return item;
}

function requiredTimestamp(value: Record<string, unknown>, name: string): string {
  const item = requiredString(value, name, undefined, 64);
  if (
    !Number.isFinite(Date.parse(item)) ||
    !/T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(item)
  ) {
    throw new SuggestionValidationError(`${name} must be a timezone-aware timestamp.`);
  }
  return item;
}

/** Validate one untrusted evidence citation from a Wordless response. */
export function parseEvidenceSummary(value: unknown, index: number): WordlessEvidenceSummary {
  if (!isRecord(value)) {
    throw new SuggestionValidationError(`Candidate evidence ${index + 1} must be an object.`);
  }
  requireExactKeys(value, `Candidate evidence ${index + 1}`, [
    "input_index",
    "kind",
    "occurred_at",
    "provenance",
    "ref",
    "source",
  ]);
  if (
    value.provenance !== "exported" &&
    value.provenance !== "reconstructed" &&
    value.provenance !== "inferred"
  ) {
    throw new SuggestionValidationError("Candidate evidence provenance is invalid.");
  }
  const inputIndex = requiredFiniteNumber(value, "input_index", {
    integer: true,
    nonNegative: true,
  });
  if (inputIndex >= 100) {
    throw new SuggestionValidationError("Candidate evidence input_index must be below 100.");
  }
  return {
    ref: requiredString(value, "ref", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, 128),
    source: requiredString(value, "source", undefined, 64),
    kind: requiredString(value, "kind", undefined, 64),
    input_index: inputIndex,
    occurred_at: requiredTimestamp(value, "occurred_at"),
    provenance: value.provenance,
  };
}

/** Validate the policy metadata shared by suggestion and chat-assist responses. */
export function parseSuggestionPolicy(value: unknown): WordlessSuggestionPolicy {
  if (!isRecord(value)) {
    throw new SuggestionValidationError("Suggestion policy must be an object.");
  }
  requireExactKeys(value, "Suggestion policy", [
    "detector_set_version",
    "embedding_model_id",
    "embedding_model_revision",
    "score_kind",
    "threshold",
    "threshold_version",
  ]);
  if (value.score_kind !== "ranking_not_probability") {
    throw new SuggestionValidationError("Suggestion score kind is invalid.");
  }
  return {
    detector_set_version: requiredString(
      value,
      "detector_set_version",
      /^det_[0-9a-f]{16}$/u,
    ),
    threshold_version: requiredString(value, "threshold_version", undefined, 64),
    threshold: requiredFiniteNumber(value, "threshold", { nonNegative: true }),
    score_kind: "ranking_not_probability",
    embedding_model_id: requiredString(value, "embedding_model_id", undefined, 256),
    embedding_model_revision: requiredString(
      value,
      "embedding_model_revision",
      undefined,
      128,
    ),
  };
}

/** Validate untrusted product JSON before it reaches the confirmation UI. */
export function parseSuggestionResponse(value: unknown): WordlessSuggestionResponse {
  if (!isRecord(value)) {
    throw new SuggestionValidationError("Suggestion response must be an object.");
  }
  requireExactKeys(value, "Suggestion response", [
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
  ]);
  if (value.schema_version !== 1 || value.status !== "completed") {
    throw new SuggestionValidationError("Unsupported suggestion response version or status.");
  }
  const suggestionId = requiredString(value, "suggestion_id", /^sg_[0-9a-f]{32}$/u);
  if (value.outcome !== "candidates" && value.outcome !== "abstained") {
    throw new SuggestionValidationError("Suggestion outcome is invalid.");
  }
  if (typeof value.abstained !== "boolean" || value.review_required !== true) {
    throw new SuggestionValidationError("Suggestion review policy is invalid.");
  }
  if (!Array.isArray(value.candidates) || value.candidates.length > MAX_CANDIDATES) {
    throw new SuggestionValidationError("Suggestion candidates must be an array of at most three items.");
  }

  const ids = new Set<string>();
  const candidates = value.candidates.map((item, index): WordlessSuggestionCandidate => {
    if (!isRecord(item)) {
      throw new SuggestionValidationError(`Candidate ${index + 1} must be an object.`);
    }
    requireExactKeys(item, `Candidate ${index + 1}`, [
      "detail",
      "detector_id",
      "evidence",
      "id",
      "rank",
      "ranking_score",
      "title",
    ]);
    const id = requiredString(
      item,
      "id",
      new RegExp(`^${suggestionId}:[a-z][a-z0-9_]{1,48}$`, "u"),
    );
    const detectorId = requiredString(item, "detector_id", /^[a-z][a-z0-9_]{1,48}$/u);
    if (!id.endsWith(`:${detectorId}`)) {
      throw new SuggestionValidationError(`Candidate ${id} does not match its detector id.`);
    }
    if (ids.has(id)) {
      throw new SuggestionValidationError(`Candidate id ${id} is duplicated.`);
    }
    ids.add(id);
    const title = requiredString(item, "title", undefined, 120);
    const detail = requiredString(item, "detail", undefined, 300);
    const rank = item.rank;
    if (!Number.isInteger(rank) || rank !== index + 1) {
      throw new SuggestionValidationError("Candidate ranks must be contiguous from one.");
    }
    const rankingScore = requiredFiniteNumber(item, "ranking_score", {
      nonNegative: true,
    });
    if (!Array.isArray(item.evidence) || item.evidence.length < 1 || item.evidence.length > 20) {
      throw new SuggestionValidationError(`Candidate ${id} must cite 1–20 evidence records.`);
    }
    return {
      id,
      detector_id: detectorId,
      title,
      detail,
      rank: rank as number,
      ranking_score: rankingScore,
      evidence: item.evidence.map(parseEvidenceSummary),
    };
  });

  const abstained = value.abstained;
  const abstentionReason = value.abstention_reason;
  if (
    abstentionReason !== null &&
    abstentionReason !== "no_evidence_hypotheses" &&
    abstentionReason !== "below_confidence_floor"
  ) {
    throw new SuggestionValidationError("Suggestion abstention reason is invalid.");
  }
  if (
    abstained !== (candidates.length === 0) ||
    (value.outcome === "abstained") !== abstained ||
    (abstentionReason !== null) !== abstained
  ) {
    throw new SuggestionValidationError("Suggestion outcome and candidate count disagree.");
  }
  const processingMs = requiredFiniteNumber(value, "processing_ms", {
    integer: true,
    nonNegative: true,
  });
  if (!isRecord(value.redaction_entity_counts)) {
    throw new SuggestionValidationError("Redaction entity counts must be an object.");
  }
  const redactionEntityCounts: Record<string, number> = {};
  for (const [name, count] of Object.entries(value.redaction_entity_counts)) {
    if (!name || name !== name.trim() || name.length > 64) {
      throw new SuggestionValidationError("Redaction entity names are invalid.");
    }
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new SuggestionValidationError(`Redaction count ${name} is invalid.`);
    }
    redactionEntityCounts[name] = count as number;
  }
  const policy = parseSuggestionPolicy(value.policy);
  if (!isRecord(value.links)) {
    throw new SuggestionValidationError("Suggestion links must be an object.");
  }
  requireExactKeys(value.links, "Suggestion links", ["events", "feedback", "self"]);
  const base = `/v1/suggestions/${suggestionId}`;
  const links: WordlessSuggestionLinks = {
    self: requiredString(value.links, "self"),
    events: requiredString(value.links, "events"),
    feedback: requiredString(value.links, "feedback"),
  };
  if (
    links.self !== base ||
    links.events !== `${base}/events` ||
    links.feedback !== `${base}/feedback`
  ) {
    throw new SuggestionValidationError("Suggestion links do not match the suggestion id.");
  }
  const mapped = candidates.map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    detail: candidate.detail,
    score: candidate.ranking_score,
    detectorId: candidate.detector_id,
  }));
  validateCandidates(mapped);
  return {
    schema_version: 1,
    suggestion_id: suggestionId,
    status: "completed",
    outcome: value.outcome,
    abstained,
    abstention_reason: abstentionReason,
    review_required: true,
    candidates,
    processing_ms: processingMs,
    redaction_entity_counts: redactionEntityCounts,
    policy,
    links,
  };
}

/** Map a validated product response into the credential-free card renderer. */
export function suggestionCandidates(value: unknown): readonly ConfirmCandidate[] {
  return parseSuggestionResponse(value).candidates.map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    detail: candidate.detail,
    score: candidate.ranking_score,
    detectorId: candidate.detector_id,
  }));
}

function wordCount(value: string): number {
  return value
    .trim()
    .split(/\s+/u)
    .filter((token) => CONTENT_CHARACTER_PATTERN.test(token)).length;
}

function hasAccessibleText(value: unknown): value is string {
  return typeof value === "string" && value.replace(/[\s\p{Cf}]/gu, "").length > 0;
}

function validateLabels(labels: ConfirmCardsLabels): void {
  for (const name of LABEL_NAMES) {
    if (!hasAccessibleText(labels[name])) {
      throw new CandidateValidationError(`Label ${name} must contain accessible text.`);
    }
  }
}

function hasExactlyOneSentence(value: string): boolean {
  const trimmed = value.trim();
  if (!TERMINAL_SENTENCE_END_PATTERN.test(trimmed)) return false;
  return [...trimmed.matchAll(SENTENCE_END_PATTERN)].length === 1;
}

function validateCandidate(candidate: ConfirmCandidate, index: number): void {
  if (!candidate.id.trim()) {
    throw new CandidateValidationError(`Candidate ${index + 1} needs an id.`);
  }
  const titleWords = wordCount(candidate.title);
  if (titleWords < 3 || titleWords > 7) {
    throw new CandidateValidationError(
      `Candidate ${candidate.id} title must contain 3–7 words; received ${titleWords}.`,
    );
  }
  const detailWords = wordCount(candidate.detail);
  if (detailWords < 3 || detailWords >= 20 || !LETTER_PATTERN.test(candidate.detail)) {
    throw new CandidateValidationError(
      `Candidate ${candidate.id} detail must contain 3–19 meaningful words; received ${detailWords}.`,
    );
  }
  if (!hasExactlyOneSentence(candidate.detail)) {
    throw new CandidateValidationError(
      `Candidate ${candidate.id} detail must be exactly one complete sentence.`,
    );
  }
  if (
    !NUMERIC_OR_CURRENCY_PATTERN.test(candidate.detail) &&
    !EXPLICIT_REFERENCE_PATTERN.test(candidate.detail) &&
    !LABELED_SKU_PATTERN.test(candidate.detail)
  ) {
    throw new CandidateValidationError(
      `Candidate ${candidate.id} detail must include a concrete number, currency amount, order/SKU, or ISO/date-like value.`,
    );
  }
  if (candidate.score !== undefined && (!Number.isFinite(candidate.score) || candidate.score < 0)) {
    throw new CandidateValidationError(`Candidate ${candidate.id} score must be a non-negative number.`);
  }
}

function validateCandidates(candidates: readonly ConfirmCandidate[]): readonly ConfirmCandidate[] {
  if (candidates.length > MAX_CANDIDATES) {
    throw new CandidateValidationError(`At most ${MAX_CANDIDATES} candidates can be rendered.`);
  }
  const ids = new Set<string>();
  candidates.forEach((candidate, index) => {
    validateCandidate(candidate, index);
    if (ids.has(candidate.id)) {
      throw new CandidateValidationError(`Candidate id ${candidate.id} is duplicated.`);
    }
    ids.add(candidate.id);
  });
  return candidates;
}

function addStyles(document: Document): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .wl-confirm { color: #14181f; font: 400 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 42rem; }
    .wl-confirm * { box-sizing: border-box; }
    .wl-confirm__heading { font-size: 1.25rem; font-weight: 600; line-height: 1.25; margin: 0 0 .5rem; }
    .wl-confirm__instruction { color: #4a5462; margin: 0 0 1rem; max-width: 60ch; }
    .wl-confirm__list { display: grid; gap: .75rem; list-style: none; margin: 0; padding: 0; }
    .wl-confirm__choice, .wl-confirm__none { appearance: none; background: #fff; border: 1px solid #4a5462; border-radius: .25rem; color: #14181f; cursor: pointer; display: block; font: inherit; min-height: 44px; padding: .875rem 1rem; text-align: left; width: 100%; }
    .wl-confirm__choice:hover, .wl-confirm__none:hover { border-color: #4a5462; }
    .wl-confirm__choice:focus-visible, .wl-confirm__none:focus-visible { outline: 3px solid #2f5d4f; outline-offset: 3px; }
    .wl-confirm__choice[aria-pressed="true"] { background: #edf5f1; border-color: #2f5d4f; border-width: 2px; padding: calc(.875rem - 1px) calc(1rem - 1px); }
    .wl-confirm__title { display: block; font-weight: 600; }
    .wl-confirm__detail { color: #4a5462; display: block; font-size: .9375rem; margin-top: .25rem; }
    .wl-confirm__state { color: #2f5d4f; display: block; font-size: .8125rem; font-weight: 600; margin-top: .375rem; }
    .wl-confirm__none { margin-top: .75rem; text-align: center; }
    @media (prefers-reduced-motion: no-preference) {
      .wl-confirm__choice, .wl-confirm__none { transition: background-color 120ms ease, border-color 120ms ease; }
    }
    @media (forced-colors: active) {
      .wl-confirm__choice[aria-pressed="true"] { border-width: 3px; }
    }
  `;
  document.head.append(style);
}

function createTextElement(document: Document, className: string, text: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

export function mountConfirmCards(
  root: HTMLElement,
  options: ConfirmCardsOptions,
): ConfirmCardsController {
  const document = root.ownerDocument;
  const labels: ConfirmCardsLabels = { ...DEFAULT_LABELS, ...options.labels };
  validateLabels(labels);
  let candidates = validateCandidates(options.candidates);
  let selectedId: string | null = null;
  let disposed = false;
  const instanceId = ++instanceCounter;

  addStyles(document);

  const render = (): void => {
    if (disposed) return;
    root.replaceChildren();
    const region = document.createElement("section");
    region.className = "wl-confirm";
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "false");

    const heading = document.createElement("h2");
    heading.className = "wl-confirm__heading";
    heading.textContent = labels.heading;
    const headingId = `wl-confirm-${instanceId}-heading`;
    heading.id = headingId;
    region.setAttribute("aria-labelledby", headingId);
    region.append(heading);

    const instruction = document.createElement("p");
    instruction.className = "wl-confirm__instruction";
    instruction.textContent = labels.instruction;
    region.append(instruction);

    const list = document.createElement("ul");
    list.className = "wl-confirm__list";
    const buttons: HTMLButtonElement[] = [];

    candidates.forEach((candidate, index) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.className = "wl-confirm__choice";
      button.type = "button";
      button.dataset.candidateId = candidate.id;
      button.setAttribute("aria-pressed", String(selectedId === candidate.id));
      button.append(
        createTextElement(document, "wl-confirm__title", candidate.title),
        createTextElement(document, "wl-confirm__detail", candidate.detail),
      );
      if (selectedId === candidate.id) {
        button.append(createTextElement(document, "wl-confirm__state", `✓ ${labels.selected}`));
      }
      button.addEventListener("click", () => {
        selectedId = candidate.id;
        options.onConfirm(candidate);
        render();
        const replacement = [...root.querySelectorAll<HTMLButtonElement>("[data-candidate-id]")]
          .find((element) => element.dataset.candidateId === candidate.id);
        replacement?.focus();
      });
      button.addEventListener("keydown", (event) => {
        if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) return;
        event.preventDefault();
        const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
        const targetIndex = (index + direction + buttons.length) % buttons.length;
        buttons[targetIndex]?.focus();
      });
      buttons.push(button);
      item.append(button);
      list.append(item);
    });
    region.append(list);

    const none = document.createElement("button");
    none.className = "wl-confirm__none";
    none.type = "button";
    none.textContent = labels.none;
    none.addEventListener("click", () => {
      selectedId = null;
      options.onNone?.();
      render();
      root.querySelector<HTMLButtonElement>(".wl-confirm__none")?.focus();
    });
    region.append(none);
    root.append(region);
  };

  render();

  return {
    update(nextCandidates: readonly ConfirmCandidate[]): void {
      candidates = validateCandidates(nextCandidates);
      if (selectedId && !candidates.some((candidate) => candidate.id === selectedId)) {
        selectedId = null;
      }
      render();
    },
    destroy(): void {
      disposed = true;
      root.replaceChildren();
    },
  };
}

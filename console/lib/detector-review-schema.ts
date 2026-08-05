export const detectorIds = [
  "duplicate_charge",
  "wrong_item",
  "account_lock",
  "late_delivery",
] as const;

export const detectorStatuses = [
  "proposed",
  "approved",
  "edited",
  "rejected",
] as const;

export type DetectorId = (typeof detectorIds)[number];
export type PersistedDetectorStatus = (typeof detectorStatuses)[number];

export type DetectorReviewRecord = {
  id: DetectorId;
  status: PersistedDetectorStatus;
  condition: string;
};

export type DetectorReviewResponse = {
  reviews: DetectorReviewRecord[];
  source: "defaults" | "file";
  updatedAt: string | null;
};

const detectorIdSet = new Set<string>(detectorIds);
const detectorStatusSet = new Set<string>(detectorStatuses);
const mutationStatusSet = new Set<string>(["approved", "edited", "rejected"]);
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;

export const maximumConditionLength = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseCondition(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("condition must be a string");
  }
  const condition = value.trim().replace(/[ \t\r\n]+/g, " ");
  if (!condition) {
    throw new Error("condition cannot be empty");
  }
  if (Array.from(condition).length > maximumConditionLength) {
    throw new Error(`condition must be at most ${maximumConditionLength} characters`);
  }
  if (controlCharacters.test(condition)) {
    throw new Error("condition cannot contain control characters");
  }
  return condition;
}

function parseId(value: unknown): DetectorId {
  if (typeof value !== "string" || !detectorIdSet.has(value)) {
    throw new Error("id is not a known fixture detector");
  }
  return value as DetectorId;
}

function parseStatus(
  value: unknown,
  options: { allowProposed: boolean },
): PersistedDetectorStatus {
  const allowed = options.allowProposed ? detectorStatusSet : mutationStatusSet;
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(
      options.allowProposed
        ? "status is invalid"
        : "status must be approved, edited, or rejected",
    );
  }
  return value as PersistedDetectorStatus;
}

function parseReview(
  value: unknown,
  options: { allowProposed: boolean },
): DetectorReviewRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "status", "condition"])) {
    throw new Error("review must contain only id, status, and condition");
  }
  return {
    id: parseId(value.id),
    status: parseStatus(value.status, options),
    condition: parseCondition(value.condition),
  };
}

export function parseReviewMutation(value: unknown): DetectorReviewRecord {
  return parseReview(value, { allowProposed: false });
}

export function parseStoredReviews(value: unknown): DetectorReviewRecord[] {
  if (!Array.isArray(value) || value.length !== detectorIds.length) {
    throw new Error(`reviews must contain exactly ${detectorIds.length} records`);
  }
  const reviews = value.map((item) => parseReview(item, { allowProposed: true }));
  const ids = new Set(reviews.map((review) => review.id));
  if (ids.size !== detectorIds.length || detectorIds.some((id) => !ids.has(id))) {
    throw new Error("reviews must contain each fixture detector exactly once");
  }
  return detectorIds.map((id) => reviews.find((review) => review.id === id)!);
}

export function parseReviewResponse(value: unknown): DetectorReviewResponse {
  if (!isRecord(value) || !hasOnlyKeys(value, ["reviews", "source", "updatedAt"])) {
    throw new Error("review response has an invalid shape");
  }
  if (value.source !== "defaults" && value.source !== "file") {
    throw new Error("review response source is invalid");
  }
  if (
    value.updatedAt !== null &&
    (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)))
  ) {
    throw new Error("review response timestamp is invalid");
  }
  return {
    reviews: parseStoredReviews(value.reviews),
    source: value.source,
    updatedAt: value.updatedAt,
  };
}

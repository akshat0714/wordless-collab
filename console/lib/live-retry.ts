export const liveSuggestionRetryWindowMs = 15 * 60_000;

export type LiveSuggestionAttempt = {
  fingerprint: string;
  requestId: string;
  observedAt: string;
};

export function canReuseLiveSuggestionAttempt(
  attempt: LiveSuggestionAttempt | null,
  fingerprint: string,
  nowMs: number = Date.now(),
): boolean {
  if (attempt === null || attempt.fingerprint !== fingerprint) return false;
  const observedAtMs = Date.parse(attempt.observedAt);
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(nowMs)) return false;

  const ageMs = nowMs - observedAtMs;
  return ageMs >= -30_000 && ageMs < liveSuggestionRetryWindowMs;
}

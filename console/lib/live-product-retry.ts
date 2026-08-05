const retryableStatuses = new Set([502, 503, 504]);

export type SafeProductFetchOptions = {
  target: URL;
  init: Omit<RequestInit, "signal">;
  requestSignal: AbortSignal;
  timeoutMs: number;
  retryOnce: boolean;
  fetchImplementation?: typeof globalThis.fetch;
};

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is being discarded for a bounded retry; cancellation is best-effort.
  }
}

/**
 * Make at most two byte-identical idempotent POST attempts. Callers must build
 * the body, idempotency key, and signature headers once before entering here.
 */
export async function fetchProductWithSafeRetry({
  target,
  init,
  requestSignal,
  timeoutMs,
  retryOnce,
  fetchImplementation = globalThis.fetch,
}: SafeProductFetchOptions): Promise<Response> {
  const attempts = retryOnce ? 2 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (requestSignal.aborted) {
      throw new DOMException("The request was aborted.", "AbortError");
    }
    const signal = AbortSignal.any([
      requestSignal,
      AbortSignal.timeout(timeoutMs),
    ]);
    try {
      const response = await fetchImplementation(target, { ...init, signal });
      if (attempt + 1 < attempts && retryableStatuses.has(response.status)) {
        await discard(response);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (requestSignal.aborted || attempt + 1 >= attempts) throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("The product request failed.");
}

export interface RetryOptions {
  maxAttempts?: number;
  attempt: number;
  retryAfterMs?: number;
  signal?: AbortSignal;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;
const JITTER_RATIO = 0.25;

/**
 * Exponential backoff with jitter:
 * delay = min(500 × 2^(attempt-1), 32000) + random(0~25%)
 */
export function computeBackoffDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return retryAfterMs;
  }
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(BASE_DELAY_MS * 2 ** exponent, MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * base * JITTER_RATIO);
  return base + jitter;
}

export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) {
    throw new Error("Run aborted by user.");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Run aborted by user."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function backoffBeforeRetry(options: RetryOptions): Promise<void> {
  const delayMs = computeBackoffDelayMs(options.attempt, options.retryAfterMs);
  await sleepWithAbort(delayMs, options.signal);
}

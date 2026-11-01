export function isRuntimeCancellation(
  error: unknown,
  ...signals: Array<AbortSignal | undefined>
): boolean {
  if (signals.some((signal) => signal?.aborted)) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; cause?: unknown };
  if (
    candidate.name === "AbortError" ||
    candidate.name === "APIUserAbortError" ||
    candidate.code === "ABORT_ERR"
  ) {
    return true;
  }
  return candidate.cause !== error && isRuntimeCancellation(candidate.cause);
}

export function rethrowIfRuntimeCancellation(
  error: unknown,
  ...signals: Array<AbortSignal | undefined>
): void {
  if (isRuntimeCancellation(error, ...signals)) throw error;
}

/**
 * Wraps an async check so concurrent callers share one in-flight call instead of starting their own
 * (no overlapping readiness probes against Redis, ADR-0034 review). The next call after it settles
 * starts a fresh one, so results are never stale.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return () => {
    inFlight ??= fn().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

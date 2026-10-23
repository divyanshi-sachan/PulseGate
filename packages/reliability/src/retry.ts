/** Methods that may be retried automatically (ADR-0033 decision 3): safe methods only. */
export const RETRYABLE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface RetrySettings {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatuses: readonly number[];
}

/** Whether a request may be retried at all: safe method, no request body, more than one attempt. */
export function isRetryEligible(
  method: string,
  hasBody: boolean,
  settings: RetrySettings,
): boolean {
  return settings.maxAttempts > 1 && !hasBody && RETRYABLE_METHODS.has(method.toUpperCase());
}

/**
 * Full-jitter exponential backoff before retry number `retry` (1 = first retry):
 * random() × min(maxDelayMs, baseDelayMs × 2^(retry − 1)) (ADR-0007, ADR-0033).
 */
export function backoffDelayMs(
  retry: number,
  settings: RetrySettings,
  random: () => number,
): number {
  const ceiling = Math.min(settings.maxDelayMs, settings.baseDelayMs * 2 ** (retry - 1));
  return Math.floor(random() * ceiling);
}

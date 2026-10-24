import { GATEWAY_ERRORS } from '@pulsegate/shared';

/** Rolling window shape (ADR-0037 amendment: 30 × 10 s). */
export const WINDOW_SECONDS = 300;
export const BUCKET_SECONDS = 10;
export const BUCKET_COUNT = WINDOW_SECONDS / BUCKET_SECONDS;
/** Latency reservoir per bucket and series (plan §2.1). */
export const RESERVOIR_SIZE = 512;
export const PERCENTILES = { p50: 0.5, p95: 0.95, p99: 0.99 } as const;
export type PercentileName = keyof typeof PERCENTILES;

/**
 * Accuracy target for "ok" confidence (ADR-0038 review): with 95 % probability, the reported value lies
 * between the true (q − δ)- and (q + δ)-quantiles. This is distribution-free, because it is a statement
 * about ranks. δ per percentile, in quantile units (0.005 = ±0.5 percentile points):
 */
export const RANK_TOLERANCE: Readonly<Record<PercentileName, number>> = {
  p50: 0.05,
  p95: 0.02,
  p99: 0.005,
};
export const CONFIDENCE_Z = 1.959963984540054;

/** Samples needed for the accuracy target: n ≥ z² q (1 − q) / δ² (normal approximation to the binomial rank). */
export function requiredSamples(q: number, tolerance: number): number {
  return Math.ceil((CONFIDENCE_Z * CONFIDENCE_Z * q * (1 - q)) / (tolerance * tolerance));
}

/** p50: 385, p95: 457, p99: 1,522 (effective) samples. */
export const REQUIRED_SAMPLES: Readonly<Record<PercentileName, number>> = {
  p50: requiredSamples(PERCENTILES.p50, RANK_TOLERANCE.p50),
  p95: requiredSamples(PERCENTILES.p95, RANK_TOLERANCE.p95),
  p99: requiredSamples(PERCENTILES.p99, RANK_TOLERANCE.p99),
};

/** Every `code` a counter can carry: the error registry plus the two non-registry outcomes. */
export const COUNTED_CODES = [...Object.keys(GATEWAY_ERRORS), 'CLIENT_ABORTED', 'other'] as const;
export type CountedCode = (typeof COUNTED_CODES)[number];

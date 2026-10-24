import { GATEWAY_ERRORS } from '@pulsegate/shared';

/**
 * Shortest accepted ADMIN_TOKEN (plan §5, Claude-chosen): 32 characters, e.g. `openssl rand -hex 32`. Shared so the
 * gateway refuses to start with a shorter one and the dashboard's token gate can explain the rule (ADR-0039, ADR-0041).
 */
export const MIN_ADMIN_TOKEN_LENGTH = 32;

/** Rolling window shape (ADR-0037 amendment: 30 × 10 s). */
export const WINDOW_SECONDS = 300;
export const BUCKET_SECONDS = 10;
export const BUCKET_COUNT = WINDOW_SECONDS / BUCKET_SECONDS;
/** Latency reservoir per bucket and series (plan §2.1). */
export const RESERVOIR_SIZE = 512;
export const PERCENTILES = { p50: 0.5, p95: 0.95, p99: 0.99 } as const;
export type PercentileName = keyof typeof PERCENTILES;

/**
 * Percentile confidence (ADR-0038, second review). Labels, from weakest to strongest:
 * - `none`: no observations.
 * - `low`: too few (effective) samples for the accuracy target below.
 * - `approximate`: a window merge of buckets with possibly unequal weights and different distributions. Both the
 *   Kish and the stratified (Woodruff) effective sample sizes meet the threshold. Empirically calibrated, not a
 *   guarantee (see ADR-0038).
 * - `adequate`: a single bucket whose sample count meets the exact threshold below.
 *
 * Accuracy target: if the samples are independent draws from one continuous latency distribution, the reported
 * nearest-rank value lies between the true (q − δ)- and (q + δ)-quantiles with probability ≥ COVERAGE_TARGET.
 * F(X₍ₖ₎) ~ Beta(k, n − k + 1), so this is an exact, distribution-free order-statistic calculation.
 * ADEQUATE_SAMPLES is the smallest n from which coverage stays ≥ the target for every larger n (checked to
 * n = 200,000; coverage oscillates because k = ⌈qn⌉ is an integer).
 */
export const COVERAGE_TARGET = 0.95;
/** δ per percentile, in quantile units (0.005 = ±0.5 percentile points). */
export const RANK_TOLERANCE: Readonly<Record<PercentileName, number>> = {
  p50: 0.05,
  p95: 0.02,
  p99: 0.005,
};
/** Exact thresholds for the target above (verified in tests by the incomplete beta function). */
export const ADEQUATE_SAMPLES: Readonly<Record<PercentileName, number>> = {
  p50: 383,
  p95: 484,
  p99: 1707,
};

/** Every `code` a counter can carry: the error registry plus the two non-registry outcomes. */
export const COUNTED_CODES = [...Object.keys(GATEWAY_ERRORS), 'CLIENT_ABORTED', 'other'] as const;
export type CountedCode = (typeof COUNTED_CODES)[number];

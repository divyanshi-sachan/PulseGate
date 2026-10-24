import {
  CONFIDENCE_TAIL_MIN,
  type Percentile,
  type RouteCounters,
  type RouteRates,
  type UpstreamCounters,
  type UpstreamRates,
} from '@pulsegate/admin-contract';

/**
 * Pure statistics for the rolling window (plan §2.1, §2.3). No state, no clock: everything here is
 * unit-tested against brute-force references.
 */

/** Empirical quantile by nearest rank: the smallest value with at least ⌈q·n⌉ values at or below it. */
export function nearestRank(sorted: ArrayLike<number>, q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1];
}

export interface WeightedSample {
  value: number;
  weight: number;
}

/** Weighted nearest rank: the smallest value whose cumulative weight reaches q of the total. */
export function weightedQuantile(
  samples: readonly WeightedSample[],
  q: number,
): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, s) => sum + s.weight, 0);
  const target = q * total;
  let cumulative = 0;
  for (const sample of sorted) {
    cumulative += sample.weight;
    // Small epsilon so floating-point sums can't skip the exact boundary.
    if (cumulative >= target - total * 1e-12) return sample.value;
  }
  return sorted.at(-1)?.value;
}

/** Kish's effective sample size of a weighted sample: (Σw)² / Σw². Equals n for equal weights. */
export function effectiveSampleSize(weights: readonly number[]): number {
  let sum = 0;
  let squares = 0;
  for (const w of weights) {
    sum += w;
    squares += w * w;
  }
  return squares === 0 ? 0 : (sum * sum) / squares;
}

/** Builds a Percentile per plan §2.1: confidence is "low" with fewer than 5 samples beyond the estimate. */
export function percentile(input: {
  value: number | undefined;
  observations: number;
  /** Retained samples, or the effective sample size for a weighted merge. */
  samples: number;
  exact: boolean;
  q: number;
}): Percentile {
  const samples = Math.floor(input.samples);
  if (input.observations === 0 || input.value === undefined) {
    return {
      value: null,
      method: input.exact ? 'exact' : 'sampled',
      observations: input.observations,
      samples,
      tailSamples: 0,
      confidence: 'none',
    };
  }
  const tailSamples = Math.floor(input.samples * (1 - input.q) + 1e-9);
  return {
    value: input.value,
    method: input.exact ? 'exact' : 'sampled',
    observations: input.observations,
    samples,
    tailSamples,
    confidence: tailSamples >= CONFIDENCE_TAIL_MIN ? 'ok' : 'low',
  };
}

/** n ÷ d, or null when d is 0: a rate without a denominator is unknown, not 0 % (plan §2.3). */
export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Every request-level rate, from summed counters (plan §2.3 table). */
export function routeRates(c: RouteCounters, durationMs: number): RouteRates {
  const limiterDecisions = c.rl.allowed + c.rl.rejected;
  const lookups = c.cache.hit + c.cache.miss;
  const decidedAttempts = c.attempts.success + c.attempts.failure;
  const allAttempts = decidedAttempts + c.attempts.aborted;
  return {
    rps: durationMs > 0 ? c.requests / (durationMs / 1000) : null,
    successRate: ratio(c.status['2xx'] + c.status['3xx'], c.requests),
    clientErrorRate: ratio(c.status['4xx'], c.requests),
    errorRate: ratio(c.status['5xx'], c.requests),
    abortRate: ratio(c.aborted, c.requests + c.aborted),
    rateLimitRejectionRate: ratio(c.rl.rejected, limiterDecisions),
    rateLimiterUnavailableRate: ratio(c.rlUnavailable, limiterDecisions + c.rlUnavailable),
    // Bypasses never enter the hit ratio's denominator.
    cacheHitRatio: ratio(c.cache.hit, lookups),
    cacheBypassRate: ratio(c.cache.bypass, lookups + c.cache.bypass),
    cacheStoreRate: ratio(c.store.stored, c.cache.miss),
    // Per attempt; aborted attempts are neutral (ADR-0024).
    upstreamFailureRate: ratio(c.attempts.failure, decidedAttempts),
    retryRate: ratio(c.retries, allAttempts - c.retries),
  };
}

export function upstreamRates(c: UpstreamCounters, durationMs: number): UpstreamRates {
  const all = c.attempts.success + c.attempts.failure + c.attempts.aborted;
  return {
    attemptsPerSecond: durationMs > 0 ? all / (durationMs / 1000) : null,
    upstreamFailureRate: ratio(c.attempts.failure, c.attempts.success + c.attempts.failure),
  };
}

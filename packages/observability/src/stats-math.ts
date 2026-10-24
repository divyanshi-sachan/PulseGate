import {
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
    // Weights are float64 (bucket observations ÷ retained samples, e.g. 600/512 = 1.171875). The relative
    // epsilon only absorbs summation rounding at an exact boundary, where nearest rank takes the lower value.
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

/** One bucket's contribution to the window's stratified variance at the estimated quantile. */
export interface Stratum {
  /** Bucket observations ÷ window observations (W_h). */
  share: number;
  /** Retained samples in the bucket (n_h). */
  samples: number;
  /** Retained samples at or below the estimated quantile. */
  atOrBelow: number;
}

/**
 * Woodruff/stratified effective sample size at the estimated quantile: q(1 − q) / Σ W_h² p_h(1 − p_h)/n_h, with
 * p_h the bucket's own fraction at or below the estimate. Unlike Kish's ESS it accounts for buckets whose latency
 * distributions differ, but it is overconfident when buckets are "pure" (p_h ∈ {0, 1}): Infinity when every
 * bucket is. The window rule therefore takes min(Kish, Woodruff) (ADR-0038).
 */
export function stratifiedEffectiveSamples(strata: readonly Stratum[], q: number): number {
  let variance = 0;
  for (const s of strata) {
    if (s.samples === 0) continue;
    const p = s.atOrBelow / s.samples;
    variance += (s.share * s.share * p * (1 - p)) / s.samples;
  }
  return variance === 0 ? Infinity : (q * (1 - q)) / variance;
}

/**
 * Builds a Percentile (ADR-0038, second review). A bucket meeting the exact threshold is "adequate"; a window
 * merge can at most be "approximate", because its weighted, stratified estimate has no exact guarantee.
 */
export function percentile(input: {
  value: number | undefined;
  observations: number;
  /** Retained samples. */
  samples: number;
  /** Samples the rule uses: retained samples (bucket) or min(Kish, Woodruff) (window). */
  effectiveSamples: number;
  exact: boolean;
  q: number;
  /** ADEQUATE_SAMPLES for this percentile. */
  threshold: number;
  scope: 'bucket' | 'window';
}): Percentile {
  const samples = Math.floor(input.samples);
  const effective = Number.isFinite(input.effectiveSamples)
    ? Math.floor(input.effectiveSamples)
    : samples;
  const method = input.exact ? 'exact' : 'sampled';
  if (input.observations === 0 || input.value === undefined) {
    return {
      value: null,
      method,
      observations: input.observations,
      samples,
      effectiveSamples: 0,
      tailSamples: 0,
      confidence: 'none',
    };
  }
  const enough = effective >= input.threshold;
  return {
    value: input.value,
    method,
    observations: input.observations,
    samples,
    effectiveSamples: effective,
    tailSamples: Math.floor(effective * (1 - input.q) + 1e-9),
    confidence: !enough ? 'low' : input.scope === 'bucket' ? 'adequate' : 'approximate',
  };
}

/**
 * Exact coverage of the nearest-rank estimate for n independent samples from a continuous distribution:
 * P(q − δ ≤ F(X₍ₖ₎) ≤ q + δ) with k = ⌈qn⌉ and F(X₍ₖ₎) ~ Beta(k, n − k + 1). Used to verify ADEQUATE_SAMPLES.
 */
export function orderStatisticCoverage(n: number, q: number, delta: number): number {
  const k = Math.max(1, Math.ceil(q * n));
  return (
    regularizedBeta(Math.min(1, q + delta), k, n - k + 1) -
    regularizedBeta(Math.max(0, q - delta), k, n - k + 1)
  );
}

function logGamma(x: number): number {
  // Lanczos approximation (g = 7, n = 9), accurate to ~15 significant digits for x > 0.
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = c[0] ?? 0;
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += (c[i] ?? 0) / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized incomplete beta I_x(a, b) by Lentz's continued fraction (Numerical Recipes betacf). */
export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - regularizedBeta(1 - x, b, a);
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let f = d;
  for (let m = 1; m <= 10_000; m++) {
    const m2 = 2 * m;
    let num = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + num * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + num / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    f *= d * c;
    num = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + num * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + num / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return (front * f) / a;
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

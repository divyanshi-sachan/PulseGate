import {
  ADEQUATE_SAMPLES,
  COVERAGE_TARGET,
  PERCENTILES,
  RANK_TOLERANCE,
} from '@pulsegate/admin-contract';
import { describe, expect, it } from 'vitest';
import {
  effectiveSampleSize,
  nearestRank,
  orderStatisticCoverage,
  percentile,
  regularizedBeta,
  routeRates,
  stratifiedEffectiveSamples,
  upstreamRates,
  weightedQuantile,
} from './index.ts';
import type { RouteCounters } from '@pulsegate/admin-contract';

/** Small deterministic PRNG (mulberry32) for brute-force comparisons. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('quantiles (plan §2.1)', () => {
  it('uses nearest rank on sorted values', () => {
    const values = Array.from({ length: 10 }, (_, i) => i + 1);
    expect([
      nearestRank(values, 0.5),
      nearestRank(values, 0.95),
      nearestRank(values, 0.99),
    ]).toEqual([5, 10, 10]);
    expect(nearestRank([7], 0.99)).toBe(7);
    expect(nearestRank([], 0.5)).toBeUndefined();
  });

  it('matches a brute-force expansion for integer weights', () => {
    const random = rng(42);
    for (let trial = 0; trial < 200; trial++) {
      const samples = Array.from({ length: 1 + Math.floor(random() * 40) }, () => ({
        value: Math.floor(random() * 1000),
        weight: 1 + Math.floor(random() * 5),
      }));
      const expanded = samples
        .flatMap((s) => Array.from({ length: s.weight }, () => s.value))
        .sort((a, b) => a - b);
      for (const q of [0.5, 0.95, 0.99]) {
        expect(weightedQuantile(samples, q)).toBe(nearestRank(expanded, q));
      }
    }
  });

  it('reduces to nearest rank with equal weights', () => {
    const values = [5, 1, 9, 3, 7];
    expect(
      weightedQuantile(
        values.map((value) => ({ value, weight: 1 })),
        0.5,
      ),
    ).toBe(5);
  });

  it('computes Kish effective sample size', () => {
    expect(effectiveSampleSize([1, 1, 1, 1])).toBe(4);
    expect(effectiveSampleSize([])).toBe(0);
    expect(effectiveSampleSize([100, 1, 1])).toBeCloseTo(10404 / 10002, 6);
  });
});

describe('weighted quantile edge cases (ADR-0038 review)', () => {
  it('matches exact expansion for fractional weights (multiples of 1/8)', () => {
    const random = rng(7);
    for (let trial = 0; trial < 200; trial++) {
      const samples = Array.from({ length: 1 + Math.floor(random() * 30) }, () => ({
        value: Math.floor(random() * 50), // many ties
        weight: (1 + Math.floor(random() * 24)) / 8,
      }));
      const expanded = samples
        .flatMap((s) => Array.from({ length: Math.round(s.weight * 8) }, () => s.value))
        .sort((a, b) => a - b);
      for (const q of [0.5, 0.95, 0.99])
        expect(weightedQuantile(samples, q)).toBe(nearestRank(expanded, q));
    }
  });

  it('takes the lower value when the cumulative weight lands exactly on the target', () => {
    expect(
      weightedQuantile(
        [
          { value: 1, weight: 1 },
          { value: 2, weight: 1 },
        ],
        0.5,
      ),
    ).toBe(1);
    // 0.1 + 0.2 = 0.30000000000000004: the epsilon must not move the boundary to the next value.
    const tenths = Array.from({ length: 10 }, (_, i) => ({ value: i + 1, weight: 0.1 }));
    expect(weightedQuantile(tenths, 0.3)).toBe(3);
    expect(weightedQuantile(tenths, 0.31)).toBe(4);
  });

  it('handles ties at the quantile boundary', () => {
    const samples = [5, 5, 5, 5, 9].map((value) => ({ value, weight: 1.171875 }));
    expect(weightedQuantile(samples, 0.8)).toBe(5);
    expect(weightedQuantile(samples, 0.81)).toBe(9);
  });

  it('is unaffected by input order', () => {
    const samples = [3, 1, 2].map((value, i) => ({ value, weight: i + 0.5 }));
    expect(weightedQuantile(samples, 0.5)).toBe(weightedQuantile([...samples].reverse(), 0.5));
  });
});

describe('exact order-statistic thresholds (ADR-0038, second review)', () => {
  it('computes the regularized incomplete beta like SciPy', () => {
    expect(regularizedBeta(0.3, 2, 3)).toBeCloseTo(0.3483, 10);
    expect(regularizedBeta(0.4, 10, 20)).toBeCloseTo(0.785318389763, 9);
    expect(regularizedBeta(0.995, 1500, 8)).toBeCloseTo(0.519321811566, 8);
    expect(regularizedBeta(0.55, 192, 193)).toBeCloseTo(0.97814491141, 8);
    expect(regularizedBeta(0.7, 1, 1)).toBeCloseTo(0.7, 12);
  });

  it('matches SciPy coverage values, including where the old thresholds fell short', () => {
    expect(orderStatisticCoverage(1707, 0.99, 0.005)).toBeCloseTo(0.950157, 5);
    expect(orderStatisticCoverage(1706, 0.99, 0.005)).toBeCloseTo(0.949899, 5);
    expect(orderStatisticCoverage(1522, 0.99, 0.005)).toBeCloseTo(0.940492, 5); // normal-approx threshold: < 95 %
    expect(orderStatisticCoverage(500, 0.99, 0.005)).toBeCloseTo(0.719026, 5); // original "5 tail samples" rule
    expect(orderStatisticCoverage(383, 0.5, 0.05)).toBeCloseTo(0.950382, 5);
    expect(orderStatisticCoverage(484, 0.95, 0.02)).toBeCloseTo(0.950882, 5);
  });

  it.each(Object.entries(ADEQUATE_SAMPLES))(
    '%s threshold %s is the smallest n from which coverage stays >= 95% (checked to n = 20,000)',
    (name, n0) => {
      const q = PERCENTILES[name as keyof typeof PERCENTILES];
      const delta = RANK_TOLERANCE[name as keyof typeof RANK_TOLERANCE];
      expect(orderStatisticCoverage(n0 - 1, q, delta)).toBeLessThan(COVERAGE_TARGET);
      let worst = 1;
      for (let n = n0; n <= 20_000; n++)
        worst = Math.min(worst, orderStatisticCoverage(n, q, delta));
      expect(worst).toBeGreaterThanOrEqual(COVERAGE_TARGET);
    },
  );

  it('rejects the earlier p95 threshold: coverage dips below 95 % between 457 and 483', () => {
    const dips = Array.from({ length: 27 }, (_, i) => 457 + i).filter(
      (n) => orderStatisticCoverage(n, 0.95, 0.02) < COVERAGE_TARGET,
    );
    expect(dips.length).toBeGreaterThan(0);
  });

  it('agrees with a Monte Carlo sanity check at the p99 threshold', () => {
    const random = rng(2024);
    let hits = 0;
    const trials = 800;
    for (let t = 0; t < trials; t++) {
      const values = Array.from({ length: ADEQUATE_SAMPLES.p99 }, () => random()).sort(
        (a, b) => a - b,
      );
      const estimate = nearestRank(values, 0.99) ?? -1;
      if (estimate >= 0.985 && estimate <= 0.995) hits++;
    }
    // Exact coverage is 95.02 %; allow ~2.5 standard errors of simulation noise.
    expect(hits / trials).toBeGreaterThan(0.93);
  });
});

describe('confidence labels (ADR-0038, second review)', () => {
  const at = (n: number, scope: 'bucket' | 'window', effective = n) =>
    percentile({
      value: 1,
      observations: n,
      samples: n,
      effectiveSamples: effective,
      exact: true,
      q: 0.99,
      threshold: ADEQUATE_SAMPLES.p99,
      scope,
    }).confidence;

  it('labels a bucket adequate only from the exact threshold', () => {
    expect(at(1706, 'bucket')).toBe('low');
    expect(at(1707, 'bucket')).toBe('adequate');
  });

  it('never labels a window merge adequate: at most approximate', () => {
    expect(at(1706, 'window')).toBe('low');
    expect(at(1707, 'window')).toBe('approximate');
    expect(at(100_000, 'window')).toBe('approximate');
  });

  it('uses the effective samples, not the raw count, for windows', () => {
    expect(at(5000, 'window', 1000)).toBe('low');
  });

  it('reports none (null value) without observations', () => {
    expect(
      percentile({
        value: undefined,
        observations: 0,
        samples: 0,
        effectiveSamples: 0,
        exact: true,
        q: 0.99,
        threshold: 1707,
        scope: 'bucket',
      }),
    ).toEqual({
      value: null,
      method: 'exact',
      observations: 0,
      samples: 0,
      effectiveSamples: 0,
      tailSamples: 0,
      confidence: 'none',
    });
  });
});

describe('stratified (Woodruff) effective samples (ADR-0038, second review)', () => {
  it('equals the plain count for homogeneous buckets', () => {
    // Two equal buckets, 1,000 samples each, both with 99 % at or below the estimate.
    const n = stratifiedEffectiveSamples(
      [
        { share: 0.5, samples: 1000, atOrBelow: 990 },
        { share: 0.5, samples: 1000, atOrBelow: 990 },
      ],
      0.99,
    );
    expect(n).toBeCloseTo(2000, 6);
  });

  it('is Infinity when every bucket is pure (all below or all above), so Kish must bound it', () => {
    expect(
      stratifiedEffectiveSamples(
        [
          { share: 0.9, samples: 512, atOrBelow: 512 },
          { share: 0.1, samples: 512, atOrBelow: 0 },
        ],
        0.99,
      ),
    ).toBe(Infinity);
  });

  it('catches heterogeneity that Kish misses: the tail lives in an under-sampled bucket', () => {
    // 20 % of traffic in a slow bucket sampled at 200 (95 % below the estimate), 80 % in a fast bucket of
    // 3,800 samples (all below). Kish sees 2,714 samples; the stratified variance gives ~1,042.
    const kish = effectiveSampleSize([
      ...Array.from({ length: 200 }, () => 0.2 / 200),
      ...Array.from({ length: 3800 }, () => 0.8 / 3800),
    ]);
    const woodruff = stratifiedEffectiveSamples(
      [
        { share: 0.2, samples: 200, atOrBelow: 190 },
        { share: 0.8, samples: 3800, atOrBelow: 3800 },
      ],
      0.99,
    );
    expect(Math.round(kish)).toBe(2714);
    expect(Math.round(woodruff)).toBe(1042);
    expect(Math.min(kish, woodruff)).toBeLessThan(ADEQUATE_SAMPLES.p99);
  });
});

function counters(overrides: Partial<RouteCounters> = {}): RouteCounters {
  return {
    requests: 0,
    aborted: 0,
    status: { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
    codes: {},
    rl: { allowed: 0, rejected: 0, degraded: 0 },
    rlUnavailable: 0,
    cache: { hit: 0, miss: 0, bypass: 0 },
    store: { stored: 0, notStorable: 0, tooLarge: 0 },
    attempts: { success: 0, failure: 0, aborted: 0 },
    retries: 0,
    ...overrides,
  };
}

describe('rate formulas (plan §2.3)', () => {
  it('returns null for every rate without a denominator', () => {
    const rates = routeRates(counters(), 0);
    expect(Object.values(rates).every((value) => value === null)).toBe(true);
  });

  it('computes each rate from its defined numerator and denominator', () => {
    const rates = routeRates(
      counters({
        requests: 20,
        aborted: 5,
        status: { '1xx': 0, '2xx': 12, '3xx': 2, '4xx': 4, '5xx': 2 },
        rl: { allowed: 15, rejected: 3, degraded: 1 },
        rlUnavailable: 2,
        cache: { hit: 6, miss: 2, bypass: 4 },
        store: { stored: 1, notStorable: 1, tooLarge: 0 },
        attempts: { success: 9, failure: 3, aborted: 2 },
        retries: 4,
      }),
      4000,
    );
    expect(rates).toEqual({
      rps: 5,
      successRate: 14 / 20,
      clientErrorRate: 4 / 20,
      errorRate: 2 / 20,
      abortRate: 5 / 25,
      rateLimitRejectionRate: 3 / 18,
      rateLimiterUnavailableRate: 2 / 20,
      cacheHitRatio: 6 / 8, // bypasses excluded
      cacheBypassRate: 4 / 12,
      cacheStoreRate: 1 / 2,
      upstreamFailureRate: 3 / 12, // aborted attempts are neutral
      retryRate: 4 / 10, // retries ÷ first attempts (14 − 4)
    });
  });

  it('keeps cache bypasses out of the hit ratio', () => {
    expect(
      routeRates(counters({ cache: { hit: 1, miss: 1, bypass: 1000 } }), 1000).cacheHitRatio,
    ).toBe(0.5);
  });

  it('computes upstream rates per attempt', () => {
    expect(
      upstreamRates({ attempts: { success: 6, failure: 2, aborted: 2 }, retries: 1 }, 2000),
    ).toEqual({
      attemptsPerSecond: 5,
      upstreamFailureRate: 0.25,
    });
  });
});

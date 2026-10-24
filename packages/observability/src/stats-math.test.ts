import { describe, expect, it } from 'vitest';
import {
  effectiveSampleSize,
  nearestRank,
  percentile,
  routeRates,
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

describe('percentile confidence (plan §2.1)', () => {
  const cases: [number, number][] = [
    [0.5, 10],
    [0.95, 100],
    [0.99, 500],
  ];
  it.each(cases)('q=%s needs %s samples for "ok"', (q, n) => {
    const at = (samples: number) =>
      percentile({ value: 1, observations: samples, samples, exact: true, q }).confidence;
    expect(at(n - 1)).toBe('low');
    expect(at(n)).toBe('ok');
  });

  it('reports none (null value) without observations and carries counts and method', () => {
    expect(
      percentile({ value: undefined, observations: 0, samples: 0, exact: true, q: 0.99 }),
    ).toEqual({
      value: null,
      method: 'exact',
      observations: 0,
      samples: 0,
      tailSamples: 0,
      confidence: 'none',
    });
    expect(
      percentile({ value: 12, observations: 5000, samples: 512, exact: false, q: 0.99 }),
    ).toEqual({
      value: 12,
      method: 'sampled',
      observations: 5000,
      samples: 512,
      tailSamples: 5,
      confidence: 'ok',
    });
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

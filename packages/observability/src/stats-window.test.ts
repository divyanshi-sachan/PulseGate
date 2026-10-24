import { statsResponseSchema, upstreamSeriesSchema } from '@pulsegate/admin-contract';
import { describe, expect, it } from 'vitest';
import {
  ROUTE_SERIES_BYTES,
  StatsWindow,
  statsWindowBound,
  UPSTREAM_SERIES_BYTES,
} from './index.ts';

const T0 = 1_800_000_000_000; // aligned to a 10 s boundary

function setup(startOffsetMs = 0) {
  let now = T0 + startOffsetMs;
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const window = new StatsWindow({
    routes: ['orders', 'pay'],
    upstreams: ['up'],
    now: () => now,
    random,
  });
  return {
    window,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const ok = (window: StatsWindow, routeId: string | undefined, latencyMs = 10, statusCode = 200) => {
  window.recordRequest({ routeId, statusCode, code: undefined, latencyMs });
};

describe('StatsWindow buckets (plan §2, §2.4)', () => {
  it('starts with just the current bucket, empty, with null rates and no percentiles', () => {
    const { window } = setup(3000);
    const series = window.routeSeries('orders');
    expect(series?.buckets).toHaveLength(1);
    expect(series?.buckets[0]).toMatchObject({ start: T0, durationMs: 0, partial: true });
    expect(series?.window.rates.rps).toBeNull();
    expect(series?.window.latency.p50.confidence).toBe('none');
    expect(window.envelope().window.collectingSince).toBe(T0 + 3000);
  });

  it('omits time before the process started and counts real covered durations', () => {
    const { window, advance } = setup(4000); // started 4 s into the first bucket
    advance(21_000); // now = T0 + 25 s
    const buckets = window.routeSeries('orders')?.buckets ?? [];
    expect(buckets.map((b) => [b.start - T0, b.durationMs, b.partial])).toEqual([
      [0, 6000, false],
      [10_000, 10_000, false],
      [20_000, 5000, true],
    ]);
    expect(window.routeSeries('orders')?.window).toMatchObject({
      durationMs: 21_000,
      partial: true,
    });
  });

  it('reports quiet intervals as explicit empty buckets, never interpolated', () => {
    const { window, advance } = setup();
    ok(window, 'orders');
    advance(30_000);
    ok(window, 'orders');
    const buckets = window.routeSeries('orders')?.buckets ?? [];
    expect(buckets.map((b) => b.counters.requests)).toEqual([1, 0, 0, 1]);
    expect(buckets[1]?.rates.successRate).toBeNull();
    expect(buckets[1]?.latency.p50.value).toBeNull();
  });

  it('rolls over after five minutes without leaking counts from reused slots', () => {
    const { window, advance } = setup();
    for (let i = 0; i < 7; i++) ok(window, 'orders');
    advance(300_000); // same ring slot, 30 buckets later
    ok(window, 'orders');
    const series = window.routeSeries('orders');
    expect(series?.buckets).toHaveLength(30);
    expect(series?.window.counters.requests).toBe(1);
    expect(series?.window).toMatchObject({ durationMs: 290_000 + 0, partial: true });
  });

  it('divides rps by the real covered time, including a partial bucket', () => {
    const { window, advance } = setup();
    for (let i = 0; i < 30; i++) ok(window, 'orders');
    advance(15_000);
    expect(window.routeSeries('orders')?.window.rates.rps).toBe(2);
  });

  it('feeds the total from every route, and unknown routes into unmatched', () => {
    const { window } = setup();
    ok(window, 'orders');
    ok(window, 'pay', 10, 503);
    ok(window, 'nope', 10, 404);
    ok(window, undefined, 10, 404);
    expect(window.totalSeries().window.counters.requests).toBe(4);
    expect(window.unmatchedSeries().window.counters.requests).toBe(2);
    expect(window.totalSeries().window.counters.status).toEqual({
      '1xx': 0,
      '2xx': 1,
      '3xx': 0,
      '4xx': 2,
      '5xx': 1,
    });
  });

  it('maps unknown error codes to "other"', () => {
    const { window } = setup();
    window.recordRequest({ routeId: 'orders', statusCode: 500, code: 'NEW_CODE', latencyMs: 1 });
    window.recordRequest({
      routeId: 'orders',
      statusCode: 429,
      code: 'RATE_LIMIT_EXCEEDED',
      latencyMs: 1,
    });
    const codes = window.routeSeries('orders')?.window.counters.codes ?? {};
    expect([codes['other'], codes['RATE_LIMIT_EXCEEDED']]).toEqual([1, 1]);
  });
});

describe('StatsWindow percentiles (plan §2.1)', () => {
  it('computes exact percentiles for small inputs', () => {
    const { window } = setup();
    for (let ms = 1; ms <= 100; ms++) ok(window, 'orders', ms);
    const { p50, p95, p99 } = window.routeSeries('orders')?.buckets[0]?.latency ?? ({} as never);
    expect([p50.value, p95.value, p99.value]).toEqual([50, 95, 99]);
    expect([p50.method, p50.observations, p50.samples]).toEqual(['exact', 100, 100]);
    expect([p50.confidence, p95.confidence, p99.confidence]).toEqual(['ok', 'ok', 'low']);
    expect(p99.tailSamples).toBe(1);
  });

  it('switches from exact to sampled after 512 observations, keeping 512 samples', () => {
    const { window } = setup();
    for (let i = 0; i < 512; i++) ok(window, 'orders', i);
    expect(window.routeSeries('orders')?.buckets[0]?.latency.p50.method).toBe('exact');
    ok(window, 'orders', 1);
    const p50 = window.routeSeries('orders')?.buckets[0]?.latency.p50;
    expect([p50?.method, p50?.observations, p50?.samples]).toEqual(['sampled', 513, 512]);
  });

  it('keeps sampling after the reservoir is full (no first-512 bias)', () => {
    const { window } = setup();
    for (let i = 0; i < 512; i++) ok(window, 'orders', 1);
    for (let i = 0; i < 20_000; i++) ok(window, 'orders', 1000);
    expect(window.routeSeries('orders')?.buckets[0]?.latency.p50.value).toBe(1000);
  });

  it('stays bounded and roughly unbiased under 100,000 observations', () => {
    const { window } = setup();
    for (let i = 0; i < 100_000; i++) ok(window, 'orders', i % 1000);
    const p50 = window.routeSeries('orders')?.buckets[0]?.latency.p50;
    expect(p50?.samples).toBe(512);
    expect(p50?.value).toBeGreaterThan(420);
    expect(p50?.value).toBeLessThan(580);
  });

  it('weights each bucket by its traffic in the window percentile', () => {
    const { window, advance } = setup();
    for (let i = 0; i < 512; i++) ok(window, 'orders', 10); // quiet bucket, exact
    advance(10_000);
    for (let i = 0; i < 5120; i++) ok(window, 'orders', 1000); // busy bucket, sampled
    const latency = window.routeSeries('orders')?.window.latency;
    // Unweighted, the 512 + 512 samples would put p50 at 10; weighted by traffic it is 1000.
    expect(latency?.p50.value).toBe(1000);
    expect(latency?.p50.method).toBe('sampled');
    expect(latency?.p50.observations).toBe(5632);
    // Effective sample size (512 + 5120)² / (512·1² + 512·10²) ≈ 613.
    expect(latency?.p50.samples).toBe(613);
    expect(latency?.p99.tailSamples).toBe(6);
    expect(latency?.p99.confidence).toBe('ok');
  });
});

describe('StatsWindow counters (plan §2.3)', () => {
  it('records attempts on the route and the upstream, with failure rate per attempt', () => {
    const { window } = setup();
    for (const outcome of ['success', 'success', 'failure', 'aborted'] as const) {
      window.recordAttempt({ routeId: 'orders', upstreamId: 'up', outcome, latencyMs: 20 });
    }
    window.recordRetries('orders', 'up', 1);
    const upstream = window.upstreamSeries('up');
    expect(upstream?.window.counters).toEqual({
      attempts: { success: 2, failure: 1, aborted: 1 },
      retries: 1,
    });
    expect(upstream?.window.rates.upstreamFailureRate).toBeCloseTo(1 / 3);
    expect(upstream?.window.latency.p50.value).toBe(20);
    expect(window.routeSeries('orders')?.window.rates.upstreamFailureRate).toBeCloseTo(1 / 3);
  });

  it('counts aborts without a status or latency, and cache and limiter outcomes', () => {
    const { window } = setup();
    window.recordAborted('orders');
    window.recordRateLimit('orders', true, false);
    window.recordRateLimit('orders', false, true);
    window.recordLimiterUnavailable('orders');
    window.recordCacheLookup('orders', 'hit');
    window.recordCacheLookup('orders', 'miss');
    window.recordCacheLookup('orders', 'bypass');
    window.recordCacheStore('orders', 'stored');
    const c = window.routeSeries('orders')?.window.counters;
    expect(c).toMatchObject({
      requests: 0,
      aborted: 1,
      rl: { allowed: 1, rejected: 1, degraded: 1 },
      rlUnavailable: 1,
      cache: { hit: 1, miss: 1, bypass: 1 },
      store: { stored: 1, notStorable: 0, tooLarge: 0 },
    });
    expect(c?.codes['CLIENT_ABORTED']).toBe(1);
    expect(window.routeSeries('orders')?.window.latency.p50.confidence).toBe('none');
  });
});

describe('StatsWindow memory and contracts (plan §2.2, §5.1)', () => {
  it('allocates exactly the documented typed-array payload', () => {
    expect(ROUTE_SERIES_BYTES).toBe(66_180);
    expect(UPSTREAM_SERIES_BYTES).toBe(62_340);
    expect(new StatsWindow({ routes: ['a', 'b'], upstreams: ['u'] }).payloadBytes()).toBe(
      statsWindowBound(2, 1),
    );
    expect(statsWindowBound(50, 20)).toBe(52 * 66_180 + 20 * 62_340);
  });

  it('produces snapshots that satisfy the shared contract', () => {
    const { window, advance } = setup();
    ok(window, 'orders');
    window.recordAttempt({ routeId: 'orders', upstreamId: 'up', outcome: 'success', latencyMs: 5 });
    advance(12_000);
    ok(window, 'pay', 30, 502);
    const stats = {
      ...window.envelope(),
      total: window.totalSeries(),
      routes: ['orders', 'pay'].map((id) => ({ id, series: window.routeSeries(id) })),
    };
    expect(statsResponseSchema.safeParse(stats).success).toBe(true);
    expect(upstreamSeriesSchema.safeParse(window.upstreamSeries('up')).success).toBe(true);
  });
});

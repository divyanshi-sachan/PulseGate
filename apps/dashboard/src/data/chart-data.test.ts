import { describe, expect, it } from 'vitest';
import { statsOf, trafficWindow } from '../test/fixtures.ts';
import {
  cacheHitPoints,
  isQuiet,
  latencyPoints,
  rejectionPoints,
  routeErrorPoints,
  routeRps,
  sortRows,
  sparklinePath,
  valuePoints,
} from './chart-data.ts';

/** Three buckets: traffic, a quiet one, then a partial one with traffic. */
function threeBuckets() {
  const t = trafficWindow();
  t.request('orders', 200, 10);
  t.request('orders', 503, 30);
  t.window.recordCacheLookup('orders', 'hit');
  t.window.recordCacheLookup('orders', 'miss');
  t.window.recordCacheLookup('orders', 'bypass');
  t.window.recordRateLimit('orders', true, false);
  t.window.recordRateLimit('orders', false, false);
  t.advance(20_000);
  t.request('orders', 200, 20);
  t.advance(2_500);
  const orders = statsOf(t.window).routes.find((r) => r.id === 'orders');
  if (orders === undefined) throw new Error('missing');
  return orders.series;
}

describe('chart-data (plan §4)', () => {
  it('keeps empty buckets as gaps, never zeros', () => {
    const points = latencyPoints(threeBuckets().buckets);
    expect(points).toHaveLength(3);
    expect(points[1]).toMatchObject({ p50: null, p95: null, p99: null });
    expect(points[0]?.['p50']).toBe(10);
    expect(points[0]?.['p99']).toBe(30);
  });

  it('notes the partial bucket with its real duration', () => {
    const points = latencyPoints(threeBuckets().buckets);
    expect(points[2]?.notes[0]).toBe('In progress: 2.5 s so far');
    expect(points[0]?.notes.some((n) => n.startsWith('In progress'))).toBe(false);
  });

  it('notes low-confidence percentiles with their sample count, but still draws them', () => {
    const [first] = latencyPoints(threeBuckets().buckets);
    expect(first?.notes).toEqual([
      '2 requests measured',
      'p50 low confidence (n=2)',
      'p95 low confidence (n=2)',
      'p99 low confidence (n=2)',
    ]);
  });

  it('handles a single bucket', () => {
    const t = trafficWindow();
    t.request('orders', 200, 5);
    const series = statsOf(t.window).total;
    expect(series.buckets).toHaveLength(1);
    expect(latencyPoints(series.buckets)).toHaveLength(1);
    expect(routeRps(series.buckets)[0]?.notes).toEqual([
      'In progress: 0.0 s so far',
      'of 1 requests',
    ]);
  });

  it('converts ratios to percent points and keeps null as null', () => {
    const buckets = threeBuckets().buckets;
    const errors = routeErrorPoints(buckets);
    expect(errors[0]).toMatchObject({ server: 50, client: 0 });
    expect(errors[1]).toMatchObject({ server: null, client: null });
    const hits = cacheHitPoints(buckets);
    // 1 hit of 2 lookups: the bypass is not a lookup.
    expect(hits[0]?.['hitRatio']).toBe(50);
    expect(hits[0]?.notes).toContain('of 2 lookups (bypasses excluded)');
    expect(rejectionPoints(buckets)[0]?.['rejectionRate']).toBe(50);
  });

  it('keeps req/s unconverted and names the denominator', () => {
    const points = valuePoints(threeBuckets().buckets, 'rps', (b) => b.rates.rps, {
      unit: 'req/s',
      denominator: (b) => b.counters.requests,
    });
    expect(points[0]?.['rps']).toBeCloseTo(2 / 10, 12);
    expect(points[0]?.notes).toEqual(['of 2 requests']);
  });

  it('detects a quiet window', () => {
    expect(isQuiet(statsOf(trafficWindow().window).total)).toBe(true);
    expect(isQuiet({ ...statsOf(trafficWindow().window).total })).toBe(true);
    const t = trafficWindow();
    t.window.recordAborted('orders');
    expect(isQuiet(statsOf(t.window).total)).toBe(false);
  });
});

describe('sparkline path', () => {
  it('draws a line scaled from 0 to the maximum', () => {
    expect(sparklinePath([0, 5, 10], 100, 20)).toBe('M0 20L50 10L100 0');
  });

  it('breaks the line at gaps and marks a lone point with a short tick', () => {
    expect(sparklinePath([1, 1, null, 1, null], 100, 20)).toBe('M0 0L25 0M68.75 0h12.5');
  });

  it('draws nothing without values and a flat baseline for all zeros', () => {
    expect(sparklinePath([], 100, 20)).toBe('');
    expect(sparklinePath([null, null], 100, 20)).toBe('');
    expect(sparklinePath([0, 0], 100, 20)).toBe('M0 20L100 20');
  });
});

describe('sorting', () => {
  const rows = [
    { id: 'b', v: 2 as number | null },
    { id: 'a', v: null },
    { id: 'c', v: 5 },
  ];

  it('sorts numbers both ways with nulls always last', () => {
    expect(sortRows(rows, (r) => r.v, 'descending').map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(sortRows(rows, (r) => r.v, 'ascending').map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts text', () => {
    expect(sortRows(rows, (r) => r.id, 'ascending').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

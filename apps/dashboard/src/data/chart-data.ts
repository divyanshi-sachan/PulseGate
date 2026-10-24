import type { Latency, Percentile, RouteSeries, UpstreamSeries } from '@pulsegate/admin-contract';
import { formatCount } from './format.ts';

/**
 * Turns API time series into chart points (plan §4). Pure and unit-tested: presentation components never compute
 * anything themselves. Missing values stay `null`, so charts draw gaps instead of inventing zeros.
 */

export type Unit = 'ms' | 'req/s' | '%' | 'count';

/** Fields every bucket slice carries (route and upstream series alike). */
export interface SliceBase {
  start: number;
  durationMs: number;
  partial: boolean;
  latency: Latency;
}

/** One chart point: `t` is the bucket start (epoch ms); series values live under their keys. */
export interface ChartPoint {
  t: number;
  /** Human-readable caveats shown in the tooltip and the table (partial bucket, low confidence, sample size). */
  notes: string[];
  [series: string]: number | null | string[];
}

export interface SeriesDef {
  key: string;
  label: string;
  /** CSS class carrying the colour and dash pattern (charts.css), never a hard-coded colour. */
  className: string;
}

function baseNotes(slice: SliceBase): string[] {
  return slice.partial ? [`In progress: ${(slice.durationMs / 1000).toFixed(1)} s so far`] : [];
}

export const LATENCY_SERIES: readonly SeriesDef[] = [
  { key: 'p50', label: 'p50', className: 'pg-series--p50' },
  { key: 'p95', label: 'p95', className: 'pg-series--p95' },
  { key: 'p99', label: 'p99', className: 'pg-series--p99' },
];

function percentileNote(name: string, p: Percentile): string | undefined {
  if (p.value === null || p.confidence === 'adequate' || p.confidence === 'approximate') {
    return undefined;
  }
  return `${name} low confidence (n=${formatCount(p.effectiveSamples)})`;
}

/** p50/p95/p99 per bucket in ms; empty buckets are gaps; low-confidence percentiles are noted, still drawn. */
export function latencyPoints(slices: readonly SliceBase[]): ChartPoint[] {
  return slices.map((slice) => {
    const { p50, p95, p99 } = slice.latency;
    const notes = baseNotes(slice);
    if (p50.observations > 0) notes.push(`${formatCount(p50.observations)} requests measured`);
    for (const [name, p] of [
      ['p50', p50],
      ['p95', p95],
      ['p99', p99],
    ] as const) {
      const note = percentileNote(name, p);
      if (note !== undefined) notes.push(note);
    }
    return { t: slice.start, notes, p50: p50.value, p95: p95.value, p99: p99.value };
  });
}

/**
 * One value per bucket. Ratios (0..1) become percentages for the `%` unit. `denominator` gives the count behind each
 * point for the tooltip, e.g. "of 12 lookups"; a null value (no denominator) is a gap.
 */
export function valuePoints<S extends SliceBase>(
  slices: readonly S[],
  key: string,
  pick: (slice: S) => number | null,
  options: { unit: Unit; denominator?: (slice: S) => number; denominatorLabel?: string },
): ChartPoint[] {
  return slices.map((slice) => {
    const raw = pick(slice);
    const value = raw === null ? null : options.unit === '%' ? raw * 100 : raw;
    const notes = baseNotes(slice);
    if (options.denominator !== undefined) {
      const n = options.denominator(slice);
      notes.push(`of ${formatCount(n)} ${options.denominatorLabel ?? 'requests'}`);
    }
    return { t: slice.start, notes, [key]: value };
  });
}

type RouteSlice = RouteSeries['window'];
type UpstreamSlice = UpstreamSeries['window'];

export const routeRps = (s: readonly RouteSlice[]) =>
  valuePoints(s, 'rps', (b) => b.rates.rps, {
    unit: 'req/s',
    denominator: (b) => b.counters.requests,
  });

/** 5xx and 4xx shares of completed requests, as two series on one chart. */
export function routeErrorPoints(slices: readonly RouteSlice[]): ChartPoint[] {
  return slices.map((slice) => {
    const toPercent = (r: number | null) => (r === null ? null : r * 100);
    return {
      t: slice.start,
      notes: [...baseNotes(slice), `of ${formatCount(slice.counters.requests)} requests`],
      server: toPercent(slice.rates.errorRate),
      client: toPercent(slice.rates.clientErrorRate),
    };
  });
}

export const ERROR_SERIES: readonly SeriesDef[] = [
  { key: 'server', label: '5xx', className: 'pg-series--danger' },
  { key: 'client', label: '4xx', className: 'pg-series--warning' },
];

export const cacheHitPoints = (s: readonly RouteSlice[]) =>
  valuePoints(s, 'hitRatio', (b) => b.rates.cacheHitRatio, {
    unit: '%',
    denominator: (b) => b.counters.cache.hit + b.counters.cache.miss,
    denominatorLabel: 'lookups (bypasses excluded)',
  });

export const rejectionPoints = (s: readonly RouteSlice[]) =>
  valuePoints(s, 'rejectionRate', (b) => b.rates.rateLimitRejectionRate, {
    unit: '%',
    denominator: (b) => b.counters.rl.allowed + b.counters.rl.rejected,
    denominatorLabel: 'limiter decisions',
  });

export const upstreamFailurePoints = (s: readonly UpstreamSlice[]) =>
  valuePoints(s, 'failureRate', (b) => b.rates.upstreamFailureRate, {
    unit: '%',
    denominator: (b) => b.counters.attempts.success + b.counters.attempts.failure,
    denominatorLabel: 'decided attempts',
  });

/** Nothing happened in the window: show the empty state instead of flat charts. */
export function isQuiet(series: RouteSeries): boolean {
  return series.window.counters.requests === 0 && series.window.counters.aborted === 0;
}

/**
 * SVG path for a sparkline in a `width` × `height` box. `null` values break the line (gaps); a lone point between
 * gaps becomes a short horizontal tick so it stays visible. The scale starts at 0.
 */
export function sparklinePath(
  values: readonly (number | null)[],
  width: number,
  height: number,
): string {
  if (values.length === 0) return '';
  const max = Math.max(0, ...values.filter((v): v is number => v !== null));
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const y = (v: number) => (max === 0 ? height : height - (v / max) * height);
  const round = (n: number) => Math.round(n * 100) / 100;
  const parts: string[] = [];
  let run: [number, number][] = [];
  const flush = () => {
    const [first] = run;
    if (first === undefined) return;
    if (run.length === 1) {
      const half = Math.max(1, step / 4);
      parts.push(
        `M${String(round(first[0] - half))} ${String(round(first[1]))}h${String(round(half * 2))}`,
      );
    } else {
      parts.push(
        run
          .map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${String(round(px))} ${String(round(py))}`)
          .join(''),
      );
    }
    run = [];
  };
  values.forEach((v, i) => {
    if (v === null) flush();
    else run.push([i * step, y(v)]);
  });
  flush();
  return parts.join('');
}

export type SortDirection = 'ascending' | 'descending';

/** Sorts rows by a numeric or text column; nulls always last, whatever the direction. */
export function sortRows<T>(
  rows: readonly T[],
  value: (row: T) => number | string | null,
  direction: SortDirection,
): T[] {
  const sign = direction === 'ascending' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x === 'string' || typeof y === 'string')
      return sign * String(x).localeCompare(String(y));
    return sign * (x - y);
  });
}

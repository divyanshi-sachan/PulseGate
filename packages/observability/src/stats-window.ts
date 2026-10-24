import {
  BUCKET_COUNT,
  BUCKET_SECONDS,
  COUNTED_CODES,
  PERCENTILES,
  RESERVOIR_SIZE,
  WINDOW_SECONDS,
  type Envelope,
  type Latency,
  type RouteCounters,
  type RouteSeries,
  type UpstreamCounters,
  type UpstreamSeries,
} from '@pulsegate/admin-contract';
import {
  effectiveSampleSize,
  nearestRank,
  percentile,
  routeRates,
  upstreamRates,
  weightedQuantile,
  type WeightedSample,
} from './stats-math.ts';

const BUCKET_MS = BUCKET_SECONDS * 1000;
const WINDOW_MS = WINDOW_SECONDS * 1000;

/** Route counter layout: 36 slots per bucket (plan §2.3). */
const ROUTE_COUNTERS = [
  'requests',
  'aborted',
  's1xx',
  's2xx',
  's3xx',
  's4xx',
  's5xx',
  ...COUNTED_CODES.map((code) => `code:${code}`),
  'rlAllowed',
  'rlRejected',
  'rlDegraded',
  'rlUnavailable',
  'cacheHit',
  'cacheMiss',
  'cacheBypass',
  'storeStored',
  'storeNotStorable',
  'storeTooLarge',
  'attSuccess',
  'attFailure',
  'attAborted',
  'retries',
] as const;
const UPSTREAM_COUNTERS = ['attSuccess', 'attFailure', 'attAborted', 'retries'] as const;

function indexOf(names: readonly string[]): Map<string, number> {
  return new Map(names.map((name, i) => [name, i]));
}
const ROUTE_INDEX = indexOf(ROUTE_COUNTERS);
const UPSTREAM_INDEX = indexOf(UPSTREAM_COUNTERS);

/**
 * One fixed-size series: 30 bucket slots, each with counters and a 512-sample latency reservoir
 * (Algorithm R). All storage is preallocated typed arrays; nothing grows with traffic (plan §2.2).
 */
class Series {
  readonly samples = new Float32Array(BUCKET_COUNT * RESERVOIR_SIZE);
  readonly sampleCount = new Uint16Array(BUCKET_COUNT);
  readonly observations = new Uint32Array(BUCKET_COUNT);
  readonly starts = new Float64Array(BUCKET_COUNT).fill(-1);
  readonly counters: Uint32Array;
  readonly width: number;

  constructor(width: number) {
    this.width = width;
    this.counters = new Uint32Array(BUCKET_COUNT * width);
  }

  /** The slot for `bucketStart`, reset first if it still holds an older bucket. */
  slot(bucketStart: number): number {
    const index = Math.floor(bucketStart / BUCKET_MS) % BUCKET_COUNT;
    if (this.starts[index] !== bucketStart) {
      this.starts[index] = bucketStart;
      this.counters.fill(0, index * this.width, (index + 1) * this.width);
      this.observations[index] = 0;
      this.sampleCount[index] = 0;
    }
    return index;
  }

  add(bucketStart: number, counter: number, amount = 1): void {
    const index = this.slot(bucketStart);
    const at = index * this.width + counter;
    this.counters[at] = (this.counters[at] ?? 0) + amount;
  }

  addLatency(bucketStart: number, ms: number, random: () => number): void {
    const index = this.slot(bucketStart);
    const seen = (this.observations[index] ?? 0) + 1;
    this.observations[index] = seen;
    const held = this.sampleCount[index] ?? 0;
    const base = index * RESERVOIR_SIZE;
    if (held < RESERVOIR_SIZE) {
      this.samples[base + held] = ms;
      this.sampleCount[index] = held + 1;
      return;
    }
    // Algorithm R: keep the new value with probability RESERVOIR_SIZE / seen.
    const j = Math.floor(random() * seen);
    if (j < RESERVOIR_SIZE) this.samples[base + j] = ms;
  }

  /** Counter value in a slot, or 0 if the slot holds a different bucket. */
  read(index: number | undefined, counter: number): number {
    if (index === undefined) return 0;
    return this.counters[index * this.width + counter] ?? 0;
  }

  /** Index of the slot holding `bucketStart`, if it holds that bucket. */
  find(bucketStart: number): number | undefined {
    const index = Math.floor(bucketStart / BUCKET_MS) % BUCKET_COUNT;
    return this.starts[index] === bucketStart ? index : undefined;
  }

  bucketSamples(index: number | undefined): Float32Array {
    if (index === undefined) return new Float32Array(0);
    const base = index * RESERVOIR_SIZE;
    return this.samples.subarray(base, base + (this.sampleCount[index] ?? 0));
  }

  payloadBytes(): number {
    return (
      this.samples.byteLength +
      this.sampleCount.byteLength +
      this.observations.byteLength +
      this.starts.byteLength +
      this.counters.byteLength
    );
  }
}

export interface StatsWindowOptions {
  routes: readonly string[];
  upstreams: readonly string[];
  /** Wall-clock milliseconds; buckets align to it so charts get real timestamps (default Date.now). */
  now?: () => number;
  /** Reservoir randomness (default Math.random); deterministic in tests. */
  random?: () => number;
  instanceId?: string;
}

export interface RequestRecord {
  routeId: string | undefined;
  statusCode: number;
  code: string | undefined;
  latencyMs: number;
}

/** Bytes of typed-array payload per series, for the documented bound (plan §2.2). */
export const ROUTE_SERIES_BYTES = new Series(ROUTE_COUNTERS.length).payloadBytes();
export const UPSTREAM_SERIES_BYTES = new Series(UPSTREAM_COUNTERS.length).payloadBytes();

/** The memory bound from plan §2.2: (R + 2) route-sized series (+unmatched, +total) and U upstream series. */
export function statsWindowBound(routes: number, upstreams: number): number {
  return (routes + 2) * ROUTE_SERIES_BYTES + upstreams * UPSTREAM_SERIES_BYTES;
}

/**
 * Rolling 5-minute statistics for the admin API (ADR-0037, plan §2): 30 × 10 s buckets per route,
 * total and upstream, with measured percentiles and the rate formulas of plan §2.3.
 */
export class StatsWindow {
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #startedAt: number;
  readonly #instanceId: string;
  readonly #routes = new Map<string, Series>();
  readonly #upstreams = new Map<string, Series>();
  readonly #unmatched = new Series(ROUTE_COUNTERS.length);
  readonly #total = new Series(ROUTE_COUNTERS.length);

  constructor(options: StatsWindowOptions) {
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#startedAt = this.#now();
    this.#instanceId = options.instanceId ?? `gw_${this.#startedAt.toString(36)}`;
    for (const id of options.routes) this.#routes.set(id, new Series(ROUTE_COUNTERS.length));
    for (const id of options.upstreams)
      this.#upstreams.set(id, new Series(UPSTREAM_COUNTERS.length));
  }

  get startedAt(): number {
    return this.#startedAt;
  }

  /** Typed-array bytes actually allocated; equals statsWindowBound() for the configured series. */
  payloadBytes(): number {
    let bytes = this.#unmatched.payloadBytes() + this.#total.payloadBytes();
    for (const series of this.#routes.values()) bytes += series.payloadBytes();
    for (const series of this.#upstreams.values()) bytes += series.payloadBytes();
    return bytes;
  }

  #bucketStart(): number {
    return Math.floor(this.#now() / BUCKET_MS) * BUCKET_MS;
  }

  #routeSeries(routeId: string | undefined): Series {
    return (routeId === undefined ? undefined : this.#routes.get(routeId)) ?? this.#unmatched;
  }

  /** Adds to a route counter on the route (or unmatched) series and on the total. */
  #countRoute(routeId: string | undefined, name: string, amount = 1): void {
    const counter = ROUTE_INDEX.get(name);
    if (counter === undefined) return;
    const start = this.#bucketStart();
    this.#routeSeries(routeId).add(start, counter, amount);
    this.#total.add(start, counter, amount);
  }

  // ---- recording (fed from the same hook points as GatewayMetrics) ----

  recordRequest(record: RequestRecord): void {
    const klass = Math.floor(record.statusCode / 100);
    const code = record.code ?? 'none';
    this.#countRoute(record.routeId, 'requests');
    if (klass >= 1 && klass <= 5) this.#countRoute(record.routeId, `s${String(klass)}xx`);
    if (code !== 'none') {
      this.#countRoute(
        record.routeId,
        ROUTE_INDEX.has(`code:${code}`) ? `code:${code}` : 'code:other',
      );
    }
    const start = this.#bucketStart();
    this.#routeSeries(record.routeId).addLatency(start, record.latencyMs, this.#random);
    this.#total.addLatency(start, record.latencyMs, this.#random);
  }

  /** A client that left before the response finished: counted, but it has no status or latency. */
  recordAborted(routeId: string | undefined): void {
    this.#countRoute(routeId, 'aborted');
    this.#countRoute(routeId, 'code:CLIENT_ABORTED');
  }

  recordRateLimit(routeId: string, allowed: boolean, degraded: boolean): void {
    this.#countRoute(routeId, allowed ? 'rlAllowed' : 'rlRejected');
    if (degraded) this.#countRoute(routeId, 'rlDegraded');
  }

  recordLimiterUnavailable(routeId: string): void {
    this.#countRoute(routeId, 'rlUnavailable');
  }

  recordCacheLookup(routeId: string, result: 'hit' | 'miss' | 'bypass'): void {
    this.#countRoute(
      routeId,
      { hit: 'cacheHit', miss: 'cacheMiss', bypass: 'cacheBypass' }[result],
    );
  }

  recordCacheStore(routeId: string, result: 'stored' | 'not_storable' | 'too_large'): void {
    this.#countRoute(
      routeId,
      { stored: 'storeStored', not_storable: 'storeNotStorable', too_large: 'storeTooLarge' }[
        result
      ],
    );
  }

  recordAttempt(input: {
    routeId: string;
    upstreamId: string;
    outcome: 'success' | 'failure' | 'aborted';
    latencyMs: number;
  }): void {
    const name = { success: 'attSuccess', failure: 'attFailure', aborted: 'attAborted' }[
      input.outcome
    ];
    this.#countRoute(input.routeId, name);
    const upstream = this.#upstreams.get(input.upstreamId);
    const counter = UPSTREAM_INDEX.get(name);
    if (upstream === undefined || counter === undefined) return;
    const start = this.#bucketStart();
    upstream.add(start, counter);
    upstream.addLatency(start, input.latencyMs, this.#random);
  }

  recordRetries(routeId: string | undefined, upstreamId: string | undefined, count: number): void {
    if (count <= 0) return;
    this.#countRoute(routeId, 'retries', count);
    const upstream = upstreamId === undefined ? undefined : this.#upstreams.get(upstreamId);
    const counter = UPSTREAM_INDEX.get('retries');
    if (upstream !== undefined && counter !== undefined)
      upstream.add(this.#bucketStart(), counter, count);
  }

  // ---- reading (contract shapes, plan §2.1–§2.4) ----

  envelope(): Envelope {
    return {
      instance: { id: this.#instanceId, startedAt: this.#startedAt },
      generatedAt: this.#now(),
      window: {
        seconds: WINDOW_SECONDS,
        bucketSeconds: BUCKET_SECONDS,
        collectingSince: this.#startedAt,
      },
    };
  }

  /**
   * Bucket starts covered by the window, oldest first. Generated from the clock, so an interval with no
   * traffic still appears (as an explicit empty bucket); intervals before the process started never do.
   */
  #bucketStarts(): number[] {
    const now = this.#now();
    const current = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    const firstCollecting = Math.floor(this.#startedAt / BUCKET_MS) * BUCKET_MS;
    const oldest = Math.max(current - (BUCKET_COUNT - 1) * BUCKET_MS, firstCollecting);
    const starts: number[] = [];
    for (let start = oldest; start <= current; start += BUCKET_MS) starts.push(start);
    return starts;
  }

  #duration(start: number): number {
    const end = Math.min(start + BUCKET_MS, this.#now());
    return Math.max(0, end - Math.max(start, this.#startedAt));
  }

  routeSeries(routeId: string): RouteSeries | undefined {
    const series = this.#routes.get(routeId);
    return series === undefined ? undefined : this.#route(series);
  }

  unmatchedSeries(): RouteSeries {
    return this.#route(this.#unmatched);
  }

  totalSeries(): RouteSeries {
    return this.#route(this.#total);
  }

  upstreamSeries(upstreamId: string): UpstreamSeries | undefined {
    const series = this.#upstreams.get(upstreamId);
    if (series === undefined) return undefined;
    const starts = this.#bucketStarts();
    const buckets = starts.map((start) => {
      const index = series.find(start);
      const counters = upstreamCounters((name) =>
        series.read(index, UPSTREAM_INDEX.get(name) ?? -1),
      );
      return this.#slice(start, counters, upstreamRates(counters, this.#duration(start)), series, [
        index,
      ]);
    });
    const counters = upstreamCounters((name) =>
      starts.reduce(
        (sum, start) => sum + series.read(series.find(start), UPSTREAM_INDEX.get(name) ?? -1),
        0,
      ),
    );
    const durationMs = starts.reduce((sum, start) => sum + this.#duration(start), 0);
    const window = this.#windowSlice(starts, counters, upstreamRates(counters, durationMs), series);
    return { window, buckets };
  }

  #route(series: Series): RouteSeries {
    const starts = this.#bucketStarts();
    const buckets = starts.map((start) => {
      const index = series.find(start);
      const counters = routeCounters((name) => series.read(index, ROUTE_INDEX.get(name) ?? -1));
      return this.#slice(start, counters, routeRates(counters, this.#duration(start)), series, [
        index,
      ]);
    });
    const counters = routeCounters((name) =>
      starts.reduce(
        (sum, start) => sum + series.read(series.find(start), ROUTE_INDEX.get(name) ?? -1),
        0,
      ),
    );
    const durationMs = starts.reduce((sum, start) => sum + this.#duration(start), 0);
    const window = this.#windowSlice(starts, counters, routeRates(counters, durationMs), series);
    return { window, buckets };
  }

  #slice<C, R>(
    start: number,
    counters: C,
    rates: R,
    series: Series,
    indexes: (number | undefined)[],
  ): {
    start: number;
    durationMs: number;
    partial: boolean;
    counters: C;
    rates: R;
    latency: Latency;
  } {
    const current = Math.floor(this.#now() / BUCKET_MS) * BUCKET_MS;
    return {
      start,
      durationMs: this.#duration(start),
      partial: start === current,
      counters,
      rates,
      latency: bucketLatency(series, indexes[0]),
    };
  }

  #windowSlice<C, R>(
    starts: number[],
    counters: C,
    rates: R,
    series: Series,
  ): {
    start: number;
    durationMs: number;
    partial: boolean;
    counters: C;
    rates: R;
    latency: Latency;
  } {
    const durationMs = starts.reduce((sum, start) => sum + this.#duration(start), 0);
    return {
      start: Math.max(starts[0] ?? this.#startedAt, this.#startedAt),
      durationMs,
      // The window is partial until it covers the full five minutes.
      partial: durationMs < WINDOW_MS,
      counters,
      rates,
      latency: windowLatency(
        series,
        starts.map((start) => series.find(start)),
      ),
    };
  }
}

function routeCounters(read: (name: string) => number): RouteCounters {
  return {
    requests: read('requests'),
    aborted: read('aborted'),
    status: {
      '1xx': read('s1xx'),
      '2xx': read('s2xx'),
      '3xx': read('s3xx'),
      '4xx': read('s4xx'),
      '5xx': read('s5xx'),
    },
    codes: Object.fromEntries(COUNTED_CODES.map((code) => [code, read(`code:${code}`)])),
    rl: { allowed: read('rlAllowed'), rejected: read('rlRejected'), degraded: read('rlDegraded') },
    rlUnavailable: read('rlUnavailable'),
    cache: { hit: read('cacheHit'), miss: read('cacheMiss'), bypass: read('cacheBypass') },
    store: {
      stored: read('storeStored'),
      notStorable: read('storeNotStorable'),
      tooLarge: read('storeTooLarge'),
    },
    attempts: {
      success: read('attSuccess'),
      failure: read('attFailure'),
      aborted: read('attAborted'),
    },
    retries: read('retries'),
  };
}

function upstreamCounters(read: (name: string) => number): UpstreamCounters {
  return {
    attempts: {
      success: read('attSuccess'),
      failure: read('attFailure'),
      aborted: read('attAborted'),
    },
    retries: read('retries'),
  };
}

/** Per-bucket percentiles from that bucket's own reservoir (plan §2.1). */
function bucketLatency(series: Series, index: number | undefined): Latency {
  const observations = index === undefined ? 0 : (series.observations[index] ?? 0);
  const sorted = Array.from(series.bucketSamples(index)).sort((a, b) => a - b);
  const exact = sorted.length === observations;
  const make = (q: number) =>
    percentile({ value: nearestRank(sorted, q), observations, samples: sorted.length, exact, q });
  return { p50: make(PERCENTILES.p50), p95: make(PERCENTILES.p95), p99: make(PERCENTILES.p99) };
}

/**
 * Window percentiles: a weighted quantile over every live reservoir, each sample weighted by its
 * bucket's observations ÷ retained samples; confidence uses the effective sample size (plan §2.1).
 */
function windowLatency(series: Series, indexes: (number | undefined)[]): Latency {
  const weighted: WeightedSample[] = [];
  let observations = 0;
  let exact = true;
  for (const index of indexes) {
    if (index === undefined) continue;
    const seen = series.observations[index] ?? 0;
    const held = series.sampleCount[index] ?? 0;
    if (seen === 0 || held === 0) continue;
    observations += seen;
    if (seen !== held) exact = false;
    const weight = seen / held;
    for (const value of series.bucketSamples(index)) weighted.push({ value, weight });
  }
  const ess = effectiveSampleSize(weighted.map((s) => s.weight));
  const make = (q: number) =>
    percentile({ value: weightedQuantile(weighted, q), observations, samples: ess, exact, q });
  return { p50: make(PERCENTILES.p50), p95: make(PERCENTILES.p95), p99: make(PERCENTILES.p99) };
}

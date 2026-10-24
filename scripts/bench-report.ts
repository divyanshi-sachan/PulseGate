/**
 * Benchmark report generator (docs/plans/real-data-testing.md §3, §3a, §5; ADR-0046).
 *
 * Reads one run directory written by scripts/bench.sh and produces report.md + summary.json **only from measured
 * files**. It refuses to write a report with a missing value. Correctness gates (reconciliations, derived rate-limit
 * intervals, status sets) decide the exit code; latency and throughput are informational and never gate.
 * With the full profile, the report and summary are also written to benchmarks/reports/ for committing.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';

// ---- Parsing ----------------------------------------------------------------------------------------------------

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Prometheus text format (counters and gauges; comments skipped). */
export function parsePrometheus(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (match === null) continue;
    const labels: Record<string, string> = {};
    for (const pair of (match[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
      labels[pair[1] ?? ''] = pair[2] ?? '';
    }
    samples.push({ name: match[1] ?? '', labels, value: Number(match[3]) });
  }
  return samples;
}

export function sumMetric(
  samples: Sample[],
  name: string,
  match: Record<string, string> = {},
): number {
  return samples
    .filter((s) => s.name === name && Object.entries(match).every(([k, v]) => s.labels[k] === v))
    .reduce((sum, s) => sum + s.value, 0);
}

export function metricDelta(
  before: Sample[],
  after: Sample[],
  name: string,
  match: Record<string, string> = {},
): number {
  return sumMetric(after, name, match) - sumMetric(before, name, match);
}

/** "123.4MiB / 512MiB" (docker stats) → bytes of the first value. */
export function parseMemory(text: string): number {
  const match = /^([\d.]+)\s*([KMGT]?i?B)/.exec(text.trim());
  if (match === null) return Number.NaN;
  const units: Record<string, number> = {
    B: 1,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4,
  };
  return Number(match[1]) * (units[match[2] ?? 'B'] ?? Number.NaN);
}

export interface ContainerUsage {
  samples: number;
  cpuAvgPct: number;
  cpuMaxPct: number;
  memMaxBytes: number;
}

/** docker stats lines ({t, s: {Name, CPUPerc, MemUsage}}) → per Compose service. */
export function summarizeStats(lines: string[]): Record<string, ContainerUsage> {
  const acc: Record<string, { cpu: number[]; mem: number[] }> = {};
  for (const line of lines) {
    if (line.trim() === '') continue;
    const { s } = JSON.parse(line) as { s: { Name: string; CPUPerc: string; MemUsage: string } };
    // pulsegate-bench-gateway-1 → gateway; pulsegate-bench-k6-run-1a2b3c → k6 (a one-off `compose run` container).
    const service = s.Name.replace(/^pulsegate-bench-/, '')
      .replace(/^k6-run-.*$/, 'k6')
      .replace(/-\d+$/, '');
    acc[service] ??= { cpu: [], mem: [] };
    acc[service].cpu.push(Number(s.CPUPerc.replace('%', '')));
    acc[service].mem.push(parseMemory(s.MemUsage));
  }
  return Object.fromEntries(
    Object.entries(acc).map(([service, { cpu, mem }]) => [
      service,
      {
        samples: cpu.length,
        cpuAvgPct: cpu.reduce((a, b) => a + b, 0) / cpu.length,
        cpuMaxPct: Math.max(...cpu),
        memMaxBytes: Math.max(...mem),
      },
    ]),
  );
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  return (
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN
  );
}

// ---- Rate-limit expectation (§3a) -----------------------------------------------------------------------------

export interface TimedResponse {
  /** Start of the request (k6 sample time minus its duration), epoch ms. */
  startMs: number;
  durationMs: number;
  status: number;
}

/**
 * Accepted-request interval for one subject of a token bucket that starts full (C), refills continuously at rho/s and
 * accepts when tokens >= 1, offered a rate above rho: A = C + floor(rho * (t_n - t_0)). The gateway's span is only
 * known within k6's send span S, widened by the first request's duration L0 and the last one's Ln.
 */
export function acceptedInterval(
  responses: TimedResponse[],
  capacity: number,
  ratePerSecond: number,
): { low: number; high: number; spanMs: number } {
  const sorted = [...responses].sort((a, b) => a.startMs - b.startMs);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined)
    return { low: Number.NaN, high: Number.NaN, spanMs: Number.NaN };
  const spanMs = last.startMs - first.startMs;
  const low =
    capacity + Math.floor((ratePerSecond * Math.max(0, spanMs - first.durationMs)) / 1000);
  const high = capacity + Math.floor((ratePerSecond * (spanMs + last.durationMs)) / 1000);
  return { low, high, spanMs };
}

// ---- Run loading ------------------------------------------------------------------------------------------------

export interface ResponsePoint {
  tags: Record<string, string>;
}

export interface RawRun {
  /** pg_responses points (one per response) with their tags. */
  responses: ResponsePoint[];
  /** http_req_duration samples per subject (K5/K8), for the derived intervals. */
  bySubject: Map<string, TimedResponse[]>;
  /** Per second of the measured phase: durations and server errors (K9). */
  perSecond: Map<number, { durations: number[]; errors: number }>;
  /** Measured phase from the first request's start to the last response, ms (NaN without measured samples). */
  measureSpanMs: number;
}

export async function readRaw(path: string): Promise<RawRun> {
  const run: RawRun = {
    responses: [],
    bySubject: new Map(),
    perSecond: new Map(),
    measureSpanMs: Number.NaN,
  };
  let firstStart = Infinity;
  let lastEnd = -Infinity;
  const lines = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.includes('"type":"Point"')) continue;
    const point = JSON.parse(line) as {
      metric: string;
      data: { time: string; value: number; tags?: Record<string, string> };
    };
    const tags = point.data.tags ?? {};
    if (point.metric === 'pg_responses') {
      run.responses.push({ tags });
    } else if (point.metric === 'http_req_duration') {
      const endMs = Date.parse(point.data.time);
      const status = Number(tags['status'] ?? '0');
      const subject = tags['subject'];
      if (subject !== undefined) {
        const list = run.bySubject.get(subject) ?? [];
        list.push({ startMs: endMs - point.data.value, durationMs: point.data.value, status });
        run.bySubject.set(subject, list);
      }
      if (tags['phase'] === 'measure') {
        firstStart = Math.min(firstStart, endMs - point.data.value);
        lastEnd = Math.max(lastEnd, endMs);
        const second = Math.floor(endMs / 1000);
        const bucket = run.perSecond.get(second) ?? { durations: [], errors: 0 };
        bucket.durations.push(point.data.value);
        if (status === 0 || status >= 500) bucket.errors++;
        run.perSecond.set(second, bucket);
      }
    }
  }
  if (Number.isFinite(firstStart)) run.measureSpanMs = lastEnd - firstStart;
  return run;
}

export function countResponses(raw: RawRun, match: Record<string, string> = {}): number {
  return raw.responses.filter((r) => Object.entries(match).every(([k, v]) => r.tags[k] === v))
    .length;
}

function statusSet(raw: RawRun): Set<string> {
  return new Set(raw.responses.map((r) => r.tags['status'] ?? '?'));
}

// ---- Gates ------------------------------------------------------------------------------------------------------

export interface Gate {
  name: string;
  pass: boolean;
  evidence: string;
}

function gate(name: string, pass: boolean, evidence: string): Gate {
  return { name, pass, evidence };
}

function equal(name: string, a: number, b: number, labelA: string, labelB: string): Gate {
  return gate(name, a === b, `${labelA} = ${String(a)}, ${labelB} = ${String(b)}`);
}

interface Snapshots {
  metricsBefore: Sample[];
  metricsAfter: Sample[];
  metrics2Before: Sample[];
  metrics2After: Sample[];
  ordersBefore: { total: number; byPath: Record<string, number> };
  ordersAfter: { total: number; byPath: Record<string, number> };
  adminBefore: unknown;
  adminAfter: unknown;
}

export interface ScenarioData {
  name: string;
  exitCode: number;
  summary: K6Summary;
  raw: RawRun;
  snap: Snapshots;
  usage: Record<string, ContainerUsage>;
  health: string | undefined;
}

export interface K6Summary {
  metrics: Record<string, { values: Record<string, number> } | undefined>;
}

function summaryValue(summary: K6Summary, metric: string, stat: string): number {
  return summary.metrics[metric]?.values[stat] ?? Number.NaN;
}

function gatewayDelta(s: ScenarioData, name: string, match: Record<string, string>): number {
  return (
    metricDelta(s.snap.metricsBefore, s.snap.metricsAfter, name, match) +
    metricDelta(s.snap.metrics2Before, s.snap.metrics2After, name, match)
  );
}

function mockPathDelta(s: ScenarioData, path: string): number {
  return (s.snap.ordersAfter.byPath[path] ?? 0) - (s.snap.ordersBefore.byPath[path] ?? 0);
}

function routeCacheFromAdmin(
  admin: unknown,
  route: string,
): { hit: number; miss: number; bypass: number } {
  const routes = (
    admin as {
      routes?: {
        id: string;
        series: { window: { counters: { cache: Record<string, number> } } };
      }[];
    }
  ).routes;
  const cache = routes?.find((r) => r.id === route)?.series.window.counters.cache;
  return {
    hit: cache?.['hit'] ?? Number.NaN,
    miss: cache?.['miss'] ?? Number.NaN,
    bypass: cache?.['bypass'] ?? Number.NaN,
  };
}

/** Requests completed by the gateway for the routes this scenario hit, compared with k6's own count. */
function reconcileRequests(s: ScenarioData, routes: string[]): Gate[] {
  const gates: Gate[] = [];
  for (const route of routes) {
    const k6 = countResponses(s.raw, { route });
    gates.push(
      equal(
        `${route}: k6 responses = gateway requests_total delta`,
        k6,
        gatewayDelta(s, 'pulsegate_requests_total', { route }),
        'k6',
        '/metrics',
      ),
    );
    for (const klass of ['2xx', '4xx', '5xx']) {
      const k6Class = s.raw.responses.filter(
        (r) => r.tags['route'] === route && (r.tags['status'] ?? '').startsWith(klass[0] ?? ''),
      ).length;
      const metric = gatewayDelta(s, 'pulsegate_requests_total', { route, status_class: klass });
      if (k6Class !== 0 || metric !== 0) {
        gates.push(equal(`${route}: ${klass} k6 = /metrics`, k6Class, metric, 'k6', '/metrics'));
      }
    }
  }
  return gates;
}

function onlyStatuses(s: ScenarioData, allowed: string[]): Gate {
  const seen = [...statusSet(s.raw)].sort();
  return gate(
    `statuses only ${allowed.join('/')}`,
    seen.every((x) => allowed.includes(x)),
    `seen: ${seen.join(', ') || 'none'}`,
  );
}

function k6Exit(s: ScenarioData): Gate {
  return gate(
    'k6 correctness checks (exit code)',
    s.exitCode === 0,
    `k6 exit ${String(s.exitCode)}`,
  );
}

export const K5_POLICY = { capacity: 10, ratePerSecond: 2 };
export const K8_POLICY = { capacity: 20, ratePerSecond: 4 };
export const K3_SHARES: Record<string, number> = {
  'bench-cached': 0.6,
  'bench-auth': 0.2,
  'bench-write': 0.1,
  'bench-plain': 0.1,
};

function subjectGates(
  s: ScenarioData,
  policy: { capacity: number; ratePerSecond: number },
): { gates: Gate[]; rows: string[][] } {
  const gates: Gate[] = [];
  const rows: string[][] = [];
  for (const [subject, list] of [...s.raw.bySubject].sort(([a], [b]) =>
    a.localeCompare(b, 'en', { numeric: true }),
  )) {
    const accepted = list.filter((r) => r.status === 200).length;
    const rejected = list.filter((r) => r.status === 429).length;
    const { low, high, spanMs } = acceptedInterval(list, policy.capacity, policy.ratePerSecond);
    const pass = accepted >= low && accepted <= high;
    gates.push(
      gate(
        `subject ${subject}: accepted within derived interval`,
        pass,
        `accepted ${String(accepted)}, interval [${String(low)}, ${String(high)}]`,
      ),
    );
    rows.push([
      subject,
      String(list.length),
      String(accepted),
      String(rejected),
      (spanMs / 1000).toFixed(3),
      `[${String(low)}, ${String(high)}]`,
      pass ? 'PASS' : 'FAIL',
    ]);
  }
  return { gates, rows };
}

export interface ScenarioResult {
  name: string;
  title: string;
  offered: string;
  latency: Record<'avg' | 'med' | 'p90' | 'p95' | 'p99' | 'max', number> & { count: number };
  achievedRps: number;
  dropped: number;
  errorRatePct: number;
  serverErrors: number;
  usage: Record<string, ContainerUsage>;
  /**
   * Max event-loop stall per gateway instance during the scenario, ms (prom-client resets the gauge on every scrape, so
   * the "after" scrape covers exactly the scenario since the "before" scrape). Q15 evidence.
   */
  eventLoopStallMs: { gateway: number; 'gateway-2'?: number };
  /** Fail-closed 503s (RATE_LIMITER_UNAVAILABLE) during the scenario, all instances. */
  limiterUnavailable: number;
  gates: Gate[];
  details: string[];
}

const TITLES: Record<string, string> = {
  k0: 'K0 baseline: k6 → mock directly',
  k1: 'K1 steady through the gateway',
  k2: 'K2 burst against a limited route',
  k3: 'K3 mixed routes',
  k4: 'K4 cache hits on one warm key',
  k5: 'K5 rate-limit rejections (10 subjects)',
  k6: 'K6 slow upstream (300 ms)',
  k7: 'K7 failing upstream (20 % failures, retries, breaker)',
  k8: 'K8 Redis limiter, 2 instances',
  k9: 'K9 saturation ramp (informational)',
};

function titleOf(name: string, kind: string): string {
  if (name === 'k8-shared') return 'K8 Redis limiter: one subject shared by 2 instances';
  if (name.startsWith('k8-tput-1')) return 'K8 Redis limiter: throughput, 1 instance';
  if (name.startsWith('k8-tput-2')) return 'K8 Redis limiter: throughput, 2 instances';
  return TITLES[kind] ?? name;
}

export function evaluate(s: ScenarioData, measureSeconds: number): ScenarioResult {
  const kind = s.name.slice(0, 2);
  const gates: Gate[] = [k6Exit(s)];
  const details: string[] = [];
  const total = s.raw.responses.length;
  const serverErrors = s.raw.responses.filter(
    (r) => (r.tags['status'] ?? '').startsWith('5') || r.tags['status'] === '0',
  ).length;

  switch (kind) {
    case 'k0': {
      gates.push(onlyStatuses(s, ['200']));
      gates.push(
        equal(
          'mock received every request',
          mockPathDelta(s, '/bench/plain/item'),
          total,
          'mock /_stats delta',
          'k6',
        ),
      );
      gates.push(
        equal(
          'gateway saw none of them',
          gatewayDelta(s, 'pulsegate_requests_total', {}),
          0,
          '/metrics delta',
          'expected',
        ),
      );
      break;
    }
    case 'k1': {
      gates.push(onlyStatuses(s, ['200']));
      gates.push(...reconcileRequests(s, ['bench-plain']));
      gates.push(
        equal(
          'every request reached the mock',
          mockPathDelta(s, '/bench/plain/item'),
          total,
          'mock /_stats delta',
          'k6',
        ),
      );
      break;
    }
    case 'k2': {
      gates.push(onlyStatuses(s, ['200', '429']));
      gates.push(...reconcileRequests(s, ['bench-burst']));
      gates.push(
        equal(
          'allowed = limiter decisions',
          countResponses(s.raw, { status: '200' }),
          gatewayDelta(s, 'pulsegate_rate_limit_decisions_total', {
            route: 'bench-burst',
            decision: 'allowed',
          }),
          'k6 200',
          '/metrics allowed',
        ),
      );
      gates.push(
        equal(
          'rejected = limiter decisions',
          countResponses(s.raw, { status: '429' }),
          gatewayDelta(s, 'pulsegate_rate_limit_decisions_total', {
            route: 'bench-burst',
            decision: 'rejected',
          }),
          'k6 429',
          '/metrics rejected',
        ),
      );
      details.push(
        `200: ${String(countResponses(s.raw, { status: '200' }))}, 429: ${String(countResponses(s.raw, { status: '429' }))}`,
      );
      break;
    }
    case 'k3': {
      gates.push(onlyStatuses(s, ['200']));
      gates.push(...reconcileRequests(s, Object.keys(K3_SHARES)));
      for (const [route, share] of Object.entries(K3_SHARES)) {
        const measured = total === 0 ? Number.NaN : countResponses(s.raw, { route }) / total;
        gates.push(
          gate(
            `${route} share ${String(share * 100)} % ± 2 pts`,
            Math.abs(measured - share) <= 0.02,
            `measured ${(measured * 100).toFixed(2)} %`,
          ),
        );
      }
      break;
    }
    case 'k4': {
      const hits = countResponses(s.raw, { cache: 'HIT' });
      const misses = countResponses(s.raw, { cache: 'MISS' });
      const bypass = countResponses(s.raw, { cache: 'BYPASS' });
      const mHit = gatewayDelta(s, 'pulsegate_cache_requests_total', {
        route: 'bench-cached',
        result: 'hit',
      });
      const mMiss = gatewayDelta(s, 'pulsegate_cache_requests_total', {
        route: 'bench-cached',
        result: 'miss',
      });
      const mock = mockPathDelta(s, '/bench/cached/k4');
      const adminBefore = routeCacheFromAdmin(s.snap.adminBefore, 'bench-cached');
      const adminAfter = routeCacheFromAdmin(s.snap.adminAfter, 'bench-cached');
      gates.push(onlyStatuses(s, ['200']));
      gates.push(equal('k6 HIT = /metrics hit delta', hits, mHit, 'k6', '/metrics'));
      gates.push(equal('k6 MISS = /metrics miss delta', misses, mMiss, 'k6', '/metrics'));
      gates.push(
        equal(
          'k6 MISS = requests the mock received for the key',
          misses,
          mock,
          'k6',
          'mock /_stats',
        ),
      );
      gates.push(equal('no bypass', bypass, 0, 'k6 BYPASS', 'expected'));
      gates.push(
        equal(
          'admin API hit delta = k6 HIT',
          adminAfter.hit - adminBefore.hit,
          hits,
          'admin',
          'k6',
        ),
      );
      gates.push(...reconcileRequests(s, ['bench-cached']));
      const ratio = hits + misses === 0 ? Number.NaN : hits / (hits + misses);
      details.push(
        `hit ratio (measured): ${String(hits)} / ${String(hits + misses)} = ${(ratio * 100).toFixed(3)} %; upstream requests for the key during the run: ${String(mock)}`,
      );
      break;
    }
    case 'k5': {
      gates.push(onlyStatuses(s, ['200', '429']));
      const { gates: subjectChecks, rows } = subjectGates(s, K5_POLICY);
      gates.push(...subjectChecks);
      gates.push(
        equal(
          'allowed = limiter decisions',
          countResponses(s.raw, { status: '200' }),
          gatewayDelta(s, 'pulsegate_rate_limit_decisions_total', {
            route: 'bench-limited',
            decision: 'allowed',
          }),
          'k6 200',
          '/metrics',
        ),
      );
      gates.push(
        equal(
          'rejected = limiter decisions',
          countResponses(s.raw, { status: '429' }),
          gatewayDelta(s, 'pulsegate_rate_limit_decisions_total', {
            route: 'bench-limited',
            decision: 'rejected',
          }),
          'k6 429',
          '/metrics',
        ),
      );
      details.push(
        table(
          ['subject', 'requests', 'accepted', 'rejected', 'span s', 'derived interval', 'gate'],
          rows,
        ),
      );
      break;
    }
    case 'k6': {
      gates.push(onlyStatuses(s, ['200']));
      gates.push(...reconcileRequests(s, ['bench-slow']));
      break;
    }
    case 'k7': {
      gates.push(onlyStatuses(s, ['200', '503']));
      gates.push(...reconcileRequests(s, ['bench-flaky']));
      gates.push(
        gate(
          'gateway healthy afterwards',
          s.health?.includes('"ok"') === true,
          `health: ${s.health ?? 'missing'}`,
        ),
      );
      const opened = gatewayDelta(s, 'pulsegate_circuit_breaker_transitions_total', {
        upstream: 'flaky-service',
        to: 'open',
      });
      const attemptsOk = gatewayDelta(s, 'pulsegate_upstream_requests_total', {
        upstream: 'flaky-service',
        outcome: 'success',
      });
      const attemptsFail = gatewayDelta(s, 'pulsegate_upstream_requests_total', {
        upstream: 'flaky-service',
        outcome: 'failure',
      });
      const retries = gatewayDelta(s, 'pulsegate_retries_total', { route: 'bench-flaky' });
      details.push(
        `upstream attempts: ${String(attemptsOk)} succeeded, ${String(attemptsFail)} failed (${((attemptsFail / (attemptsOk + attemptsFail)) * 100).toFixed(2)} %); retries ${String(retries)}; breaker opened ${String(opened)} times`,
      );
      details.push(
        `client-visible 503: ${String(countResponses(s.raw, { status: '503' }))} of ${String(total)}`,
      );
      break;
    }
    case 'k8': {
      if (s.name === 'k8-shared') {
        gates.push(onlyStatuses(s, ['200', '429']));
        const { gates: subjectChecks, rows } = subjectGates(s, K8_POLICY);
        gates.push(...subjectChecks);
        gates.push(
          equal(
            'allowed = decisions on both instances',
            countResponses(s.raw, { status: '200' }),
            gatewayDelta(s, 'pulsegate_rate_limit_decisions_total', {
              route: 'bench-shared',
              decision: 'allowed',
            }),
            'k6 200',
            '/metrics (2 instances)',
          ),
        );
        details.push(
          table(
            ['subject', 'requests', 'accepted', 'rejected', 'span s', 'derived interval', 'gate'],
            rows,
          ),
        );
      } else {
        gates.push(onlyStatuses(s, ['200']));
        gates.push(...reconcileRequests(s, ['bench-redis-plain']));
        const unavailable = gatewayDelta(s, 'pulsegate_rate_limiter_unavailable_total', {
          route: 'bench-redis-plain',
        });
        details.push(
          `RATE_LIMITER_UNAVAILABLE (fail-closed 503) across both instances: ${String(unavailable)}`,
        );
      }
      details.push(
        Object.entries(s.usage)
          .filter(([service]) => service.startsWith('gateway') || service === 'redis')
          .map(
            ([service, u]) =>
              `${service} CPU avg/max ${u.cpuAvgPct.toFixed(1)} / ${u.cpuMaxPct.toFixed(1)} %`,
          )
          .join('; '),
      );
      break;
    }
    case 'k9': {
      details.push(describeSaturation(s.raw.perSecond));
      break;
    }
    default:
      break;
  }

  const count = summaryValue(s.summary, 'http_reqs{phase:measure}', 'count');
  return {
    name: s.name,
    title: titleOf(s.name, kind),
    offered: '',
    latency: {
      avg: summaryValue(s.summary, 'http_req_duration{phase:measure}', 'avg'),
      med: summaryValue(s.summary, 'http_req_duration{phase:measure}', 'med'),
      p90: summaryValue(s.summary, 'http_req_duration{phase:measure}', 'p(90)'),
      p95: summaryValue(s.summary, 'http_req_duration{phase:measure}', 'p(95)'),
      p99: summaryValue(s.summary, 'http_req_duration{phase:measure}', 'p(99)'),
      max: summaryValue(s.summary, 'http_req_duration{phase:measure}', 'max'),
      count,
    },
    achievedRps:
      kind === 'k5' || s.name === 'k8-shared' || kind === 'k2' || kind === 'k9'
        ? count / measureSecondsFor(s)
        : count / measureSeconds,
    dropped: summary0(s.summary, 'dropped_iterations{phase:measure}', 'count'),
    errorRatePct: total === 0 ? Number.NaN : (serverErrors / total) * 100,
    serverErrors,
    usage: s.usage,
    eventLoopStallMs: {
      gateway: sumMetric(s.snap.metricsAfter, 'pulsegate_nodejs_eventloop_lag_max_seconds') * 1000,
      ...(s.snap.metrics2After.length > 0
        ? {
            'gateway-2':
              sumMetric(s.snap.metrics2After, 'pulsegate_nodejs_eventloop_lag_max_seconds') * 1000,
          }
        : {}),
    },
    limiterUnavailable: gatewayDelta(s, 'pulsegate_rate_limiter_unavailable_total', {}),
    gates,
    details,
  };
}

/** Scenarios without a fixed measured window: the measured span from the raw samples. */
function measureSecondsFor(s: ScenarioData): number {
  return s.raw.measureSpanMs / 1000;
}

/** A counter that k6 omits when it never fired (e.g. no dropped iterations) is a measured zero. */
function summary0(summary: K6Summary, metric: string, stat: string): number {
  const value = summary.metrics[metric]?.values[stat];
  return value ?? 0;
}

/** Consecutive breaching seconds that count as saturation rather than a transient stall. */
export const SATURATION_SECONDS = 3;

/**
 * K9 per second: a second breaches when p99 > 100 ms or server errors > 1 %. Isolated breaches are reported as
 * stalls; saturation needs SATURATION_SECONDS consecutive breaching seconds. The last second is partial (drain) and is
 * reported separately rather than judged.
 */
export function describeSaturation(
  perSecond: Map<number, { durations: number[]; errors: number }>,
): string {
  const seconds = [...perSecond].sort(([a], [b]) => a - b);
  const start = seconds[0]?.[0] ?? 0;
  const full = seconds.slice(0, -1);
  const breaching = full
    .filter(([, b]) => {
      const sorted = [...b.durations].sort((x, y) => x - y);
      return percentile(sorted, 0.99) > 100 || b.errors / b.durations.length > 0.01;
    })
    .map(([second, b]) => ({
      t: second - start,
      completed: b.durations.length,
      p99: percentile(
        [...b.durations].sort((x, y) => x - y),
        0.99,
      ),
      errors: b.errors,
    }));
  let run = 0;
  let sustainedAt: number | undefined;
  let previousT = Number.NaN;
  for (const { t } of breaching) {
    run = t === previousT + 1 ? run + 1 : 1;
    previousT = t;
    if (run >= SATURATION_SECONDS && sustainedAt === undefined)
      sustainedAt = t - SATURATION_SECONDS + 1;
  }
  const lastFull = full.at(-1);
  const peak = lastFull === undefined ? 0 : lastFull[1].durations.length;
  const list = breaching
    .map(
      (b) =>
        `t+${String(b.t)} s (${String(b.completed)} completed, p99 ${b.p99.toFixed(1)} ms, ${String(b.errors)} errors)`,
    )
    .join('; ');
  if (sustainedAt !== undefined) {
    return `sustained breach (≥ ${String(SATURATION_SECONDS)} consecutive seconds of p99 > 100 ms or errors > 1 %) from t+${String(sustainedAt)} s. Breaching seconds: ${list}`;
  }
  return (
    `no sustained breach in the tested range: the last full second completed ${String(peak)} responses. ` +
    (breaching.length === 0
      ? 'No second breached.'
      : `Isolated breaching seconds (transient stalls, not saturation): ${list}.`)
  );
}

// ---- Rendering --------------------------------------------------------------------------------------------------

export function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

/**
 * Server errors as a count with a percentage precise enough not to round a real error away (1 of 37,491 is
 * "1 (0.0027 %)", never "0.00 %").
 */
export function formatErrors(count: number, pct: number, label: string): string {
  num(pct, 0, `${label} errors`);
  return count === 0 ? '0' : `${String(count)} (${pct.toPrecision(2)} %)`;
}

/** Formats a measured number; a missing value stops the report (never an invented or blank number). */
export function num(value: number, digits: number, label: string): string {
  if (!Number.isFinite(value)) throw new Error(`missing measured value: ${label}`);
  return value.toFixed(digits);
}

export interface Meta {
  profile: string;
  ci?: boolean;
  startedAt: string;
  host: { cpuModel: string; logicalCpus: number; memoryBytes: number; os: string };
  docker: {
    serverVersion: unknown;
    operatingSystem: unknown;
    cpus: unknown;
    memoryBytes: unknown;
    composeVersion: string;
  };
  limits: Record<string, { cpus: number; memory: string }>;
  versions: Record<string, string>;
  git: { commit: string; dirtyFiles: number };
  workloadHashes: Record<string, string>;
  /** Recorded since ADR-0048; absent in earlier runs. */
  redisLimiter?: { commandTimeoutMs: number; failurePolicy: string | null };
}

const OFFERED: Record<string, (name: string, profile: string) => string> = {
  k0: (n) => `${n.split('-r')[1] ?? '?'} rps, fixed 1 KiB body`,
  k1: (n) => `${n.split('-r')[1] ?? '?'} rps, fixed 1 KiB body`,
  k2: () => '50 → 500 → 50 rps (ramping)',
  k3: (_n, p) => `${p === 'full' ? '300' : '60'} rps total (60/20/10/10 %)`,
  k4: (_n, p) => `${p === 'full' ? '500' : '100'} rps, one key`,
  k5: () => '10 subjects × 20 rps',
  k6: (_n, p) => `${p === 'full' ? '100' : '30'} rps`,
  k7: (_n, p) => `${p === 'full' ? '200' : '50'} rps`,
  k8: (n, p) =>
    n === 'k8-shared'
      ? '40 rps, one subject, alternating instances'
      : `${p === 'full' ? '500' : '100'} rps, ${n.startsWith('k8-tput-2') ? '2 instances' : '1 instance'}`,
  k9: () => '100 → 4,000 rps over 90 s',
};

export function render(
  meta: Meta,
  runId: string,
  results: ScenarioResult[],
  checksums: Record<string, string>,
): string {
  const mib = (b: number) => (b / 1024 ** 2).toFixed(0);
  const lines: string[] = [];
  lines.push(`# Benchmark report ${runId}`);
  lines.push('');
  lines.push(
    `Generated by \`scripts/bench-report.ts\` from the raw files of one \`scripts/bench.sh\` run (profile **${meta.profile}**). ` +
      'Every number below was measured in this run. **Local measurements on one machine, not a production capacity claim.** ' +
      'Latency and throughput are informational; only the correctness gates pass or fail.',
  );
  lines.push('');
  lines.push('## Environment');
  lines.push(
    table(
      ['item', 'value'],
      [
        ['host CPU', `${meta.host.cpuModel} (${String(meta.host.logicalCpus)} logical CPUs)`],
        ['host memory', `${mib(meta.host.memoryBytes)} MiB`],
        ['OS', meta.host.os],
        [
          'Docker',
          `${String(meta.docker.serverVersion)} on ${String(meta.docker.operatingSystem)}; ${String(meta.docker.cpus)} CPUs, ${mib(Number(meta.docker.memoryBytes))} MiB; Compose ${meta.docker.composeVersion}`,
        ],
        [
          'container limits',
          Object.entries(meta.limits)
            .map(([k, v]) => `${k} ${String(v.cpus)} CPU / ${v.memory}`)
            .join('; '),
        ],
        [
          'versions',
          Object.entries(meta.versions)
            .map(([k, v]) => `${k} ${v}`)
            .join('; '),
        ],
        [
          'git',
          `${meta.git.commit}${meta.git.dirtyFiles > 0 ? ` (+${String(meta.git.dirtyFiles)} uncommitted files)` : ''}`,
        ],
        ['started', meta.startedAt],
      ],
    ),
  );
  lines.push('');
  lines.push('Workload files (SHA-256):');
  lines.push('');
  lines.push(
    table(
      ['file', 'sha256'],
      Object.entries(meta.workloadHashes).map(([f, h]) => [f, `\`${h}\``]),
    ),
  );
  lines.push('');
  lines.push('## Results (measured phase only; warm-up excluded)');
  lines.push(
    table(
      [
        'scenario',
        'offered',
        'achieved rps',
        'dropped',
        'p50 ms',
        'p90',
        'p95',
        'p99',
        'max',
        'server errors',
        'gateway CPU avg/max %',
        'gateway mem max MiB',
        'orders-mock CPU avg %',
        'k6 CPU avg/max %',
      ],
      results.map((r) => {
        const gw = r.usage['gateway'];
        return [
          r.name,
          r.offered,
          num(r.achievedRps, 1, `${r.name} rps`),
          String(r.dropped),
          num(r.latency.med, 2, `${r.name} p50`),
          num(r.latency.p90, 2, `${r.name} p90`),
          num(r.latency.p95, 2, `${r.name} p95`),
          num(r.latency.p99, 2, `${r.name} p99`),
          num(r.latency.max, 2, `${r.name} max`),
          formatErrors(r.serverErrors, r.errorRatePct, r.name),
          gw === undefined
            ? 'n/a (no gateway in path)'
            : `${num(gw.cpuAvgPct, 1, 'cpu')} / ${num(gw.cpuMaxPct, 1, 'cpu')}`,
          gw === undefined ? 'n/a' : num(gw.memMaxBytes / 1024 ** 2, 0, 'mem'),
          r.usage['orders-mock'] === undefined
            ? 'n/a'
            : num(r.usage['orders-mock'].cpuAvgPct, 1, 'mock cpu'),
          r.usage['k6'] === undefined
            ? 'n/a'
            : `${num(r.usage['k6'].cpuAvgPct, 1, 'k6 cpu')} / ${num(r.usage['k6'].cpuMaxPct, 1, 'k6 cpu')}`,
        ];
      }),
    ),
  );
  lines.push('');
  lines.push(
    '`server errors` = responses with status 5xx or no response, as a count (and share). ' +
      '`dropped` = iterations k6 could not start at the offered rate (the open model reports them instead of hiding ' +
      'them). CPU % is as reported by `docker stats` (100 % = one CPU), sampled about once a second; in K0 the gateway ' +
      'is idle (not in the path).',
  );
  if (meta.ci === true) {
    lines.push('');
    lines.push(
      '**CI runner:** shared, noisy hardware. These numbers are not comparable with local runs or with each other, and ' +
        'are never committed; only the correctness gates are meaningful here.',
    );
  }
  if (meta.profile !== 'full') {
    lines.push('');
    lines.push(
      '**Quick profile:** 5 s warm-up and 10 s measured windows check the suite and its correctness gates. A 10 s window ' +
        'at 50 rps has 500 samples, so p99 is the 5th-slowest response: tail latencies here are not stable and are ' +
        'not to be compared or published.',
    );
  }
  lines.push('');

  // K0 vs K1 overhead, only where both reached the offered rate.
  // Q15: event-loop stalls vs fail-closed limiter 503s, for every Redis throughput window (including repeats).
  const k8 = results.filter((r) => r.name.startsWith('k8-tput-'));
  if (k8.length > 0) {
    lines.push('## Redis limiter: event-loop stalls vs fail-closed 503s (Q15)');
    lines.push('');
    lines.push(
      'Per window: the longest event-loop stall of each gateway instance (`pulsegate_nodejs_eventloop_lag_max_seconds`, ' +
        'reset at every scrape) and the `RATE_LIMITER_UNAVAILABLE` responses. ' +
        (meta.redisLimiter === undefined
          ? "The limiter settings are not recorded in this run's metadata (recording started with ADR-0048, which " +
            'lists the command timeout each earlier run used).'
          : `Limiter in this run: \`commandTimeoutMs\` ${String(meta.redisLimiter.commandTimeoutMs)} ms, ` +
            `\`redisFailurePolicy\` ${meta.redisLimiter.failurePolicy ?? 'n/a'}.`),
    );
    lines.push('');
    lines.push(
      table(
        [
          'window',
          'measured requests',
          'max stall gateway ms',
          'max stall gateway-2 ms',
          'limiter 503s',
        ],
        k8.map((r) => [
          r.name,
          String(r.latency.count),
          num(r.eventLoopStallMs.gateway, 1, `${r.name} stall`),
          r.eventLoopStallMs['gateway-2'] === undefined
            ? 'n/a'
            : num(r.eventLoopStallMs['gateway-2'], 1, `${r.name} stall 2`),
          String(r.limiterUnavailable),
        ]),
      ),
    );
    const windows = k8.length;
    const affected = k8.filter((r) => r.limiterUnavailable > 0).length;
    const stalled = k8.filter(
      (r) => Math.max(r.eventLoopStallMs.gateway, r.eventLoopStallMs['gateway-2'] ?? 0) >= 50,
    ).length;
    lines.push('');
    lines.push(
      `${String(windows)} windows: ${String(affected)} with limiter 503s (total ${String(k8.reduce((n, r) => n + r.limiterUnavailable, 0))}), ` +
        `${String(stalled)} with a stall ≥ 50 ms on an instance.`,
    );
    lines.push('');
  }

  const k0 = results.filter((r) => r.name.startsWith('k0-'));
  if (k0.length > 0) {
    lines.push('## Gateway overhead (K1 − K0 at equal offered rate)');
    lines.push('');
    lines.push(
      'Same mock path and fixed 1 KiB body, same arrival rate, VUs and windows, run back to back. Unavoidable differences: ' +
        'the gateway adds a second hop with its own keep-alive pool, about 150 response-header bytes, and the mandatory ' +
        'limiter check (effectively unlimited bucket). Reported only where neither run dropped iterations.',
    );
    lines.push('');
    const rows: string[][] = [];
    for (const base of k0) {
      const rate = base.name.split('-r')[1] ?? '';
      const gw = results.find((r) => r.name === `k1-r${rate}`);
      if (gw === undefined) continue;
      if (base.dropped > 0 || gw.dropped > 0) {
        rows.push([rate, 'saturated (dropped iterations)', '', '', '']);
        continue;
      }
      rows.push([
        rate,
        num(gw.latency.med - base.latency.med, 2, 'overhead p50'),
        num(gw.latency.p95 - base.latency.p95, 2, 'overhead p95'),
        num(gw.latency.p99 - base.latency.p99, 2, 'overhead p99'),
        `${num(base.latency.p99, 2, 'k0 p99')} → ${num(gw.latency.p99, 2, 'k1 p99')}`,
      ]);
    }
    lines.push(
      table(['offered rps', 'Δ p50 ms', 'Δ p95 ms', 'Δ p99 ms', 'p99 direct → gateway'], rows),
    );
    lines.push('');
  }

  lines.push('## Correctness gates');
  for (const r of results) {
    lines.push('');
    lines.push(`### ${r.name}: ${r.title}`);
    lines.push('');
    lines.push(
      table(
        ['gate', 'result', 'evidence'],
        r.gates.map((g) => [g.name, g.pass ? 'PASS' : '**FAIL**', g.evidence]),
      ),
    );
    for (const d of r.details) {
      lines.push('');
      lines.push(d);
    }
  }
  lines.push('');
  lines.push('## Raw files (SHA-256)');
  lines.push('');
  lines.push(
    `Kept in \`benchmarks/reports/raw/${runId}/\` (not committed; CI uploads them as artifacts).`,
  );
  lines.push('');
  lines.push(
    table(
      ['file', 'sha256'],
      Object.entries(checksums).map(([f, h]) => [f, `\`${h}\``]),
    ),
  );
  lines.push('');
  return lines.join('\n');
}

// ---- Main -------------------------------------------------------------------------------------------------------

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function readText(path: string, optional = false): Promise<string> {
  if (optional && !existsSync(path)) return '';
  return readFile(path, 'utf8');
}

export async function loadScenario(dir: string, name: string): Promise<ScenarioData> {
  const p = (suffix: string) => join(dir, `${name}.${suffix}`);
  const required = [
    'summary.json',
    'k6.json.gz',
    'exit',
    'before.metrics.txt',
    'after.metrics.txt',
    'before.orders.json',
    'after.orders.json',
    'before.admin.json',
    'after.admin.json',
  ];
  for (const suffix of required) {
    if (!existsSync(p(suffix))) throw new Error(`missing raw file: ${name}.${suffix}`);
  }
  return {
    name,
    exitCode: Number((await readText(p('exit'))).trim()),
    summary: await readJson<K6Summary>(p('summary.json')),
    raw: await readRaw(p('k6.json.gz')),
    snap: {
      metricsBefore: parsePrometheus(await readText(p('before.metrics.txt'))),
      metricsAfter: parsePrometheus(await readText(p('after.metrics.txt'))),
      metrics2Before: parsePrometheus(await readText(p('before.metrics-2.txt'), true)),
      metrics2After: parsePrometheus(await readText(p('after.metrics-2.txt'), true)),
      ordersBefore: await readJson(p('before.orders.json')),
      ordersAfter: await readJson(p('after.orders.json')),
      adminBefore: await readJson(p('before.admin.json')),
      adminAfter: await readJson(p('after.admin.json')),
    },
    usage: summarizeStats((await readText(p('stats.jsonl'), true)).split('\n')),
    health: existsSync(p('health.json')) ? await readText(p('health.json')) : undefined,
  };
}

const ORDER = ['k0', 'k1', 'k4', 'k2', 'k3', 'k5', 'k6', 'k7', 'k9', 'k8'];

export async function generate(
  dir: string,
): Promise<{ markdown: string; failed: Gate[]; results: ScenarioResult[]; meta: Meta }> {
  const meta = await readJson<Meta>(join(dir, 'meta.json'));
  const measureSeconds = meta.profile === 'full' ? 60 : 10;
  const files = await readdir(dir);
  const names = files
    .filter((f) => f.endsWith('.summary.json'))
    .map((f) => f.replace('.summary.json', ''))
    .sort(
      (a, b) =>
        ORDER.indexOf(a.slice(0, 2)) - ORDER.indexOf(b.slice(0, 2)) ||
        a.localeCompare(b, 'en', { numeric: true }),
    );
  if (names.length === 0) throw new Error('no scenario summaries in the run directory');
  const results: ScenarioResult[] = [];
  for (const name of names) {
    const result = evaluate(await loadScenario(dir, name), measureSeconds);
    result.offered = OFFERED[name.slice(0, 2)]?.(name, meta.profile) ?? '';
    results.push(result);
  }
  const checksums: Record<string, string> = {};
  for (const file of files
    .filter((f) => !f.endsWith('.md') && f !== 'keys.json' && f !== 'summary.json')
    .sort()) {
    checksums[file] = createHash('sha256')
      .update(await readFile(join(dir, file)))
      .digest('hex');
  }
  const markdown = render(meta, basename(dir), results, checksums);
  return {
    markdown,
    failed: results.flatMap((r) => r.gates.filter((g) => !g.pass)),
    results,
    meta,
  };
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (dir === undefined) throw new Error('usage: node scripts/bench-report.ts <run-dir>');
  const { markdown, failed, results, meta } = await generate(dir);
  const summary = {
    runId: basename(dir),
    profile: meta.profile,
    startedAt: meta.startedAt,
    host: meta.host,
    gitCommit: meta.git.commit,
    scenarios: results.map((r) => ({
      name: r.name,
      offered: r.offered,
      achievedRps: r.achievedRps,
      dropped: r.dropped,
      latencyMs: r.latency,
      serverErrorPct: r.errorRatePct,
      gates: r.gates,
    })),
  };
  await writeFile(join(dir, 'report.md'), markdown);
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  // Only full local runs are published; CI numbers are never committed.
  if (meta.profile === 'full' && meta.ci !== true) {
    const out = join('benchmarks', 'reports');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, `${basename(dir)}.md`), markdown);
    await writeFile(join(out, `${basename(dir)}.json`), JSON.stringify(summary, null, 2));
  }
  console.log(`report: ${join(dir, 'report.md')}`);
  if (failed.length > 0) {
    for (const g of failed) console.error(`FAIL: ${g.name} (${g.evidence})`);
    process.exit(1);
  }
  console.log(`all ${String(results.flatMap((r) => r.gates).length)} correctness gates passed`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();

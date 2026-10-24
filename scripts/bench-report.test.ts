import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acceptedInterval,
  evaluate,
  generate,
  metricDelta,
  num,
  parseMemory,
  parsePrometheus,
  percentile,
  readRaw,
  summarizeStats,
  type K6Summary,
  type RawRun,
  type ScenarioData,
} from './bench-report.ts';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() ?? '', { recursive: true, force: true });
});

describe('parsing measured files', () => {
  it('parses Prometheus text and sums matching series', () => {
    const before = parsePrometheus(
      [
        '# HELP pulsegate_requests_total x',
        'pulsegate_requests_total{route="a",status_class="2xx",code="none"} 10',
        'pulsegate_requests_total{route="a",status_class="4xx",code="RATE_LIMIT_EXCEEDED"} 2',
        'pulsegate_requests_total{route="b",status_class="2xx",code="none"} 5',
      ].join('\n'),
    );
    const after = parsePrometheus(
      [
        'pulsegate_requests_total{route="a",status_class="2xx",code="none"} 25',
        'pulsegate_requests_total{route="a",status_class="4xx",code="RATE_LIMIT_EXCEEDED"} 3',
        'pulsegate_requests_total{route="b",status_class="2xx",code="none"} 5',
      ].join('\n'),
    );
    expect(metricDelta(before, after, 'pulsegate_requests_total', { route: 'a' })).toBe(16);
    expect(
      metricDelta(before, after, 'pulsegate_requests_total', { route: 'a', status_class: '4xx' }),
    ).toBe(1);
    expect(metricDelta(before, after, 'pulsegate_requests_total', { route: 'b' })).toBe(0);
  });

  it('parses docker stats memory and summarizes per service', () => {
    expect(parseMemory('123.5MiB / 512MiB')).toBe(123.5 * 1024 ** 2);
    expect(parseMemory('1.5GiB / 2GiB')).toBe(1.5 * 1024 ** 3);
    expect(parseMemory('900kB / 1MB')).toBeNaN(); // lowercase k is not docker's format: refuse, don't guess
    const usage = summarizeStats([
      JSON.stringify({
        t: 1,
        s: { Name: 'pulsegate-bench-gateway-1', CPUPerc: '10.00%', MemUsage: '64MiB / 512MiB' },
      }),
      JSON.stringify({
        t: 2,
        s: { Name: 'pulsegate-bench-gateway-1', CPUPerc: '30.00%', MemUsage: '80MiB / 512MiB' },
      }),
      '',
    ]);
    expect(usage['gateway']).toEqual({
      samples: 2,
      cpuAvgPct: 20,
      cpuMaxPct: 30,
      memMaxBytes: 80 * 1024 ** 2,
    });
  });

  it('uses nearest-rank percentiles', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.99)).toBe(99);
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe('derived rate-limit interval (plan §3a)', () => {
  it('is C + floor(rho * span), widened by the first and last request durations', () => {
    // 10 s send span, first request 2 ms, last 3 ms: [10 + floor(2 * 9.998), 10 + floor(2 * 10.003)] = [29, 30].
    const responses = [
      { startMs: 1_000, durationMs: 2, status: 200 },
      { startMs: 6_000, durationMs: 1, status: 429 },
      { startMs: 11_000, durationMs: 3, status: 429 },
    ];
    expect(acceptedInterval(responses, 10, 2)).toEqual({ low: 29, high: 30, spanMs: 10_000 });
  });

  it('is one value when the span is far from a token boundary, two when it straddles one', () => {
    const at = (spanMs: number) => [
      { startMs: 0, durationMs: 1, status: 200 },
      { startMs: spanMs, durationMs: 1, status: 200 },
    ];
    // rho * span = 4 * 10.125 = 40.5 (+/- 0.004): floor is 40 either way.
    expect(acceptedInterval(at(10_125), 20, 4)).toMatchObject({ low: 60, high: 60 });
    // 4 * 10.250 = 41.0 sits on a boundary: the timing tolerance allows 40 or 41.
    expect(acceptedInterval(at(10_250), 20, 4)).toMatchObject({ low: 60, high: 61 });
  });

  it('has no interval without responses', () => {
    expect(acceptedInterval([], 10, 2).low).toBeNaN();
  });
});

function metrics(lines: string[]): ReturnType<typeof parsePrometheus> {
  return parsePrometheus(lines.join('\n'));
}

function k4Scenario(
  over: { metricHits?: number; mockMisses?: number; k6Cache?: string[] } = {},
): ScenarioData {
  const k6Cache = over.k6Cache ?? Array<string>(50).fill('HIT');
  const raw: RawRun = {
    responses: k6Cache.map((cache) => ({
      tags: { route: 'bench-cached', status: '200', cache, phase: 'measure' },
    })),
    bySubject: new Map(),
    perSecond: new Map(),
    measureSpanMs: 10_000,
  };
  const hits = over.metricHits ?? k6Cache.filter((c) => c === 'HIT').length;
  const admin = (hit: number) => ({
    routes: [
      {
        id: 'bench-cached',
        series: { window: { counters: { cache: { hit, miss: 0, bypass: 0 } } } },
      },
    ],
  });
  return {
    name: 'k4-cache',
    exitCode: 0,
    summary: {
      metrics: {
        'http_reqs{phase:measure}': { values: { count: 50 } },
        'http_req_duration{phase:measure}': {
          values: { avg: 1, med: 1, 'p(90)': 2, 'p(95)': 2, 'p(99)': 3, max: 4, count: 50 },
        },
      },
    },
    raw,
    snap: {
      metricsBefore: metrics([]),
      metricsAfter: metrics([
        `pulsegate_cache_requests_total{route="bench-cached",result="hit"} ${String(hits)}`,
        `pulsegate_requests_total{route="bench-cached",status_class="2xx",code="none"} ${String(k6Cache.length)}`,
      ]),
      metrics2Before: [],
      metrics2After: [],
      ordersBefore: { total: 0, byPath: {} },
      ordersAfter: {
        total: 0,
        byPath: over.mockMisses === undefined ? {} : { '/bench/cached/k4': over.mockMisses },
      },
      adminBefore: admin(0),
      adminAfter: admin(k6Cache.filter((c) => c === 'HIT').length),
    },
    usage: {},
    health: undefined,
  };
}

describe('K4 reconciliation gates', () => {
  it('pass when k6, /metrics, the admin API and the mock agree', () => {
    const result = evaluate(k4Scenario(), 10);
    expect(result.gates.filter((g) => !g.pass)).toEqual([]);
    expect(result.details[0]).toContain('hit ratio (measured): 50 / 50 = 100.000 %');
    expect(result.achievedRps).toBe(5);
  });

  it('fail when /metrics disagrees with k6', () => {
    const failed = evaluate(k4Scenario({ metricHits: 49 }), 10).gates.filter((g) => !g.pass);
    expect(failed.map((g) => g.name)).toContain('k6 HIT = /metrics hit delta');
  });

  it('fail when the upstream received requests k6 did not see as misses', () => {
    const failed = evaluate(k4Scenario({ mockMisses: 3 }), 10).gates.filter((g) => !g.pass);
    expect(failed.map((g) => g.name)).toContain('k6 MISS = requests the mock received for the key');
  });

  it('fail on any bypass', () => {
    const failed = evaluate(k4Scenario({ k6Cache: ['HIT', 'BYPASS'] }), 10).gates.filter(
      (g) => !g.pass,
    );
    expect(failed.map((g) => g.name)).toContain('no bypass');
  });
});

describe('honesty rules', () => {
  it('refuses to format a missing measured value', () => {
    expect(() => num(Number.NaN, 2, 'k1 p99')).toThrow('missing measured value: k1 p99');
    expect(num(1.234, 2, 'x')).toBe('1.23');
  });

  async function runDir(withSummary: boolean, p99: number | undefined): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'pulsegate-bench-'));
    dirs.push(dir);
    const meta = {
      profile: 'quick',
      startedAt: '2026-10-24T00:00:00.000Z',
      host: { cpuModel: 'Test CPU', logicalCpus: 4, memoryBytes: 8 * 1024 ** 3, os: 'test' },
      docker: {
        serverVersion: '29',
        operatingSystem: 'test',
        cpus: 4,
        memoryBytes: 4 * 1024 ** 3,
        composeVersion: '2',
      },
      limits: { gateway: { cpus: 2, memory: '512m' } },
      versions: { node: 'v26' },
      git: { commit: 'abc', dirtyFiles: 0 },
      workloadHashes: { 'config/routes.bench.yaml': 'f00' },
    };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
    const summary: K6Summary = {
      metrics: {
        'http_reqs{phase:measure}': { values: { count: 2 } },
        'http_req_duration{phase:measure}': {
          values: {
            avg: 1,
            med: 1,
            'p(90)': 1,
            'p(95)': 1,
            ...(p99 === undefined ? {} : { 'p(99)': p99 }),
            max: 2,
          },
        },
      },
    };
    if (withSummary) await writeFile(join(dir, 'k1-r50.summary.json'), JSON.stringify(summary));
    const point = (metric: string, value: number, tags: Record<string, string>) =>
      JSON.stringify({
        type: 'Point',
        metric,
        data: { time: '2026-10-24T00:00:01.000Z', value, tags },
      });
    const raw = [
      point('pg_responses', 1, {
        route: 'bench-plain',
        status: '200',
        cache: '-',
        phase: 'measure',
      }),
      point('pg_responses', 1, {
        route: 'bench-plain',
        status: '200',
        cache: '-',
        phase: 'measure',
      }),
      point('http_req_duration', 1, { status: '200', phase: 'measure' }),
    ].join('\n');
    await writeFile(join(dir, 'k1-r50.k6.json.gz'), gzipSync(raw));
    await writeFile(join(dir, 'k1-r50.exit'), '0\n');
    await writeFile(join(dir, 'k1-r50.before.metrics.txt'), '');
    await writeFile(
      join(dir, 'k1-r50.after.metrics.txt'),
      'pulsegate_requests_total{route="bench-plain",status_class="2xx",code="none"} 2\n',
    );
    await writeFile(
      join(dir, 'k1-r50.before.orders.json'),
      JSON.stringify({ total: 0, byPath: {} }),
    );
    await writeFile(
      join(dir, 'k1-r50.after.orders.json'),
      JSON.stringify({ total: 2, byPath: { '/bench/plain/item': 2 } }),
    );
    await writeFile(join(dir, 'k1-r50.before.admin.json'), '{}');
    await writeFile(join(dir, 'k1-r50.after.admin.json'), '{}');
    return dir;
  }

  it('writes a report from complete raw files, with environment and checksums', async () => {
    const { markdown, failed } = await generate(await runDir(true, 1.5));
    expect(failed).toEqual([]);
    expect(markdown).toContain('Test CPU (4 logical CPUs)');
    expect(markdown).toContain('| k1-r50 | 50 rps, fixed 1 KiB body |');
    expect(markdown).toContain('k1-r50.k6.json.gz');
    expect(markdown).toContain('**Quick profile:**');
  });

  it('refuses when a measured statistic is missing', async () => {
    await expect(generate(await runDir(true, undefined))).rejects.toThrow(
      'missing measured value: k1-r50 p99',
    );
  });

  it('refuses when a raw file is missing', async () => {
    const dir = await runDir(true, 1);
    await rm(join(dir, 'k1-r50.after.orders.json'));
    await expect(generate(dir)).rejects.toThrow('missing raw file: k1-r50.after.orders.json');
  });

  it('refuses an empty run', async () => {
    await expect(generate(await runDir(false, 1))).rejects.toThrow('no scenario summaries');
  });

  it('reads per-subject timings and the measured span from raw k6 output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pulsegate-raw-'));
    dirs.push(dir);
    const line = (time: string, value: number, status: string) =>
      JSON.stringify({
        type: 'Point',
        metric: 'http_req_duration',
        data: { time, value, tags: { status, subject: '3', phase: 'measure' } },
      });
    await writeFile(
      join(dir, 'x.gz'),
      gzipSync(
        [
          line('2026-10-24T00:00:00.010Z', 10, '200'),
          line('2026-10-24T00:00:02.005Z', 5, '429'),
        ].join('\n'),
      ),
    );
    const raw = await readRaw(join(dir, 'x.gz'));
    expect(raw.bySubject.get('3')?.map((r) => [r.durationMs, r.status])).toEqual([
      [10, 200],
      [5, 429],
    ]);
    expect(raw.measureSpanMs).toBe(2005);
  });
});

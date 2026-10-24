// Shared helpers for the k6 suite (docs/plans/real-data-testing.md §3, §3a; ADR-0046).
// Every scenario: an open model (arrival-rate executors), a warm-up phase tagged phase=warmup that the report excludes
// from latency statistics, and a measured phase tagged phase=measure. Thresholds gate correctness only; latency and
// throughput are informational until there is repeatable baseline data.
import { Counter } from 'k6/metrics';

export const PROFILE = __ENV.BENCH_PROFILE === 'full' ? 'full' : 'quick';
const WINDOWS = { full: { warmup: 15, measure: 60 }, quick: { warmup: 5, measure: 10 } };
export const WINDOW = WINDOWS[PROFILE];

export const GATEWAY = __ENV.GATEWAY_URL || 'http://gateway:8080';
export const GATEWAY_2 = __ENV.GATEWAY_2_URL || 'http://gateway-2:8080';
export const ORDERS_MOCK = 'http://orders-mock:4001';
/** Fixed 1 KiB body, identical with and without the gateway (§3a). */
export const FIXED_BODY = '_bytes=1024&_contentLength=1';

/** One point per response with route, status and X-Cache, for reconciliation in scripts/bench-report.ts. */
export const responses = new Counter('pg_responses');

export function record(res, tags) {
  responses.add(1, {
    status: String(res.status),
    cache: res.headers['X-Cache'] || '-',
    ...tags,
  });
}

export const SUMMARY_TREND_STATS = ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'];

/** Warm-up then measured constant-arrival-rate scenarios for one rate. */
export function steadyScenarios(prefix, exec, rate, extraTags = {}) {
  const vus = Math.max(20, Math.ceil(rate / 10));
  const base = {
    executor: 'constant-arrival-rate',
    rate,
    timeUnit: '1s',
    preAllocatedVUs: vus,
    maxVUs: vus * 10,
    exec,
  };
  return {
    [`${prefix}warmup`]: {
      ...base,
      duration: `${WINDOW.warmup}s`,
      tags: { phase: 'warmup', ...extraTags },
    },
    [`${prefix}measure`]: {
      ...base,
      startTime: `${WINDOW.warmup}s`,
      duration: `${WINDOW.measure}s`,
      tags: { phase: 'measure', ...extraTags },
    },
  };
}

/**
 * Informational thresholds: they never fail (`>= 0`), but make k6 compute the measured-phase submetrics for the summary.
 * Correctness thresholds are passed in by each scenario.
 */
export function thresholds(correctness = {}) {
  return {
    'http_req_duration{phase:measure}': ['max>=0'],
    'http_req_failed{phase:measure}': ['rate>=0'],
    'http_reqs{phase:measure}': ['count>=0'],
    'dropped_iterations{phase:measure}': ['count>=0'],
    ...correctness,
  };
}

export function options(scenarios, correctness = {}) {
  return {
    scenarios,
    thresholds: thresholds(correctness),
    summaryTrendStats: SUMMARY_TREND_STATS,
    discardResponseBodies: true,
    // Fewer tags on every sample keeps the raw output small; route/subject/phase come from scenario and record() tags.
    systemTags: ['status', 'method', 'scenario', 'expected_response'],
  };
}

/** handleSummary: the full k6 summary as JSON in the run directory, plus one line on stdout. */
export function summaryTo(name) {
  return (data) => ({
    [`/out/${name}.summary.json`]: JSON.stringify(data, null, 2),
    stdout: `${name}: ${String(data.metrics.http_reqs ? data.metrics.http_reqs.values.count : 0)} requests\n`,
  });
}

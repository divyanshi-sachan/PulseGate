// K8 (Redis limiter, ADR-0034): MODE=shared alternates requests between both instances for one subject against
// C = 20, rho = 4/s (the expectation is derived in the report); MODE=throughput sends RATE through 1 or 2 instances
// (INSTANCES), latency informational.
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import {
  FIXED_BODY,
  GATEWAY,
  GATEWAY_2,
  PROFILE,
  options as buildOptions,
  record,
  steadyScenarios,
  summaryTo,
} from './lib.js';

const MODE = __ENV.MODE === 'throughput' ? 'throughput' : 'shared';
const INSTANCES = __ENV.INSTANCES === '1' ? 1 : 2;
const RATE = Number(__ENV.RATE || (PROFILE === 'full' ? '500' : '100'));
const SHARED_DURATION = PROFILE === 'full' ? 30 : 10;

const scenarios =
  MODE === 'shared'
    ? {
        shared: {
          executor: 'constant-arrival-rate',
          rate: 40,
          timeUnit: '1s',
          duration: `${String(SHARED_DURATION)}s`,
          preAllocatedVUs: 10,
          maxVUs: 50,
          exec: 'shared',
          tags: { phase: 'measure', subject: 'k6' },
        },
      }
    : steadyScenarios('', 'throughput', RATE, { instances: String(INSTANCES) });

export const options = buildOptions(scenarios, { checks: ['rate==1'] });

function target() {
  return INSTANCES === 1 || exec.scenario.iterationInTest % 2 === 0 ? GATEWAY : GATEWAY_2;
}

export function shared() {
  const res = http.get(`${target()}/bench/shared/item?${FIXED_BODY}`);
  record(res, { route: 'bench-shared', subject: 'k6' });
  check(res, { 'only 200 or 429': (r) => r.status === 200 || r.status === 429 });
}

export function throughput() {
  const res = http.get(`${target()}/bench/plain/item?${FIXED_BODY}`);
  record(res, { route: 'bench-redis-plain' });
  check(res, { 'status 200': (r) => r.status === 200 });
}

export const handleSummary = summaryTo(__ENV.RUN_NAME || `redis-${MODE}`);

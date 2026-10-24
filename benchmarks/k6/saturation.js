// K9 (full profile only, informational): ramp the offered rate on bench-plain and let the report find where p99 > 100 ms
// or errors > 1 % per second. Reported as observed; never claimed as a capacity.
import http from 'k6/http';
import { check } from 'k6';
import { FIXED_BODY, GATEWAY, options as buildOptions, record, summaryTo } from './lib.js';

const MAX = Number(__ENV.MAX_RATE || '4000');

export const options = buildOptions(
  {
    measure: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 2000,
      stages: [{ target: MAX, duration: '90s' }],
      exec: 'hit',
      tags: { phase: 'measure' },
    },
  },
  {},
);

export function hit() {
  const res = http.get(`${GATEWAY}/bench/plain/item?${FIXED_BODY}`);
  record(res, { route: 'bench-plain' });
  check(res, { 'status 200': (r) => r.status === 200 });
}

export const handleSummary = summaryTo(__ENV.RUN_NAME || 'saturation');

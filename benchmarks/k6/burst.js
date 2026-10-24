// K2: a burst against a limited route (capacity 100, refill 50/s, one subject: the k6 container's IP).
// 50 rps, a ramp to 10x, hold, back to 50. Correctness: no 5xx; only 200 or 429.
import http from 'k6/http';
import { check } from 'k6';
import {
  FIXED_BODY,
  GATEWAY,
  PROFILE,
  WINDOW,
  options as buildOptions,
  record,
  summaryTo,
} from './lib.js';

const S = PROFILE === 'full' ? 20 : 5;
const base = {
  executor: 'ramping-arrival-rate',
  timeUnit: '1s',
  preAllocatedVUs: 50,
  maxVUs: 500,
  exec: 'hit',
};

export const options = buildOptions(
  {
    warmup: {
      ...base,
      startRate: 50,
      stages: [{ target: 50, duration: `${WINDOW.warmup}s` }],
      tags: { phase: 'warmup' },
    },
    measure: {
      ...base,
      startTime: `${WINDOW.warmup}s`,
      startRate: 50,
      stages: [
        { target: 50, duration: `${S}s` },
        { target: 500, duration: `${Math.max(1, S / 4)}s` },
        { target: 500, duration: `${S}s` },
        { target: 50, duration: `${Math.max(1, S / 4)}s` },
        { target: 50, duration: `${S}s` },
      ],
      tags: { phase: 'measure' },
    },
  },
  { checks: ['rate==1'] },
);

export function hit() {
  const res = http.get(`${GATEWAY}/bench/burst/item?${FIXED_BODY}`);
  record(res, { route: 'bench-burst' });
  check(res, { 'only 200 or 429': (r) => r.status === 200 || r.status === 429 });
}

export const handleSummary = summaryTo(__ENV.RUN_NAME || 'burst');

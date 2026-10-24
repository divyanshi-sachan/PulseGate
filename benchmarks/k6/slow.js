// K6: a slow upstream (300 ms) behind a 1 s route timeout. Correctness: every response 200 (no timeout below the limit).
import http from 'k6/http';
import { check } from 'k6';
import {
  FIXED_BODY,
  GATEWAY,
  PROFILE,
  options as buildOptions,
  record,
  steadyScenarios,
  summaryTo,
} from './lib.js';

const RATE = PROFILE === 'full' ? 100 : 30;

export const options = buildOptions(steadyScenarios('', 'hit', RATE), { checks: ['rate==1'] });

export function hit() {
  const res = http.get(`${GATEWAY}/bench/slow/item?_delay=300&${FIXED_BODY}`);
  record(res, { route: 'bench-slow' });
  check(res, { 'status 200': (r) => r.status === 200 });
}

export const handleSummary = summaryTo(__ENV.RUN_NAME || 'slow');

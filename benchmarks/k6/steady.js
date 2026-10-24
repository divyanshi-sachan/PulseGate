// K0 (TARGET=direct: k6 -> mock) and K1 (TARGET=gateway: k6 -> gateway -> mock) at RATE requests/s (§3a: same path,
// fixed 1 KiB body, same arrival rate, VUs and windows; run back to back by scripts/bench.sh).
import http from 'k6/http';
import { check } from 'k6';
import {
  FIXED_BODY,
  GATEWAY,
  ORDERS_MOCK,
  options as buildOptions,
  record,
  steadyScenarios,
  summaryTo,
} from './lib.js';

const TARGET = __ENV.TARGET === 'direct' ? 'direct' : 'gateway';
const RATE = Number(__ENV.RATE || '100');
const URL = `${TARGET === 'direct' ? ORDERS_MOCK : GATEWAY}/bench/plain/item?${FIXED_BODY}`;
const NAME = __ENV.RUN_NAME || `steady-${TARGET}-${String(RATE)}`;

export const options = buildOptions(steadyScenarios('', 'hit', RATE, { target: TARGET }), {
  // Correctness: every response is a 200 with the fixed body.
  checks: ['rate==1'],
});

export function hit() {
  const res = http.get(URL);
  record(res, { route: 'bench-plain', target: TARGET });
  check(res, { 'status 200': (r) => r.status === 200 });
}

export const handleSummary = summaryTo(NAME);

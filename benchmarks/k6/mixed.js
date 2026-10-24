// K3: mixed routes at fixed shares of the total rate: 60 % cached read, 20 % authenticated read, 10 % write,
// 10 % public read. Correctness: every response 200; the per-route share is checked in the report.
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

const TOTAL = PROFILE === 'full' ? 300 : 60;
const KEYS = JSON.parse(open('/out/keys.json'));
export const SHARES = {
  'bench-cached': 0.6,
  'bench-auth': 0.2,
  'bench-write': 0.1,
  'bench-plain': 0.1,
};

export const options = buildOptions(
  {
    ...steadyScenarios('cached_', 'cached', TOTAL * SHARES['bench-cached'], {
      route: 'bench-cached',
    }),
    ...steadyScenarios('auth_', 'auth', TOTAL * SHARES['bench-auth'], { route: 'bench-auth' }),
    ...steadyScenarios('write_', 'write', TOTAL * SHARES['bench-write'], { route: 'bench-write' }),
    ...steadyScenarios('plain_', 'plain', TOTAL * SHARES['bench-plain'], { route: 'bench-plain' }),
  },
  { checks: ['rate==1'] },
);

function ok(res, route) {
  record(res, { route });
  check(res, { 'status 200': (r) => r.status === 200 });
}

export function cached() {
  ok(http.get(`${GATEWAY}/bench/cached/mixed?${FIXED_BODY}`), 'bench-cached');
}
export function auth() {
  ok(
    http.get(`${GATEWAY}/bench/auth/item?${FIXED_BODY}`, { headers: { 'x-api-key': KEYS.auth } }),
    'bench-auth',
  );
}
export function write() {
  ok(
    http.post(`${GATEWAY}/bench/write/item?${FIXED_BODY}`, '{"order":1}', {
      headers: { 'content-type': 'application/json' },
    }),
    'bench-write',
  );
}
export function plain() {
  ok(http.get(`${GATEWAY}/bench/plain/item?${FIXED_BODY}`), 'bench-plain');
}

export const handleSummary = summaryTo(__ENV.RUN_NAME || 'mixed');

// K7: 20 % of upstream answers fail, with up to 3 attempts and a breaker on flaky-service. Correctness: only 200, a
// passed-through upstream 503, or a gateway CIRCUIT_OPEN 503; the gateway stays up (checked by scripts/bench.sh).
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

const RATE = PROFILE === 'full' ? 200 : 50;

export const options = buildOptions(steadyScenarios('', 'hit', RATE), { checks: ['rate==1'] });

export function hit() {
  const res = http.get(`${GATEWAY}/bench/flaky/item?_failRate=0.2&${FIXED_BODY}`);
  record(res, { route: 'bench-flaky' });
  check(res, { 'only 200 or 503': (r) => r.status === 200 || r.status === 503 });
}

export const handleSummary = summaryTo(__ENV.RUN_NAME || 'failing');

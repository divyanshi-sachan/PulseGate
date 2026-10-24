// K4: cache hits on one fixed key (§3a). scripts/bench.sh warms the entry until X-Cache: HIT before the snapshots;
// the report reconciles k6's X-Cache tally with /metrics and the mock's own request counter.
// Requests never send Cache-Control, Pragma or Authorization, so nothing bypasses the cache.
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

const RATE = PROFILE === 'full' ? 500 : 100;
export const PATH = `/bench/cached/k4?${FIXED_BODY}`;

export const options = buildOptions(steadyScenarios('', 'hit', RATE), { checks: ['rate==1'] });

export function hit() {
  const res = http.get(`${GATEWAY}${PATH}`);
  record(res, { route: 'bench-cached' });
  check(res, { 'status 200 and HIT': (r) => r.status === 200 && r.headers['X-Cache'] === 'HIT' });
}

export const handleSummary = summaryTo(__ENV.RUN_NAME || 'cache');

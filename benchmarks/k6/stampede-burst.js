// Q13-A (docs/plans/q13-stampede.md): N simultaneous requests on one cold key (KEY makes the path unique per
// repetition), upstream delay 300 ms. Without coalescing every request is a miss: the report expects exactly N upstream
// calls, and checks that all requests started within the upstream delay.
import http from 'k6/http';
import { check } from 'k6';
import { GATEWAY, options as buildOptions, record, summaryTo } from './lib.js';

const N = Number(__ENV.N || '50');
const KEY = __ENV.KEY || 'burst';

export const options = buildOptions(
  {
    burst: {
      executor: 'per-vu-iterations',
      vus: N,
      iterations: 1,
      maxDuration: '30s',
      exec: 'hit',
      tags: { phase: 'measure' },
    },
  },
  { checks: ['rate==1'] },
);

export function hit() {
  const res = http.get(`${GATEWAY}/bench/stampede/${KEY}?_delay=300&_bytes=65536&_contentLength=1`);
  record(res, { route: 'bench-stampede' });
  check(res, {
    '200 with the 64 KiB body': (r) => r.status === 200 && r.headers['Content-Length'] === '65536',
  });
}

export const handleSummary = summaryTo(__ENV.RUN_NAME || `stampede-burst-${String(N)}`);

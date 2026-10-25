// Q13-B (DELAY=300, the expiry herd) and Q13-C (DELAY=1, the control): one hot key at a constant rate, TTL 2 s, so it
// refills about every 2 s. The report clusters MISS responses into refills and counts upstream calls per refill.
import http from 'k6/http';
import { check } from 'k6';
import {
  GATEWAY,
  PROFILE,
  options as buildOptions,
  record,
  steadyScenarios,
  summaryTo,
} from './lib.js';

const DELAY = Number(__ENV.DELAY || '300');
const RATE = Number(__ENV.RATE || (PROFILE === 'full' ? '500' : '200'));
const PATH = DELAY === 1 ? 'control' : 'herd';
const URL = `${GATEWAY}/bench/stampede/${PATH}?_delay=${String(DELAY)}&_bytes=65536&_contentLength=1`;

export const options = buildOptions(steadyScenarios('', 'hit', RATE, { delay: String(DELAY) }), {
  checks: ['rate==1'],
});

export function hit() {
  const res = http.get(URL);
  record(res, { route: 'bench-stampede' });
  check(res, {
    '200 with the 64 KiB body': (r) => r.status === 200 && r.headers['Content-Length'] === '65536',
  });
}

export const handleSummary = summaryTo(__ENV.RUN_NAME || `stampede-herd-${String(DELAY)}`);

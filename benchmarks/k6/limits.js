// K5: 10 subjects (distinct API keys = 10 buckets) at 20 rps each against C = 10, rho = 2/s. No warm-up: it would spend
// tokens. The expected accepted count per subject is derived in scripts/bench-report.ts from the measured timings (§3a).
import http from 'k6/http';
import { check } from 'k6';
import { FIXED_BODY, GATEWAY, PROFILE, options as buildOptions, record, summaryTo } from './lib.js';

const KEYS = JSON.parse(open('/out/keys.json'));
const SUBJECTS = 10;
const DURATION = PROFILE === 'full' ? 30 : 10;

const scenarios = {};
for (let i = 0; i < SUBJECTS; i++) {
  scenarios[`subject_${String(i)}`] = {
    executor: 'constant-arrival-rate',
    rate: 20,
    timeUnit: '1s',
    duration: `${String(DURATION)}s`,
    preAllocatedVUs: 5,
    maxVUs: 50,
    exec: 'hit',
    env: { SUBJECT: String(i) },
    tags: { phase: 'measure', subject: String(i) },
  };
}

export const options = buildOptions(scenarios, { checks: ['rate==1'] });

export function hit() {
  const subject = __ENV.SUBJECT;
  const res = http.get(`${GATEWAY}/bench/limited/item?${FIXED_BODY}`, {
    headers: { 'x-api-key': KEYS.limited[Number(subject)] },
  });
  record(res, { route: 'bench-limited', subject });
  check(res, { 'only 200 or 429': (r) => r.status === 200 || r.status === 429 });
}

export const handleSummary = summaryTo(__ENV.RUN_NAME || 'limits');

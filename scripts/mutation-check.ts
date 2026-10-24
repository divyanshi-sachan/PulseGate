/**
 * Curated mutation suite: each entry re-introduces a specific bug the test suite must catch.
 * For every mutation the target tests must first PASS unmutated (baseline) and then FAIL mutated
 * ("killed"). A surviving mutation, a missing pattern or a red baseline fails the run.
 *
 *   pnpm test:mutations            (Redis mutations need Docker; REQUIRE_REDIS_TESTS=1 is set for them)
 *   pnpm test:mutations retry-post (only mutations whose id contains the filter)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

interface Mutation {
  id: string;
  /** Why this matters (ADR reference). */
  guards: string;
  file: string;
  find: string;
  replace: string;
  /** Test files or directories that must catch it. */
  tests: string[];
  redis?: boolean;
}

const NON_ATOMIC_CONSUME = `    // MUTATION: non-atomic read-modify-write instead of the Lua script.
    const k = redisBucketKey(key);
    const [t, ts] = await this.#redis.hmget(k, 'tokens', 'ts');
    const now = Date.now();
    let tokens = t === null || ts === null ? policy.capacity : Math.min(policy.capacity, Number(t) + ((now - Number(ts)) / 1000) * policy.refillRatePerSecond);
    const allowed = tokens >= 1;
    if (allowed) tokens -= 1;
    await this.#redis.hset(k, 'tokens', String(tokens), 'ts', String(now));
    return decisionFromTokens(allowed, tokens, policy);
`;

const MUTATIONS: Mutation[] = [
  {
    id: 'dot-segments-allowed',
    guards: 'ADR-0019: dot segments must be rejected before routing',
    file: 'apps/gateway/src/routing/request-target.ts',
    find: "    if (decodedDots === '.' || decodedDots === '..') {",
    replace: '    if (false) {',
    tests: ['apps/gateway/src/routing', 'apps/gateway/test/proxy.test.ts'],
  },
  {
    id: 'api-key-forwarded',
    guards: 'ADR-0021: X-API-Key must never reach the upstream',
    file: 'apps/gateway/src/proxy/headers.ts',
    find: "  'x-api-key',\n",
    replace: '',
    tests: ['apps/gateway/src/proxy', 'apps/gateway/test/proxy.test.ts'],
  },
  {
    id: 'xff-trusted-from-anyone',
    guards: 'ADR-0021: X-Forwarded-For only from trusted proxies',
    file: 'apps/gateway/src/proxy/client-address.ts',
    find: 'if (!trusted.has(peer) ||',
    replace: 'if (false ||',
    tests: ['apps/gateway/src/proxy', 'apps/gateway/test/phase2-hardening.test.ts'],
  },
  {
    id: 'expired-keys-accepted',
    guards: 'ADR-0031: expired keys must be rejected',
    file: 'apps/gateway/src/auth/authenticator.ts',
    find: '    if (entry.expiresAtMs !== undefined && this.#now() >= entry.expiresAtMs) {',
    replace: '    if (false) {',
    tests: ['apps/gateway/src/auth', 'apps/gateway/test/phase2-hardening.test.ts'],
  },
  {
    id: 'one-bucket-for-everyone',
    guards: 'ADR-0032: budgets are per route and per caller',
    file: 'apps/gateway/src/app.ts',
    find: 'limiter.consume(`${match.route.id}:${subject}`',
    replace: 'limiter.consume(`${match.route.id}`',
    tests: ['apps/gateway/test/auth-ratelimit.test.ts'],
  },
  {
    id: 'never-429',
    guards: 'ADR-0032: an empty bucket rejects with 429',
    file: 'apps/gateway/src/app.ts',
    find: "        throw new GatewayError('RATE_LIMIT_EXCEEDED');",
    replace: '        // mutated',
    tests: ['apps/gateway/test/auth-ratelimit.test.ts'],
  },
  {
    id: 'rate-headers-on-success-only',
    guards: 'ADR-0032: limit headers on every response after the limit check',
    file: 'apps/gateway/src/app.ts',
    find: '      void reply.headers(rateHeaders);',
    replace: '',
    tests: ['apps/gateway/test/phase2-hardening.test.ts'],
  },
  {
    id: 'unbounded-buckets',
    guards: 'ADR-0032: local bucket store is capped',
    file: 'packages/rate-limiter/src/local-limiter.ts',
    find: 'if (this.#buckets.size >= this.#maxBuckets) this.#evictLeastRecentlyUsed();',
    replace: '',
    tests: ['packages/rate-limiter/src', 'apps/gateway/test/phase2-hardening.test.ts'],
  },
  {
    id: 'retry-post',
    guards: 'ADR-0033: only GET/HEAD/OPTIONS are retried',
    file: 'packages/reliability/src/retry.ts',
    find: "new Set(['GET', 'HEAD', 'OPTIONS'])",
    replace: "new Set(['GET', 'HEAD', 'OPTIONS', 'POST'])",
    tests: ['packages/reliability', 'apps/gateway/test/reliability.test.ts'],
  },
  {
    id: 'breaker-ignored-between-retries',
    guards: 'ADR-0024/0033: the breaker is checked before every attempt',
    file: 'apps/gateway/src/proxy/proxy-service.ts',
    find: '    const next = breaker.tryAcquire();',
    replace:
      '    const next = { allowed: true as const, permit: { success() {}, failure() {}, release() {} } };',
    tests: ['apps/gateway/test/reliability.test.ts'],
  },
  {
    id: 'upstream-4xx-counted',
    guards: 'ADR-0024: upstream 4xx never count as breaker failures',
    file: 'apps/gateway/src/proxy/proxy-service.ts',
    find: '      const failureStatus = upstream.config.circuitBreaker.failureStatuses.includes(\n',
    replace:
      '      const failureStatus = response.statusCode >= 400 || upstream.config.circuitBreaker.failureStatuses.includes(\n',
    tests: ['apps/gateway/test/reliability.test.ts'],
  },
  {
    id: 'no-deadline-precheck',
    guards: 'ADR-0033: fail fast when the backoff would overrun the deadline',
    file: 'apps/gateway/src/proxy/proxy-service.ts',
    find: '    if (performance.now() + delay >= deadlineAt) return undefined;',
    replace: '',
    tests: ['apps/gateway/test/reliability.test.ts'],
  },
  {
    id: 'cache-ignores-client',
    guards: 'ADR-0035: auth-route cache entries are partitioned by client',
    file: 'packages/cache/src/policy.ts',
    find: "return policy.scope === 'shared' || clientId === undefined ? 'shared' : `client:${clientId}`;",
    replace: "return 'shared';",
    tests: ['packages/cache', 'apps/gateway/test/cache.test.ts'],
  },
  {
    id: 'cache-stores-private',
    guards: 'ADR-0009/0036: Cache-Control private responses are never stored',
    file: 'packages/cache/src/policy.ts',
    find: "['no-store', 'no-cache', 'private']",
    replace: "['no-store', 'no-cache']",
    tests: ['packages/cache', 'apps/gateway/test/cache.test.ts'],
  },
  {
    id: 'cache-stores-set-cookie',
    guards: 'ADR-0036: responses that set cookies are personalized and never stored',
    file: 'packages/cache/src/policy.ts',
    find: "  if (headers['set-cookie'] !== undefined) return { storable: false, reason: 'set-cookie' };\n",
    replace: '',
    tests: ['packages/cache', 'apps/gateway/test/cache.test.ts'],
  },
  {
    id: 'cache-with-forwarded-authorization',
    guards: 'ADR-0035: forwarded Authorization always bypasses the cache',
    file: 'packages/cache/src/policy.ts',
    find: "  if (forwardsAuthorization && headers['authorization'] !== undefined)\n    return 'authorization-forwarded';\n",
    replace: '',
    tests: ['packages/cache', 'apps/gateway/test/cache.test.ts'],
  },
  {
    id: 'cache-ignores-age',
    guards: 'ADR-0036 review: entries never outlive upstream freshness (Age is subtracted)',
    file: 'packages/cache/src/policy.ts',
    find: '  const ttlSeconds = Math.min(policy.ttlSeconds, lifetime ?? Infinity) - age;',
    replace: '  const ttlSeconds = Math.min(policy.ttlSeconds, lifetime ?? Infinity);',
    tests: ['packages/cache', 'apps/gateway/test/cache.test.ts'],
  },
  {
    id: 'cache-ignores-expires',
    guards: 'ADR-0036 review: Expires bounds freshness when max-age is absent',
    file: 'packages/cache/src/policy.ts',
    find: "    const expires = first(headers['expires']);",
    replace: '    const expires = undefined as string | undefined;',
    tests: ['packages/cache', 'apps/gateway/test/cache.test.ts'],
  },
  {
    id: 'cache-ignores-response-pragma',
    guards: 'ADR-0036 review: Pragma: no-cache prohibits storage without Cache-Control',
    file: 'packages/cache/src/policy.ts',
    find: "  if (headers['cache-control'] === undefined && /no-cache/i.test(first(headers['pragma']) ?? '')) {",
    replace: '  if (false) {',
    tests: ['packages/cache'],
  },
  {
    id: 'cache-stores-incomplete-body',
    guards: 'ADR-0036 review: a body whose upstream stream failed is never stored',
    file: 'apps/gateway/src/proxy/proxy-service.ts',
    find: '      if (error instanceof Error) {\n        permit?.failure();',
    replace:
      '      if (error instanceof Error) {\n        if (sink !== undefined && !overflow) sink.complete(Buffer.concat(collected));\n        permit?.failure();',
    tests: ['apps/gateway/test/cache.test.ts'],
  },
  {
    id: 'metrics-unbounded-route-label',
    guards: 'ADR-0036: metric labels come only from bounded sets',
    file: 'packages/observability/src/metrics.ts',
    find: "    return id !== undefined && this.#routes.has(id) ? id : 'unmatched';",
    replace: "    return id ?? 'unmatched';",
    tests: ['packages/observability'],
  },
  {
    id: 'redis-non-atomic',
    guards: 'ADR-0005/0034: one atomic script decides; concurrent callers cannot double-spend',
    file: 'packages/rate-limiter/src/redis-limiter.ts',
    find: '    const args = [redisBucketKey(key), String(policy.capacity), String(policy.refillRatePerSecond)];\n',
    replace: NON_ATOMIC_CONSUME,
    tests: ['packages/rate-limiter/test', 'apps/gateway/test/redis.test.ts'],
    redis: true,
  },
  {
    id: 'redis-ttl-without-margin',
    guards: 'ADR-0034 review: buckets must never expire before refilling',
    file: 'packages/rate-limiter/src/redis-script.ts',
    find: 'math.ceil((capacity - tokens) / rate * 1000) + 1000',
    replace: 'math.ceil((capacity - tokens) / rate * 1000)',
    tests: ['packages/rate-limiter/test'],
    redis: true,
  },
  {
    id: 'fail-open-unlimited',
    guards: 'ADR-0034: fail-open falls back to bounded local buckets',
    file: 'packages/rate-limiter/src/resilient-limiter.ts',
    find: 'return { ...this.#fallback.consumeSync(key, policy), degraded: true };',
    replace:
      'return { allowed: true, limit: policy.capacity, remaining: policy.capacity, retryAfterMs: 0, resetAfterMs: 0, degraded: true };',
    tests: ['packages/rate-limiter/src', 'apps/gateway/test/redis.test.ts'],
    redis: true,
  },
  {
    id: 'ready-despite-redis-down',
    guards: 'ADR-0034: fail-closed readiness reflects Redis',
    file: 'apps/gateway/src/app.ts',
    find: "? { ready: false, body: { status: 'not_ready', redis: 'unavailable' } }",
    replace: "? { ready: true, body: { status: 'not_ready', redis: 'unavailable' } }",
    tests: ['apps/gateway/test/redis.test.ts'],
    redis: true,
  },
];

function runTests(tests: string[], redis: boolean): boolean {
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...tests], {
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, ...(redis ? { REQUIRE_REDIS_TESTS: '1' } : {}) },
  });
  return result.status === 0;
}

const filter = process.argv[2];
const selected = MUTATIONS.filter(
  (mutation) => filter === undefined || mutation.id.includes(filter),
);
const baselines = new Map<string, boolean>();
const problems: string[] = [];
const originals = new Map<string, string>();

function restoreAll(): void {
  for (const [file, content] of originals) writeFileSync(file, content);
}
process.on('SIGINT', () => {
  restoreAll();
  process.exit(130);
});

for (const mutation of selected) {
  const label = mutation.id.padEnd(34);
  const baselineKey = `${String(mutation.redis === true)}:${mutation.tests.join(' ')}`;
  if (!baselines.has(baselineKey))
    baselines.set(baselineKey, runTests(mutation.tests, mutation.redis === true));
  if (baselines.get(baselineKey) !== true) {
    problems.push(
      `${mutation.id}: baseline tests fail unmutated (fix the suite, or start Docker for Redis)`,
    );
    console.log(`${label} BASELINE RED`);
    continue;
  }

  const original = readFileSync(mutation.file, 'utf8');
  const occurrences = original.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    problems.push(
      `${mutation.id}: pattern found ${String(occurrences)}× in ${mutation.file} (update the mutation)`,
    );
    console.log(`${label} PATTERN ${occurrences === 0 ? 'MISSING' : 'AMBIGUOUS'}`);
    continue;
  }
  originals.set(mutation.file, original);
  try {
    writeFileSync(mutation.file, original.replace(mutation.find, mutation.replace));
    const survived = runTests(mutation.tests, mutation.redis === true);
    console.log(`${label} ${survived ? 'SURVIVED' : 'killed'}  (${mutation.guards})`);
    if (survived) problems.push(`${mutation.id} survived: ${mutation.guards}`);
  } finally {
    writeFileSync(mutation.file, original);
    originals.delete(mutation.file);
  }
}

if (problems.length > 0) {
  console.error(`\n${String(problems.length)} problem(s):\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\nAll ${String(selected.length)} mutations killed.`);

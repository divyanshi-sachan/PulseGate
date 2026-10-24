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
    id: 'stats-reservoir-first-512-only',
    guards: 'plan §2.1: the reservoir keeps sampling after it is full (no first-512 bias)',
    file: 'packages/observability/src/stats-window.ts',
    find: '    if (j < RESERVOIR_SIZE) this.samples[base + j] = ms;',
    replace: '',
    tests: ['packages/observability'],
  },
  {
    id: 'stats-unweighted-window-merge',
    guards: 'plan §2.1: window percentiles weight each bucket by its traffic',
    file: 'packages/observability/src/stats-window.ts',
    find: '    const weight = seen / held;',
    replace: '    const weight = 1;',
    tests: ['packages/observability'],
  },
  {
    id: 'stats-raw-count-instead-of-ess',
    guards: 'plan §2.1: window confidence uses the effective sample size, not the retained count',
    file: 'packages/observability/src/stats-window.ts',
    find: '  const kish = effectiveSampleSize(weighted.map((s) => s.weight));',
    replace: '  const kish = weighted.length;',
    tests: ['packages/observability'],
  },
  {
    id: 'stats-zero-fill-before-start',
    guards: 'plan §2.4: time before the process started is omitted, not zero-filled',
    file: 'packages/observability/src/stats-window.ts',
    find: '    const oldest = Math.max(current - (BUCKET_COUNT - 1) * BUCKET_MS, firstCollecting);',
    replace: '    const oldest = current - (BUCKET_COUNT - 1) * BUCKET_MS;',
    tests: ['packages/observability'],
  },
  {
    id: 'stats-slot-reuse-leaks-counts',
    guards: 'plan §2: a reused ring slot starts from zero',
    file: 'packages/observability/src/stats-window.ts',
    find: '      this.counters.fill(0, index * this.width, (index + 1) * this.width);\n',
    replace: '',
    tests: ['packages/observability'],
  },
  {
    id: 'stats-rps-ignores-real-duration',
    guards: 'plan §2.3: rates divide by the real covered time',
    file: 'packages/observability/src/stats-window.ts',
    find: '    return Math.max(0, end - Math.max(start, this.#startedAt));',
    replace: '    return BUCKET_MS;',
    tests: ['packages/observability'],
  },
  {
    id: 'stats-bypass-in-hit-ratio',
    guards: 'plan §2.3: cache bypasses never enter the hit-ratio denominator',
    file: 'packages/observability/src/stats-math.ts',
    find: '    cacheHitRatio: ratio(c.cache.hit, lookups),',
    replace: '    cacheHitRatio: ratio(c.cache.hit, lookups + c.cache.bypass),',
    tests: ['packages/observability'],
  },
  {
    id: 'stats-zero-instead-of-null',
    guards: 'plan §2.3: a rate without a denominator is null, never 0',
    file: 'packages/observability/src/stats-math.ts',
    find: '  return denominator === 0 ? null : numerator / denominator;',
    replace: '  return denominator === 0 ? 0 : numerator / denominator;',
    tests: ['packages/observability'],
  },
  {
    id: 'stats-aborted-attempts-count-as-failures',
    guards: 'plan §2.3/ADR-0024: aborted attempts are neutral in the failure rate',
    file: 'packages/observability/src/stats-math.ts',
    find: '    upstreamFailureRate: ratio(c.attempts.failure, decidedAttempts),',
    replace: '    upstreamFailureRate: ratio(c.attempts.failure, allAttempts),',
    tests: ['packages/observability'],
  },
  {
    id: 'stats-confidence-old-tail-rule',
    guards:
      'ADR-0038 review 2: confidence needs the exact order-statistic threshold, not 5 tail samples',
    file: 'packages/observability/src/stats-math.ts',
    find: '  const enough = effective >= input.threshold;',
    replace: '  const enough = effective * (1 - input.q) >= 5;',
    tests: ['packages/observability'],
  },
  {
    id: 'stats-kish-only-window',
    guards:
      'ADR-0038 review 2: Kish alone misses heterogeneous buckets; the stratified bound must apply',
    file: 'packages/observability/src/stats-window.ts',
    find: '    const effectiveSamples = Math.min(kish, stratifiedEffectiveSamples(strata, q));',
    replace: '    const effectiveSamples = kish + 0 * stratifiedEffectiveSamples(strata, q);',
    tests: ['packages/observability'],
  },
  {
    id: 'stats-window-labeled-adequate',
    guards:
      'ADR-0038 review 2: a window merge has no exact guarantee, so it is at most "approximate"',
    file: 'packages/observability/src/stats-math.ts',
    find: "    confidence: !enough ? 'low' : input.scope === 'bucket' ? 'adequate' : 'approximate',",
    replace: "    confidence: !enough ? 'low' : 'adequate',",
    tests: ['packages/observability'],
  },
  {
    id: 'stats-normal-approximation-p99',
    guards:
      'ADR-0038 review 2: the normal approximation (1,522) gives only 94 % exact coverage at p99',
    file: 'packages/admin-contract/src/constants.ts',
    find: '  p99: 1707,',
    replace: '  p99: 1522,',
    tests: ['packages/observability'],
  },
  {
    id: 'stats-normal-approximation-p95',
    guards: 'ADR-0038 review 2: p95 = 457 dips below the coverage target before 484',
    file: 'packages/admin-contract/src/constants.ts',
    find: '  p95: 484,',
    replace: '  p95: 457,',
    tests: ['packages/observability'],
  },
  {
    id: 'stats-time-can-run-backwards',
    guards: 'ADR-0038 review: window time never runs backwards, so stale slots are never reused',
    file: 'packages/observability/src/stats-window.ts',
    find: '    this.#last = Math.max(this.#last, t);',
    replace: '    this.#last = t;',
    tests: ['packages/observability'],
  },
  {
    id: 'stats-counters-wrap',
    guards: 'ADR-0038 review: counters saturate at 2^32 - 1 instead of wrapping',
    file: 'packages/observability/src/stats-window.ts',
    find: '    this.counters[at] = Math.min(UINT32_MAX, (this.counters[at] ?? 0) + amount);',
    replace: '    this.counters[at] = (this.counters[at] ?? 0) + amount;',
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
    id: 'admin-auth-skipped-for-one-route',
    guards: 'plan §5: every admin route goes through the one Bearer-auth hook',
    file: 'apps/gateway/src/admin/admin-server.ts',
    find: '    if (verifier.verify(request.headers.authorization)) {',
    replace:
      "    if (request.url === '/admin/api/cache' || verifier.verify(request.headers.authorization)) {",
    tests: ['apps/gateway/test/admin.test.ts'],
  },
  {
    id: 'admin-short-token-accepted',
    guards: 'plan §5: startup fails on an ADMIN_TOKEN shorter than 32 characters',
    file: 'apps/gateway/src/admin/admin-token.ts',
    find: '    if (token.length < MIN_ADMIN_TOKEN_LENGTH) {',
    replace: '    if (token.length < 8) {',
    tests: ['apps/gateway/test/admin.test.ts'],
  },
  {
    id: 'admin-any-scheme-accepted',
    guards: 'ADR-0020: only `Authorization: Bearer <token>` authenticates',
    file: 'apps/gateway/src/admin/admin-token.ts',
    find: '    const match = /^Bearer ([^\\s]+)$/i.exec(authorization.trim());',
    replace: '    const match = /^(?:\\S+ )?([^\\s]+)$/i.exec(authorization.trim());',
    tests: ['apps/gateway/test/admin.test.ts'],
  },
  {
    id: 'admin-stats-without-token',
    guards: 'plan §2.2: the stats window is allocated only with the admin listener',
    file: 'apps/gateway/src/app.ts',
    find: '    verifier === undefined\n      ? undefined\n      : new StatsWindow({',
    replace: '    false\n      ? undefined\n      : new StatsWindow({',
    tests: ['apps/gateway/test/admin.test.ts'],
  },
  {
    id: 'admin-attempts-not-recorded',
    guards: 'plan §5: upstream attempt numbers in the admin API match socket traffic',
    file: 'apps/gateway/src/app.ts',
    find: '      stats?.recordAttempt({',
    replace: '      void ({',
    tests: ['apps/gateway/test/admin.test.ts'],
  },
  {
    id: 'admin-abort-counted-as-request',
    guards: 'plan §2.3: an aborted request is counted as aborted, without status or latency',
    file: 'apps/gateway/src/app.ts',
    find: "    if (code === 'CLIENT_ABORTED') stats.recordAborted(routeId);",
    replace: "    if (code === 'never') stats.recordAborted(routeId);",
    tests: ['apps/gateway/test/admin.test.ts'],
  },
  {
    id: 'ui-symlink-escapes-root',
    guards: 'plan §5: a resolved file must stay inside the real UI root (symlinks followed)',
    file: 'apps/gateway/src/admin/static-ui.ts',
    find: '    if (!real.startsWith(root + sep)) return undefined;',
    replace: "    if (!real.startsWith('/')) return undefined;",
    tests: ['apps/gateway/test/admin-ui.test.ts'],
  },
  {
    id: 'ui-segment-checks-skipped',
    guards: 'plan §5: decoded UI path segments never contain separators, NUL or a leading dot',
    file: 'apps/gateway/src/admin/static-ui.ts',
    find: "        if (segment === '' || /[/\\\\\\0]/.test(segment) || segment.startsWith('.')) {",
    replace: "        if (segment === '') {",
    tests: ['apps/gateway/test/admin-ui.test.ts'],
  },
  {
    id: 'ui-any-file-type',
    guards: 'plan §5: only allow-listed file types are served from the build',
    file: 'apps/gateway/src/admin/static-ui.ts',
    find: '    const contentType = CONTENT_TYPES[extname(relative).toLowerCase()];',
    replace:
      "    const contentType = CONTENT_TYPES[extname(relative).toLowerCase()] ?? 'application/octet-stream';",
    tests: ['apps/gateway/test/admin-ui.test.ts'],
  },
  {
    id: 'ui-missing-asset-gets-index',
    guards: 'plan §5: a missing asset is a 404, never the HTML page',
    file: 'apps/gateway/src/admin/static-ui.ts',
    find: "    if (extname(requested) === '') {",
    replace: "    if (requested !== '') {",
    tests: ['apps/gateway/test/admin-ui.test.ts'],
  },
  {
    id: 'ui-everything-immutable',
    guards: 'plan §5: only hashed assets are cached forever; index.html is revalidated',
    file: 'apps/gateway/src/admin/static-ui.ts',
    find: '    const hashed = relative.startsWith(`assets${sep}`);',
    replace: "    const hashed = relative !== '';",
    tests: ['apps/gateway/test/admin-ui.test.ts'],
  },
  {
    id: 'ui-exemption-by-url',
    guards: 'ADR-0037: the token exemption follows the matched route, not the URL prefix',
    file: 'apps/gateway/src/admin/admin-server.ts',
    find: '    if (request.routeOptions.config.public === true) {\n      done();',
    replace: "    if (request.url.startsWith('/admin/ui')) {\n      done();",
    tests: ['apps/gateway/test/admin-ui.test.ts'],
  },
  {
    id: 'dashboard-token-in-localstorage',
    guards: 'ADR-0037: the admin token lives in sessionStorage only',
    file: 'apps/dashboard/src/auth/token-store.ts',
    find: 'export function createTokenStore(storage: () => Storage = () => window.sessionStorage): TokenStore {',
    replace:
      'export function createTokenStore(storage: () => Storage = () => window.localStorage): TokenStore {',
    tests: ['apps/dashboard'],
  },
  {
    id: 'dashboard-client-skips-validation',
    guards: 'plan §6: every admin API response is validated with the shared contract',
    file: 'apps/dashboard/src/api/client.ts',
    find: '    const parsed = schema.safeParse(body);',
    replace:
      '    const parsed = { success: true as const, data: body as T, error: undefined as never };',
    tests: ['apps/dashboard'],
  },
  {
    id: 'dashboard-gate-accepts-unverified',
    guards: 'ADR-0037: the token gate verifies a token against the API before keeping it',
    file: 'apps/dashboard/src/app/TokenGate.tsx',
    find: '      await connect(candidate).stats();',
    replace: '      connect(candidate);',
    tests: ['apps/dashboard'],
  },
  {
    id: 'dashboard-401-shown-as-error',
    guards: 'plan §4: a rejected token returns to the gate instead of showing an error',
    file: 'apps/dashboard/src/api/use-poll.ts',
    find: "        if (apiError.kind === 'unauthorized') {",
    replace: "        if (apiError.kind === 'never') {",
    tests: ['apps/dashboard'],
  },
  {
    id: 'bundle-dynamic-imports-initial',
    guards: 'plan §3: lazy chunks count toward the total budget, not the initial one',
    file: 'scripts/check-bundle.ts',
    find: '    for (const imported of chunk.imports ?? []) visit(imported);',
    replace:
      '    for (const imported of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) visit(imported);',
    tests: ['scripts/check-bundle.test.ts'],
  },
  {
    id: 'bundle-inline-script-allowed',
    guards: 'ADR-0040: the build check rejects inline scripts the CSP would block',
    file: 'scripts/check-bundle.ts',
    find: "    if (!/\\bsrc\\s*=/.test(attributes) || (match[2] ?? '').trim() !== '') {",
    replace: "    if (attributes === 'never') {",
    tests: ['scripts/check-bundle.test.ts'],
  },
  {
    id: 'chart-gaps-as-zeros',
    guards: 'plan §4: buckets without data are gaps, never zeros',
    file: 'apps/dashboard/src/data/chart-data.ts',
    find: '    return { t: slice.start, notes, p50: p50.value, p95: p95.value, p99: p99.value };',
    replace:
      '    return { t: slice.start, notes, p50: p50.value ?? 0, p95: p95.value ?? 0, p99: p99.value ?? 0 };',
    tests: ['apps/dashboard'],
  },
  {
    id: 'chart-ratio-not-percent',
    guards: 'plan §4: ratios are charted as percentages with a % axis',
    file: 'apps/dashboard/src/data/chart-data.ts',
    find: "    const value = raw === null ? null : options.unit === '%' ? raw * 100 : raw;",
    replace: '    const value = raw;',
    tests: ['apps/dashboard'],
  },
  {
    id: 'chart-hit-ratio-counts-bypass',
    guards: 'plan §2.3: cache bypasses are not lookups, in charts too',
    file: 'apps/dashboard/src/data/chart-data.ts',
    find: '    denominator: (b) => b.counters.cache.hit + b.counters.cache.miss,',
    replace:
      '    denominator: (b) => b.counters.cache.hit + b.counters.cache.miss + b.counters.cache.bypass,',
    tests: ['apps/dashboard'],
  },
  {
    id: 'poll-stale-after-one-miss',
    guards: 'plan §4: the stale banner appears after 2 missed polls',
    file: 'apps/dashboard/src/api/use-poll.ts',
    find: '    stale: data !== undefined && misses >= STALE_AFTER_MISSES,',
    replace: '    stale: data !== undefined && misses >= 1,',
    tests: ['apps/dashboard'],
  },
  {
    id: 'poll-ignores-pause',
    guards: 'plan §6: pausing stops polling',
    file: 'apps/dashboard/src/api/use-poll.ts',
    find: '        if (!pausedRef.current) setTick((t) => t + 1);',
    replace: '        setTick((t) => t + 1);',
    tests: ['apps/dashboard'],
  },
  {
    id: 'poll-continues-after-401',
    guards: 'plan §4: a rejected token stops polling and returns to the gate',
    file: 'apps/dashboard/src/api/use-poll.ts',
    find: '          unauthorized();\n          return;',
    replace: '          unauthorized();',
    tests: ['apps/dashboard'],
  },
  {
    id: 'kpi-hides-low-confidence',
    guards: 'ADR-0038: low-confidence percentiles are shown with their label and n',
    file: 'apps/dashboard/src/app/Kpi.tsx',
    find: "  if (p.value === null || p.confidence === 'adequate') return undefined;",
    replace: "  if (p.value === null || p.confidence !== 'none') return undefined;",
    tests: ['apps/dashboard'],
  },
  {
    id: 'nav-without-url',
    guards: 'plan §6: each screen has a real URL (reload and back work)',
    file: 'apps/dashboard/src/app/navigation.ts',
    find: "    if (pathOf(id) !== window.location.pathname) window.history.pushState(null, '', pathOf(id));",
    replace: '    void pathOf;',
    tests: ['apps/dashboard'],
  },
  {
    id: 'zod-not-jitless',
    guards: 'ADR-0043: Zod must not probe eval, which the strict CSP reports as a violation',
    file: 'apps/dashboard/src/zod-config.ts',
    find: 'z.config({ jitless: true });',
    replace: 'z.config({});',
    tests: ['apps/dashboard/src/main.test.ts'],
  },
  {
    id: 'mock-fail-times-off-by-one',
    guards: 'real-data plan §2: _failTimes fails exactly n requests per key (F2/F3 depend on it)',
    file: 'examples/mock-upstreams/src/server.ts',
    find: '&& counter.next(key) < failTimes) {',
    replace: '&& counter.next(key) <= failTimes) {',
    tests: ['examples/mock-upstreams'],
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

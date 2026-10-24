import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  cacheResponseSchema,
  rateLimitsResponseSchema,
  routesResponseSchema,
  statsResponseSchema,
  upstreamsResponseSchema,
  type RouteSeries,
} from '@pulsegate/admin-contract';
import { ConfigError, parseClients } from '@pulsegate/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.ts';
import { createGateway, type Gateway, type GatewayOptions } from '../src/index.ts';
import {
  captureLogs,
  configFor,
  freePort,
  jsonBody,
  send,
  startUpstream,
  type MockUpstream,
  type RouteDef,
} from './harness.ts';

const TOKEN = 'a'.repeat(24) + 'admin-token-for-tests';
const KEY = generateApiKey();
const clients = parseClients({
  clients: [{ id: 'client-a', keys: [{ id: 'k1', sha256: hashApiKey(KEY) }] }],
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const ENDPOINTS = {
  '/admin/api/stats': statsResponseSchema,
  '/admin/api/upstreams': upstreamsResponseSchema,
  '/admin/api/routes': routesResponseSchema,
  '/admin/api/rate-limits': rateLimitsResponseSchema,
  '/admin/api/cache': cacheResponseSchema,
} as const;

const ROUTES: RouteDef[] = [
  {
    id: 'orders',
    pathPrefix: '/api/orders',
    cache: { enabled: true, ttlSeconds: 60, scope: 'shared' },
  },
  { id: 'secure', pathPrefix: '/api/secure', auth: { required: true } },
  {
    id: 'limited',
    pathPrefix: '/api/limited',
    rateLimit: { capacity: 2, refillRatePerSecond: 0.001 },
  },
  {
    id: 'flaky',
    pathPrefix: '/api/fail',
    retries: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
  },
  { id: 'slow', pathPrefix: '/api/slow', timeoutMs: 30_000 },
];

interface Running {
  gateway: Gateway;
  upstream: MockUpstream;
  publicPort: number;
  adminPort: number;
  logs: ReturnType<typeof captureLogs>;
}

/** Public + admin listeners on ephemeral ports, upstream answering per path. */
async function setup(options: Partial<GatewayOptions> = {}): Promise<Running> {
  const upstream = await startUpstream((req, res) => {
    if (req.url?.startsWith('/api/fail') === true) {
      res.statusCode = 503;
      res.end('down');
      return;
    }
    if (req.url?.startsWith('/api/slow') === true) {
      // Never answers in time; the client aborts first.
      setTimeout(() => res.end('late'), 5_000).unref();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'public, max-age=60');
    res.end(JSON.stringify({ ok: true }));
  });
  cleanups.push(() => upstream.close());
  const logs = captureLogs();
  const gateway = createGateway(configFor(upstream.url, ROUTES), {
    ...logs.options,
    clients,
    adminToken: TOKEN,
    ...options,
  });
  cleanups.push(() => gateway.close());
  await gateway.public.listen({ host: '127.0.0.1', port: 0 });
  if (gateway.admin === undefined) throw new Error('admin listener expected');
  await gateway.admin.listen({ host: '127.0.0.1', port: 0 });
  return {
    gateway,
    upstream,
    logs,
    publicPort: (gateway.public.server.address() as AddressInfo).port,
    adminPort: (gateway.admin.server.address() as AddressInfo).port,
  };
}

const bearer = { authorization: `Bearer ${TOKEN}` };

async function getJson(port: number, path: string): Promise<unknown> {
  const response = await send(port, { path, headers: bearer });
  expect(response.status).toBe(200);
  return jsonBody(response);
}

describe('admin listener: enablement and token rules (ADR-0020)', () => {
  it('is not built without ADMIN_TOKEN, allocates no stats window, and says so at startup', async () => {
    const upstream = await startUpstream();
    cleanups.push(() => upstream.close());
    const [publicPort, opsPort] = [await freePort(), await freePort()];
    const logs = captureLogs();
    const gateway = createGateway(
      configFor(upstream.url, [{}], {
        server: { host: '127.0.0.1', port: publicPort },
        operations: { port: opsPort },
      }),
      logs.options,
    );
    cleanups.push(() => gateway.close());
    expect(gateway.admin).toBeUndefined();
    expect(gateway.stats).toBeUndefined();
    expect(gateway.adminRoutes).toEqual([]);
    await gateway.start();
    expect(logs.lines().map((line) => line['msg'])).toContain(
      'admin listener disabled: ADMIN_TOKEN is not set (ADR-0020)',
    );
  });

  it('treats an empty ADMIN_TOKEN as unset', async () => {
    const upstream = await startUpstream();
    cleanups.push(() => upstream.close());
    const gateway = createGateway(configFor(upstream.url), { logger: false, adminToken: '' });
    cleanups.push(() => gateway.close());
    expect(gateway.admin).toBeUndefined();
  });

  it('fails startup on a token shorter than 32 characters, without echoing it', async () => {
    const upstream = await startUpstream();
    cleanups.push(() => upstream.close());
    const short = 'x'.repeat(31);
    let error: unknown;
    try {
      createGateway(configFor(upstream.url), { logger: false, adminToken: short });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain('ADMIN_TOKEN');
    expect((error as Error).message).toContain('at least 32 characters');
    expect((error as Error).message).not.toContain(short);
    // Exactly 32 is accepted.
    const ok = createGateway(configFor(upstream.url), {
      logger: false,
      adminToken: 'x'.repeat(32),
    });
    cleanups.push(() => ok.close());
    expect(ok.admin).toBeDefined();
  });

  it('listens on the configured admin port when started', async () => {
    const upstream = await startUpstream();
    cleanups.push(() => upstream.close());
    const [publicPort, opsPort, adminPort] = [await freePort(), await freePort(), await freePort()];
    const gateway = createGateway(
      configFor(upstream.url, [{}], {
        server: { host: '127.0.0.1', port: publicPort },
        operations: { port: opsPort },
        admin: { port: adminPort },
      }),
      { logger: false, adminToken: TOKEN },
    );
    cleanups.push(() => gateway.close());
    await gateway.start();
    expect((await send(adminPort, { path: '/admin/api/stats', headers: bearer })).status).toBe(200);
  });
});

describe('admin listener: authentication on every route (plan §5)', () => {
  it('registers the five API routes behind the token and only the UI routes as public', async () => {
    const { gateway } = await setup();
    const gets = (isPublic: boolean) =>
      gateway.adminRoutes
        .filter((route) => route.method === 'GET' && route.public === isPublic)
        .map((r) => r.url)
        .sort();
    expect(gets(false)).toEqual(Object.keys(ENDPOINTS).sort());
    // The only token-free routes: the dashboard's static files (ADR-0037).
    expect(gets(true)).toEqual(['/admin/ui', '/admin/ui/*']);
    expect(
      gateway.adminRoutes.filter((r) => r.public).every((r) => r.url.startsWith('/admin/ui')),
    ).toBe(true);
  });

  const badCredentials: [string, Record<string, string>][] = [
    ['no Authorization header', {}],
    ['a wrong token', { authorization: `Bearer ${TOKEN}x` }],
    ['a token prefix', { authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
    ['the wrong scheme', { authorization: `Basic ${TOKEN}` }],
    ['the token without a scheme', { authorization: TOKEN }],
    ['an empty bearer', { authorization: 'Bearer ' }],
    ['a valid client API key', { 'x-api-key': KEY }],
  ];

  it.each(badCredentials)(
    'rejects %s on every registered route with 401',
    async (_name, headers) => {
      const { gateway, adminPort } = await setup();
      expect(gateway.adminRoutes.length).toBeGreaterThan(0);
      for (const route of gateway.adminRoutes.filter((r) => !r.public)) {
        const response = await send(adminPort, { method: route.method, path: route.url, headers });
        expect(response.status, `${route.method} ${route.url}`).toBe(401);
        expect(response.headers['www-authenticate']).toBe('Bearer');
        expect(response.headers['cache-control']).toBe('no-store');
        if (route.method === 'GET') {
          const body = jsonBody(response) as { error: { code: string; requestId: string } };
          expect(body.error.code).toBe('ADMIN_AUTHENTICATION_FAILED');
          expect(body.error.requestId).toBe(response.headers['x-request-id']);
          expect(response.body).not.toContain('admin-token');
        }
      }
    },
  );

  it('rejects unknown admin paths before revealing whether they exist', async () => {
    const { adminPort } = await setup();
    for (const path of ['/admin/api/nope', '/', '/admin/api/stats/../routes']) {
      expect((await send(adminPort, { path })).status).toBe(401);
    }
    const authorized = await send(adminPort, { path: '/admin/api/nope', headers: bearer });
    expect(authorized.status).toBe(404);
    expect((jsonBody(authorized) as { error: { code: string } }).error.code).toBe(
      'ROUTE_NOT_FOUND',
    );
  });

  it('accepts the scheme case-insensitively and sets the security headers', async () => {
    const { adminPort } = await setup();
    const response = await send(adminPort, {
      path: '/admin/api/stats',
      headers: { authorization: `bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it('logs one line per admin request and never the token', async () => {
    const { adminPort, logs } = await setup();
    await send(adminPort, { path: '/admin/api/stats', headers: bearer });
    await send(adminPort, { path: '/admin/api/stats', headers: { authorization: 'Bearer nope' } });
    const lines = logs.lines().filter((line) => line['msg'] === 'admin request completed');
    expect(lines.map((line) => [line['statusCode'], line['errorCode']])).toEqual([
      [200, undefined],
      [401, 'ADMIN_AUTHENTICATION_FAILED'],
    ]);
    const all = JSON.stringify(logs.lines());
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('Bearer');
  });

  it('serves nothing administrative on the public or operations listeners', async () => {
    const { publicPort } = await setup();
    const opsGateway = createGateway(configFor('http://127.0.0.1:1'), {
      logger: false,
      adminToken: TOKEN,
    });
    cleanups.push(() => opsGateway.close());
    for (const path of Object.keys(ENDPOINTS)) {
      const viaPublic = await send(publicPort, { path, headers: bearer });
      expect(viaPublic.status).toBe(404);
      const viaOps = await opsGateway.operations.inject({ url: path, headers: bearer });
      expect(viaOps.statusCode).toBe(404);
    }
  });
});

/** Sends the traffic mix the numbers below are derived from. */
async function sendTraffic(publicPort: number): Promise<void> {
  // orders: miss (stored), hit, hit, bypass.
  for (let i = 0; i < 3; i++) {
    expect((await send(publicPort, { path: '/api/orders' })).status).toBe(200);
  }
  const bypass = await send(publicPort, {
    path: '/api/orders',
    headers: { 'cache-control': 'no-cache' },
  });
  expect(bypass.headers['x-cache']).toBe('BYPASS');
  // secure: 401 before the limiter, then one authenticated request.
  expect((await send(publicPort, { path: '/api/secure' })).status).toBe(401);
  expect(
    (await send(publicPort, { path: '/api/secure', headers: { 'x-api-key': KEY } })).status,
  ).toBe(200);
  // limited: capacity 2 → 200, 200, 429.
  const limited = [];
  for (let i = 0; i < 3; i++)
    limited.push((await send(publicPort, { path: '/api/limited' })).status);
  expect(limited).toEqual([200, 200, 429]);
  // flaky: 3 failed attempts (2 retries), the final 503 passes through.
  expect((await send(publicPort, { path: '/api/fail' })).status).toBe(503);
  // unmatched
  expect((await send(publicPort, { path: '/nope' })).status).toBe(404);
}

function routeOf(body: { routes: { id: string; series: RouteSeries }[] }, id: string) {
  const route = body.routes.find((r) => r.id === id);
  if (route === undefined) throw new Error(`route ${id} missing`);
  return route.series.window;
}

describe('admin API numbers match socket traffic (plan §2.3, §5.1)', () => {
  it('every endpoint validates against its shared schema', async () => {
    const { adminPort, publicPort } = await setup();
    await sendTraffic(publicPort);
    for (const [path, schema] of Object.entries(ENDPOINTS)) {
      const parsed = schema.safeParse(await getJson(adminPort, path));
      expect(parsed.success, `${path}: ${parsed.error?.message ?? ''}`).toBe(true);
    }
  });

  it('stats: counters and every rate formula per route and in total', async () => {
    const { adminPort, publicPort } = await setup();
    await sendTraffic(publicPort);
    const body = statsResponseSchema.parse(await getJson(adminPort, '/admin/api/stats'));

    const orders = routeOf(body, 'orders');
    expect(orders.counters).toMatchObject({
      requests: 4,
      status: { '2xx': 4 },
      rl: { allowed: 4, rejected: 0 },
      cache: { hit: 2, miss: 1, bypass: 1 },
      store: { stored: 1, notStorable: 0, tooLarge: 0 },
      attempts: { success: 2, failure: 0 },
      retries: 0,
    });
    expect(orders.rates).toMatchObject({
      successRate: 1,
      cacheHitRatio: 2 / 3, // bypass excluded from the denominator
      cacheBypassRate: 1 / 4,
      cacheStoreRate: 1,
      retryRate: 0,
      upstreamFailureRate: 0,
    });

    const secure = routeOf(body, 'secure');
    expect(secure.counters).toMatchObject({
      requests: 2,
      status: { '2xx': 1, '4xx': 1 },
      codes: { AUTHENTICATION_FAILED: 1 },
      // The 401 never reached the limiter.
      rl: { allowed: 1, rejected: 0 },
    });
    expect(secure.rates).toMatchObject({ clientErrorRate: 1 / 2, rateLimitRejectionRate: 0 });
    // No cache configured: lookups never happened, so the ratios are unknown, not 0 %.
    expect(secure.rates.cacheHitRatio).toBeNull();
    expect(secure.rates.cacheStoreRate).toBeNull();

    const limited = routeOf(body, 'limited');
    expect(limited.counters).toMatchObject({
      requests: 3,
      codes: { RATE_LIMIT_EXCEEDED: 1 },
      rl: { allowed: 2, rejected: 1 },
    });
    expect(limited.rates).toMatchObject({ rateLimitRejectionRate: 1 / 3, clientErrorRate: 1 / 3 });

    const flaky = routeOf(body, 'flaky');
    expect(flaky.counters).toMatchObject({
      requests: 1,
      status: { '5xx': 1 },
      attempts: { success: 0, failure: 3, aborted: 0 },
      retries: 2,
    });
    // Per attempt, and retries per request that reached the upstream (may exceed 1).
    expect(flaky.rates).toMatchObject({ errorRate: 1, upstreamFailureRate: 1, retryRate: 2 });

    const total = body.total.window;
    expect(total.counters).toMatchObject({
      requests: 11,
      status: { '2xx': 7, '4xx': 3, '5xx': 1 },
      codes: { ROUTE_NOT_FOUND: 1, AUTHENTICATION_FAILED: 1, RATE_LIMIT_EXCEEDED: 1 },
      attempts: { success: 5, failure: 3 },
      retries: 2,
    });
    expect(total.rates.successRate).toBeCloseTo(7 / 11, 12);
    expect(total.latency.p50).toMatchObject({ observations: 11, method: 'exact' });
    expect(total.latency.p99.confidence).toBe('low');
    // Window counters are the sum of the bucket counters, never averaged rates.
    expect(body.total.buckets.reduce((n, b) => n + b.counters.requests, 0)).toBe(11);
    expect(body.instance.id).toMatch(/^gw_/);
  });

  it('upstreams: attempts, failure rate and breaker state', async () => {
    const { adminPort, publicPort, upstream } = await setup();
    await sendTraffic(publicPort);
    const body = upstreamsResponseSchema.parse(await getJson(adminPort, '/admin/api/upstreams'));
    expect(body.upstreams).toHaveLength(1);
    const [orders] = body.upstreams;
    expect(orders?.id).toBe('orders-service');
    expect(orders?.baseUrl).toBe(upstream.url);
    expect(orders?.breaker).toMatchObject({
      state: 'closed',
      consecutiveFailures: 3, // the flaky route's three failed attempts came last
    });
    expect(orders?.series.window.counters).toEqual({
      attempts: { success: 5, failure: 3, aborted: 0 },
      retries: 2,
    });
    expect(orders?.series.window.rates.upstreamFailureRate).toBe(3 / 8);
    expect(orders?.series.window.latency.p50.observations).toBe(8);
  });

  it('routes: configuration only, no client keys or digests', async () => {
    const { adminPort } = await setup();
    const response = await send(adminPort, { path: '/admin/api/routes', headers: bearer });
    const body = routesResponseSchema.parse(jsonBody(response));
    expect(body.routes.map((r) => r.id)).toEqual(ROUTES.map((r) => r.id));
    expect(body.routes.find((r) => r.id === 'orders')).toMatchObject({
      pathPrefix: '/api/orders',
      methods: ['GET'],
      upstreamId: 'orders-service',
      authRequired: false,
      cache: { enabled: true, ttlSeconds: 60, scope: 'shared', varyHeaders: [] },
    });
    expect(body.routes.find((r) => r.id === 'flaky')?.retries.maxAttempts).toBe(3);
    expect(body.routes.find((r) => r.id === 'secure')).toMatchObject({
      authRequired: true,
      cache: { enabled: false, ttlSeconds: null, scope: null },
      attemptTimeoutMs: null,
    });
    expect(response.body).not.toContain(hashApiKey(KEY));
    expect(response.body).not.toContain('client-a');
  });

  it('rate-limits: local backend, policies and per-route decisions', async () => {
    const { adminPort, publicPort } = await setup();
    await sendTraffic(publicPort);
    const body = rateLimitsResponseSchema.parse(await getJson(adminPort, '/admin/api/rate-limits'));
    expect(body).toMatchObject({
      mode: 'local',
      redisFailurePolicy: null,
      backend: { kind: 'local', healthy: true, target: null, degraded: false },
    });
    const limited = body.routes.find((r) => r.id === 'limited');
    expect(limited?.policy).toEqual({ capacity: 2, refillRatePerSecond: 0.001 });
    expect(limited?.series.window.rates.rateLimitRejectionRate).toBe(1 / 3);
  });

  it('cache: limits, usage, lifetime evictions and only cache-enabled routes', async () => {
    const { adminPort, publicPort } = await setup();
    await sendTraffic(publicPort);
    const body = cacheResponseSchema.parse(await getJson(adminPort, '/admin/api/cache'));
    expect(body.limits).toEqual({ maxEntries: 10_000, maxBytes: 67_108_864 });
    expect(body.usage.entries).toBe(1);
    expect(body.usage.bytes).toBeGreaterThan(0);
    expect(body.evictions.lifetime).toEqual({ capacity: 0, expired: 0 });
    expect(body.routes.map((r) => [r.id, r.scope, r.ttlSeconds])).toEqual([
      ['orders', 'shared', 60],
    ]);
    expect(body.routes[0]?.series.window.rates.cacheHitRatio).toBe(2 / 3);
  });

  it('counts a client abort without a status or latency sample', async () => {
    const { adminPort, publicPort } = await setup();
    const req = httpRequest({
      host: '127.0.0.1',
      port: publicPort,
      path: '/api/slow',
      agent: false,
    });
    req.on('error', () => undefined);
    req.end();
    // Abort once the gateway has the request in flight (the upstream has received it).
    await vi.waitFor(async () => {
      const body = statsResponseSchema.parse(await getJson(adminPort, '/admin/api/stats'));
      expect(routeOf(body, 'slow').counters.rl.allowed).toBe(1);
    });
    req.destroy();
    await vi.waitFor(async () => {
      const body = statsResponseSchema.parse(await getJson(adminPort, '/admin/api/stats'));
      const slow = routeOf(body, 'slow');
      expect(slow.counters).toMatchObject({
        requests: 0,
        aborted: 1,
        codes: { CLIENT_ABORTED: 1 },
      });
      expect(slow.rates.abortRate).toBe(1);
      expect(slow.latency.p50.observations).toBe(0);
    });
  });

  it('places traffic in the bucket of its monotonic time and omits time before startup', async () => {
    let now = 0;
    const { adminPort, publicPort } = await setup({
      statsClocks: { wallClock: () => 1_700_000_000_000, monotonic: () => now },
    });
    await send(publicPort, { path: '/api/limited' });
    now = 25_000;
    await send(publicPort, { path: '/api/limited' });
    const body = statsResponseSchema.parse(await getJson(adminPort, '/admin/api/stats'));
    expect(body.window.collectingSince).toBe(1_700_000_000_000);
    const buckets = body.routes.find((r) => r.id === 'limited');
    expect(buckets?.series.buckets.map((b) => b.counters.requests)).toEqual([1, 0, 1]);
    expect(buckets?.series.buckets.at(-1)?.partial).toBe(true);
  });
});

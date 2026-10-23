import { parseClients, type ClientsConfig } from '@pulsegate/config';
import { LocalTokenBucketLimiter } from '@pulsegate/rate-limiter';
import { afterEach, describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.ts';
import type { GatewayOptions } from '../src/index.ts';
import {
  captureLogs,
  configFor,
  send,
  startGateway,
  startUpstream,
  type RawResponse,
  type RouteDef,
  type RunningGateway,
} from './harness.ts';

/**
 * Review checks for Phase 2 (ADR-0031, ADR-0032): key rotation/revocation/expiry end to end,
 * trusted-proxy spoofing of IP buckets, bucket eviction under pressure, and which responses
 * carry rate-limit headers.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function gatewayWith(
  routes: RouteDef[],
  options: GatewayOptions & { extra?: Record<string, unknown> } = {},
  handler?: Parameters<typeof startUpstream>[0],
): Promise<RunningGateway> {
  const upstream = await startUpstream(handler);
  cleanups.push(() => upstream.close());
  const { extra, ...gatewayOptions } = options;
  const gw = await startGateway(configFor(upstream.url, routes, extra), {
    logger: false,
    ...gatewayOptions,
  });
  cleanups.push(() => gw.close());
  return gw;
}

const withKey = (gw: RunningGateway, key: string) =>
  send(gw.port, { path: '/api/orders', headers: { 'x-api-key': key } });

const rateHeaders = (response: RawResponse) => ({
  limit: response.headers['x-ratelimit-limit'],
  remaining: response.headers['x-ratelimit-remaining'],
  reset: response.headers['x-ratelimit-reset'],
});

describe('key rotation, revocation and expiry, end to end (ADR-0031)', () => {
  const OLD = generateApiKey();
  const NEW = generateApiKey();
  const secured: RouteDef[] = [{ auth: { required: true } }];
  const clientsWith = (keys: { id: string; key: string; expiresAt?: string }[]): ClientsConfig =>
    parseClients({
      clients: [
        {
          id: 'mobile',
          keys: keys.map(({ id, key, expiresAt }) => ({
            id,
            sha256: hashApiKey(key),
            ...(expiresAt === undefined ? {} : { expiresAt }),
          })),
        },
      ],
    });

  it('rotates without downtime: both keys work, then revoking the old one leaves the new one working', async () => {
    const during = await gatewayWith(secured, {
      clients: clientsWith([
        { id: 'old', key: OLD },
        { id: 'new', key: NEW },
      ]),
    });
    expect((await withKey(during, OLD)).status).toBe(200);
    expect((await withKey(during, NEW)).status).toBe(200);
    await during.close();

    // Revocation = remove the key from the clients file and restart (static config, ADR-0003).
    const after = await gatewayWith(secured, { clients: clientsWith([{ id: 'new', key: NEW }]) });
    expect((await withKey(after, OLD)).status).toBe(401);
    expect((await withKey(after, NEW)).status).toBe(200);
  });

  it("rejects an expired key while the same client's live key keeps working", async () => {
    const logs = captureLogs();
    const gw = await gatewayWith(secured, {
      ...logs.options,
      clients: clientsWith([
        { id: 'old', key: OLD, expiresAt: '2020-01-01T00:00:00Z' },
        { id: 'new', key: NEW },
      ]),
    });
    expect((await withKey(gw, OLD)).status).toBe(401);
    expect((await withKey(gw, NEW)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logs.lines()).toContainEqual(
      expect.objectContaining({
        msg: 'request completed',
        statusCode: 401,
        authFailure: 'expired',
      }),
    );
  });
});

describe('trusted-proxy spoofing cannot move IP buckets (ADR-0021, ADR-0032)', () => {
  const publicRoute = (capacity: number): RouteDef => ({
    auth: { required: false },
    rateLimit: { capacity, refillRatePerSecond: 0.001 },
  });
  const viaXff = (gw: RunningGateway, xff: string) =>
    send(gw.port, { path: '/api/orders', headers: { 'x-forwarded-for': xff } });

  it('ignores every forged X-Forwarded-For from an untrusted peer', async () => {
    const gw = await gatewayWith([publicRoute(1)]);
    const statuses = [];
    for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3, 4.4.4.4', 'not-an-ip', '127.0.0.2']) {
      statuses.push((await viaXff(gw, forged)).status);
    }
    expect(statuses).toEqual([200, 429, 429, 429, 429]);
  });

  it('behind a trusted proxy, uses the proxy-reported client but not a client-forged prefix', async () => {
    const gw = await gatewayWith([publicRoute(1)], {
      extra: { server: { trustedProxies: ['127.0.0.1'] } },
    });
    // Two real clients behind the proxy get separate buckets...
    expect((await viaXff(gw, '203.0.113.1')).status).toBe(200);
    expect((await viaXff(gw, '203.0.113.2')).status).toBe(200);
    // ...and a client prepending fake hops still lands in its own bucket, keyed by what the proxy appended.
    expect((await viaXff(gw, '6.6.6.6, 203.0.113.1')).status).toBe(429);
    expect((await viaXff(gw, '7.7.7.7, 203.0.113.1')).status).toBe(429);
  });
});

describe('bucket eviction under pressure (ADR-0032)', () => {
  it('caps buckets at maxBuckets, evicts LRU, and reports it in the log', async () => {
    const limiter = new LocalTokenBucketLimiter({ maxBuckets: 5 });
    const logs = captureLogs();
    const gw = await gatewayWith(
      [{ auth: { required: false }, rateLimit: { capacity: 1, refillRatePerSecond: 0.001 } }],
      {
        ...logs.options,
        limiter,
        sweepIntervalMs: 25,
        extra: { server: { trustedProxies: ['127.0.0.1'] } },
      },
    );

    // 20 distinct client IPs (reported by the trusted proxy) spray the store.
    let peak = 0;
    for (let i = 1; i <= 20; i++) {
      const response = await send(gw.port, {
        path: '/api/orders',
        headers: { 'x-forwarded-for': `198.51.100.${String(i)}` },
      });
      expect(response.status).toBe(200);
      peak = Math.max(peak, limiter.stats().buckets);
    }
    expect(peak).toBe(5);
    expect(limiter.stats()).toMatchObject({ buckets: 5, maxBuckets: 5, evictedLru: 15 });

    // Documented weakening: an evicted caller starts over with a full bucket.
    const evicted = await send(gw.port, {
      path: '/api/orders',
      headers: { 'x-forwarded-for': '198.51.100.1' },
    });
    expect(evicted.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(logs.lines()).toContainEqual(
      expect.objectContaining({
        level: 40,
        msg: 'rate-limit bucket cap reached; least-recently-used buckets were evicted',
        maxBuckets: 5,
        buckets: 5,
      }),
    );
  });
});

describe('which responses carry rate-limit headers (ADR-0032)', () => {
  const KEY = generateApiKey();
  const clients = parseClients({
    clients: [{ id: 'c', keys: [{ id: 'k', sha256: hashApiKey(KEY) }] }],
  });

  async function matrixGateway() {
    return gatewayWith(
      [
        {
          id: 'limited',
          methods: ['GET', 'POST'],
          auth: { required: true },
          timeoutMs: 100,
          rateLimit: { capacity: 100, refillRatePerSecond: 1 },
        },
        {
          id: 'tiny',
          pathPrefix: '/api/tiny',
          auth: { required: true },
          rateLimit: { capacity: 1, refillRatePerSecond: 0.001 },
        },
      ],
      {
        clients,
        extra: { server: { limits: { maxRequestBodyBytes: 16, maxResponseBodyBytes: 1024 } } },
      },
      (req, res) => {
        const url = req.url ?? '';
        if (url.endsWith('/503')) {
          res.statusCode = 503;
          res.end('busy');
        } else if (url.endsWith('/slow')) setTimeout(() => res.end('late'), 500);
        else if (url.endsWith('/reset')) req.socket.destroy();
        else if (url.endsWith('/big')) res.end('x'.repeat(2048));
        else res.end('ok');
      },
    );
  }

  it('sets them on every response produced after the limit check', async () => {
    const gw = await matrixGateway();
    const auth = { 'x-api-key': KEY };
    const cases: [string, Promise<RawResponse>, number][] = [
      ['success', send(gw.port, { path: '/api/orders', headers: auth }), 200],
      [
        'upstream 5xx passed through',
        send(gw.port, { path: '/api/orders/503', headers: auth }),
        503,
      ],
      ['upstream timeout', send(gw.port, { path: '/api/orders/slow', headers: auth }), 504],
      ['upstream reset', send(gw.port, { path: '/api/orders/reset', headers: auth }), 502],
      [
        'upstream response too large',
        send(gw.port, { path: '/api/orders/big', headers: auth }),
        502,
      ],
      [
        'request body too large',
        send(gw.port, { method: 'POST', path: '/api/orders', headers: auth, body: 'x'.repeat(17) }),
        413,
      ],
    ];
    for (const [name, pending, status] of cases) {
      const response = await pending;
      expect({ name, status: response.status }).toEqual({ name, status });
      expect({ name, ...rateHeaders(response) }).toEqual({
        name,
        limit: '100',
        remaining: expect.stringMatching(/^\d+$/) as string,
        reset: expect.stringMatching(/^\d+$/) as string,
      });
    }

    await send(gw.port, { path: '/api/tiny', headers: auth });
    const limited = await send(gw.port, { path: '/api/tiny', headers: auth });
    expect(limited.status).toBe(429);
    expect(rateHeaders(limited)).toEqual({
      limit: '1',
      remaining: '0',
      reset: expect.any(String) as string,
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('omits them when the request is rejected before the limit check', async () => {
    const gw = await matrixGateway();
    const cases: [string, Promise<RawResponse>, number][] = [
      ['missing key', send(gw.port, { path: '/api/orders' }), 401],
      [
        'unknown key',
        send(gw.port, { path: '/api/orders', headers: { 'x-api-key': generateApiKey() } }),
        401,
      ],
      ['unknown route', send(gw.port, { path: '/nope', headers: { 'x-api-key': KEY } }), 404],
      [
        'wrong method',
        send(gw.port, { method: 'DELETE', path: '/api/orders', headers: { 'x-api-key': KEY } }),
        405,
      ],
      [
        'malformed path',
        send(gw.port, { path: '/api/orders/../x', headers: { 'x-api-key': KEY } }),
        400,
      ],
    ];
    for (const [name, pending, status] of cases) {
      const response = await pending;
      expect({ name, status: response.status }).toEqual({ name, status });
      expect({ name, ...rateHeaders(response) }).toEqual({
        name,
        limit: undefined,
        remaining: undefined,
        reset: undefined,
      });
      expect(response.headers['x-request-id']).toMatch(/^req_/);
    }
  });
});

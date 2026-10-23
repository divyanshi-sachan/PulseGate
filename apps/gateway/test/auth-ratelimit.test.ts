import { ConfigError, parseClients } from '@pulsegate/config';
import { afterEach, describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.ts';
import { createGateway } from '../src/index.ts';
import {
  captureLogs,
  configFor,
  jsonBody,
  send,
  startGateway,
  startUpstream,
  type MockUpstream,
  type RouteDef,
  type RunningGateway,
} from './harness.ts';

const KEY_A = generateApiKey();
const KEY_A2 = generateApiKey();
const KEY_B = generateApiKey();
const KEY_OFF = generateApiKey();
const clients = parseClients({
  clients: [
    {
      id: 'client-a',
      keys: [
        { id: 'k1', sha256: hashApiKey(KEY_A) },
        { id: 'k2', sha256: hashApiKey(KEY_A2) },
      ],
    },
    { id: 'client-b', keys: [{ id: 'k1', sha256: hashApiKey(KEY_B) }] },
    { id: 'client-off', enabled: false, keys: [{ id: 'k1', sha256: hashApiKey(KEY_OFF) }] },
  ],
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const secured: RouteDef = { auth: { required: true } };

async function setup(
  routes: RouteDef[],
  handler?: Parameters<typeof startUpstream>[0],
): Promise<{ upstream: MockUpstream; gw: RunningGateway; logs: ReturnType<typeof captureLogs> }> {
  const upstream = await startUpstream(handler);
  cleanups.push(() => upstream.close());
  const logs = captureLogs();
  const gw = await startGateway(configFor(upstream.url, routes), { ...logs.options, clients });
  cleanups.push(() => gw.close());
  return { upstream, gw, logs };
}

const get = (gw: RunningGateway, key?: string, path = '/api/orders') =>
  send(gw.port, { path, headers: key === undefined ? {} : { 'x-api-key': key } });

describe('authentication (ADR-0031)', () => {
  it('forwards authenticated requests without the key and logs the client id', async () => {
    const { upstream, gw, logs } = await setup([secured]);
    const response = await get(gw, KEY_A);
    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.headers['x-api-key']).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logs.lines()).toContainEqual(
      expect.objectContaining({ msg: 'request completed', clientId: 'client-a', statusCode: 200 }),
    );
  });

  it('accepts both keys of a client during rotation', async () => {
    const { gw } = await setup([secured]);
    expect((await get(gw, KEY_A)).status).toBe(200);
    expect((await get(gw, KEY_A2)).status).toBe(200);
  });

  it('rejects missing, unknown, malformed and disabled keys with the same 401', async () => {
    const { upstream, gw, logs } = await setup([secured]);
    const responses = await Promise.all(
      [undefined, generateApiKey(), 'garbage', KEY_OFF].map((key) => get(gw, key)),
    );
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers['x-ratelimit-limit']).toBeUndefined();
      expect(jsonBody(response)).toEqual({
        error: {
          code: 'AUTHENTICATION_FAILED',
          message: 'Authentication failed',
          requestId: response.headers['x-request-id'],
        },
      });
    }
    expect(upstream.requests).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const reasons = logs
      .lines()
      .filter((line) => line['msg'] === 'request completed')
      .map((line) => line['authFailure'])
      .sort();
    expect(reasons).toEqual(['disabled', 'malformed', 'missing', 'unknown']);
    const all = JSON.stringify(logs.lines());
    for (const key of [KEY_OFF, hashApiKey(KEY_OFF)]) expect(all).not.toContain(key);
  });

  it('does not require a key on routes with auth.required: false', async () => {
    const { gw } = await setup([{}]);
    expect((await get(gw)).status).toBe(200);
  });

  it('refuses to start when a route needs auth and no clients are given', () => {
    expect(() => createGateway(configFor('http://up:1', [secured]), { logger: false })).toThrow(
      ConfigError,
    );
  });
});

describe('rate limiting (ADR-0032)', () => {
  const limited = (capacity: number, extra: RouteDef = {}): RouteDef => ({
    ...secured,
    rateLimit: { capacity, refillRatePerSecond: 0.001 },
    ...extra,
  });

  it('reports the budget on every response and 429s with Retry-After when empty', async () => {
    const { gw, upstream } = await setup([limited(2)]);
    const [first, second, third] = [
      await get(gw, KEY_A),
      await get(gw, KEY_A),
      await get(gw, KEY_A),
    ];

    expect(first.headers['x-ratelimit-limit']).toBe('2');
    expect(first.headers['x-ratelimit-remaining']).toBe('1');
    expect(second.headers['x-ratelimit-remaining']).toBe('0');
    expect(Number(second.headers['x-ratelimit-reset'])).toBeGreaterThan(0);

    expect(third.status).toBe(429);
    expect((jsonBody(third) as { error: { code: string } }).error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(third.headers['x-ratelimit-remaining']).toBe('0');
    expect(upstream.requests).toHaveLength(2);
  });

  it('keeps separate budgets per client and per route', async () => {
    const { gw } = await setup([limited(1), limited(1, { id: 'other', pathPrefix: '/api/other' })]);
    expect((await get(gw, KEY_A)).status).toBe(200);
    expect((await get(gw, KEY_A)).status).toBe(429);
    expect((await get(gw, KEY_B)).status).toBe(200);
    expect((await get(gw, KEY_A, '/api/other')).status).toBe(200);
  });

  it('shares one budget across all keys of the same client', async () => {
    const { gw } = await setup([limited(1)]);
    expect((await get(gw, KEY_A)).status).toBe(200);
    expect((await get(gw, KEY_A2)).status).toBe(429);
  });

  it('limits unauthenticated routes by client IP, ignoring spoofed X-Forwarded-For', async () => {
    const { gw } = await setup([
      { auth: { required: false }, rateLimit: { capacity: 1, refillRatePerSecond: 0.001 } },
    ]);
    expect(
      (await send(gw.port, { path: '/api/orders', headers: { 'x-forwarded-for': '1.1.1.1' } }))
        .status,
    ).toBe(200);
    expect(
      (await send(gw.port, { path: '/api/orders', headers: { 'x-forwarded-for': '2.2.2.2' } }))
        .status,
    ).toBe(429);
  });

  it('allows exactly `capacity` of 50 concurrent requests', async () => {
    const { gw, upstream } = await setup([limited(10)]);
    const statuses = (await Promise.all(Array.from({ length: 50 }, () => get(gw, KEY_A)))).map(
      (response) => response.status,
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(10);
    expect(statuses.filter((status) => status === 429)).toHaveLength(40);
    expect(upstream.requests).toHaveLength(10);
  });

  it('does not rate-limit requests that match no route', async () => {
    const { gw } = await setup([limited(1)]);
    for (let i = 0; i < 3; i++) {
      const response = await get(gw, KEY_A, '/nope');
      expect(response.status).toBe(404);
      expect(response.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });

  it("overrides an upstream's own X-RateLimit headers", async () => {
    const { gw } = await setup([limited(5)], (_req, res) => {
      res.setHeader('x-ratelimit-limit', '9999');
      res.end('ok');
    });
    expect((await get(gw, KEY_A)).headers['x-ratelimit-limit']).toBe('5');
  });

  it('keeps rate-limit headers on gateway errors after the limit check', async () => {
    const { gw } = await setup([limited(5, { timeoutMs: 50 })], (_req, res) =>
      setTimeout(() => res.end('late'), 500),
    );
    const response = await get(gw, KEY_A);
    expect(response.status).toBe(504);
    expect(response.headers['x-ratelimit-remaining']).toBe('4');
  });
});

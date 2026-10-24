import { parseConfig } from '@pulsegate/config';
import { startTestRedis, TcpProxy } from '@pulsegate/testing';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createGateway, GatewayStartupError, type Gateway } from '../src/index.ts';
import {
  captureLogs,
  configFor,
  freePort,
  jsonBody,
  send,
  startUpstream,
  type MockUpstream,
  type RawResponse,
} from './harness.ts';

/**
 * Gateway + real Redis (ADR-0034): a shared budget across two instances, and both failure
 * policies, with outages simulated by a TCP proxy between the gateway and Redis.
 */
const PASSWORD = 's3cret-redis-pw';
const redis = await startTestRedis({ password: PASSWORD });
afterAll(async () => {
  await redis?.stop();
}, 30_000);

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

let upstream: MockUpstream | undefined;
async function sharedUpstream(): Promise<MockUpstream> {
  if (upstream === undefined) {
    upstream = await startUpstream();
    const started = upstream;
    afterAll(() => started.close());
  }
  return upstream;
}

const route = (id: string, capacity: number) => ({
  id,
  auth: { required: false },
  rateLimit: { capacity, refillRatePerSecond: 0.001 },
});

interface Started {
  gateway: Gateway;
  port: number;
  opsPort: number;
}

// Every test gets its own route id, hence its own Redis bucket key; the two-instance test reuses one on purpose.
let routeSeq = 0;
const nextRouteId = () => `route-${String(++routeSeq)}`;

async function startRedisGateway(
  redisUrl: string,
  policy: 'open' | 'closed',
  capacity: number,
  logger = captureLogs(),
  routeId = nextRouteId(),
): Promise<Started> {
  const base = await sharedUpstream();
  const [port, opsPort] = [await freePort(), await freePort()];
  const config = configFor(base.url, [route(routeId, capacity)], {
    server: { host: '127.0.0.1', port },
    operations: { port: opsPort },
    rateLimit: { mode: 'redis', redisFailurePolicy: policy, redis: { commandTimeoutMs: 100 } },
  });
  const gateway = createGateway(config, { ...logger.options, redisUrl });
  cleanups.push(() => gateway.close());
  await gateway.start();
  return { gateway, port, opsPort };
}

function redisUrlVia(proxy: TcpProxy): string {
  return `redis://:${PASSWORD}@127.0.0.1:${String(proxy.port)}`;
}

async function withProxy(): Promise<TcpProxy> {
  if (redis === undefined) throw new Error('unreachable');
  const proxy = await TcpProxy.start(redis.host, redis.port);
  cleanups.push(() => proxy.close());
  return proxy;
}

const ready = async (opsPort: number) => (await send(opsPort, { path: '/ready' })).status;
const readyBody = async (opsPort: number) => {
  const response = await send(opsPort, { path: '/ready' });
  return { status: response.status, body: jsonBody(response) };
};

/** Creates (but doesn't start) a fail-closed Redis gateway on free ports. */
async function redisGatewayUnstarted(
  redisUrl: string,
  connectTimeoutMs: number,
  logs = captureLogs(),
) {
  const base = await sharedUpstream();
  const [port, opsPort] = [await freePort(), await freePort()];
  const config = configFor(base.url, [route(nextRouteId(), 100)], {
    server: { host: '127.0.0.1', port },
    operations: { port: opsPort },
    rateLimit: {
      mode: 'redis',
      redisFailurePolicy: 'closed',
      redis: { commandTimeoutMs: 100, connectTimeoutMs },
    },
  });
  const gateway = createGateway(config, { ...logs.options, redisUrl });
  cleanups.push(() => gateway.close());
  return { gateway, port, opsPort };
}
const get = (port: number) => send(port, { path: '/api/orders' });
const code = (response: RawResponse) =>
  (jsonBody(response) as { error: { code: string } }).error.code;

async function eventually(check: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const until = performance.now() + timeoutMs;
  while (performance.now() < until) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('configuration (ADR-0034)', () => {
  it('refuses to start in redis mode without REDIS_URL', () => {
    const config = parseConfig({
      upstreams: [{ id: 'up', baseUrl: 'http://up:1' }],
      routes: [
        {
          id: 'r',
          pathPrefix: '/r',
          methods: ['GET'],
          upstreamId: 'up',
          auth: { required: false },
          rateLimit: { capacity: 1, refillRatePerSecond: 1 },
        },
      ],
      rateLimit: { mode: 'redis', redisFailurePolicy: 'closed' },
    });
    expect(() => createGateway(config, { logger: false })).toThrow(/REDIS_URL/);
  });
});

describe.skipIf(redis === undefined)('distributed rate limiting with real Redis (ADR-0034)', () => {
  it('two gateway instances enforce one shared budget under concurrent traffic', async () => {
    const url = redis?.url ?? '';
    // Same route id on both instances, so both use the same Redis bucket.
    const shared = nextRouteId();
    const a = await startRedisGateway(url, 'closed', 20, captureLogs(), shared);
    const b = await startRedisGateway(url, 'closed', 20, captureLogs(), shared);
    const statuses = (
      await Promise.all(Array.from({ length: 60 }, (_, i) => get(i % 2 === 0 ? a.port : b.port)))
    ).map((response) => response.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(20);
    expect(statuses.filter((s) => s === 429)).toHaveLength(40);
  });

  it('fail-closed: 503 RATE_LIMITER_UNAVAILABLE and not ready during an outage, then recovers', async () => {
    const proxy = await withProxy();
    const logs = captureLogs('debug');
    const gw = await startRedisGateway(redisUrlVia(proxy), 'closed', 1000, logs);
    expect((await get(gw.port)).status).toBe(200);
    expect(await readyBody(gw.opsPort)).toEqual({
      status: 200,
      body: { status: 'ready', redis: 'up' },
    });

    proxy.cut();
    const rejected = await get(gw.port);
    expect(rejected.status).toBe(503);
    expect(code(rejected)).toBe('RATE_LIMITER_UNAVAILABLE');
    expect(rejected.headers['retry-after']).toBe('1');
    expect(await readyBody(gw.opsPort)).toEqual({
      status: 503,
      body: { status: 'not_ready', redis: 'unavailable' },
    });
    // Liveness is independent of Redis.
    expect((await send(gw.opsPort, { path: '/health' })).status).toBe(200);

    proxy.restore();
    expect(await eventually(async () => (await get(gw.port)).status === 200)).toBe(true);
    expect(await eventually(async () => (await ready(gw.opsPort)) === 200)).toBe(true);

    const health = logs
      .lines()
      .map((line) => line['msg'])
      .filter(
        (msg) => msg === 'redis rate limiter unavailable' || msg === 'redis rate limiter recovered',
      );
    expect(health).toEqual(['redis rate limiter unavailable', 'redis rate limiter recovered']);
    // Debug level includes raw connection errors; none may contain the password.
    expect(JSON.stringify(logs.lines())).not.toContain(PASSWORD);
  });

  it('refuses to start when Redis is unreachable at boot, without binding ports', async () => {
    const proxy = await withProxy();
    proxy.cut();
    const { gateway, port, opsPort } = await redisGatewayUnstarted(redisUrlVia(proxy), 300);
    const started = performance.now();
    await expect(gateway.start()).rejects.toBeInstanceOf(GatewayStartupError);
    expect(performance.now() - started).toBeLessThan(1500);
    await expect(get(port)).rejects.toThrow(/ECONNREFUSED/);
    await expect(ready(opsPort)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('refuses to start with a wrong Redis password and never logs it', async () => {
    const wrong = 'wr0ng-pa$$word';
    const logs = captureLogs('debug');
    const url = `redis://:${encodeURIComponent(wrong)}@${redis?.host ?? ''}:${String(redis?.port ?? 0)}`;
    const { gateway } = await redisGatewayUnstarted(url, 500, logs);
    let error: unknown;
    try {
      await gateway.start();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GatewayStartupError);
    const surfaced = JSON.stringify({ message: (error as Error).message, logs: logs.lines() });
    expect(surfaced).not.toContain(wrong);
    expect(surfaced).not.toContain(encodeURIComponent(wrong));
    expect((error as Error).message).toContain(`${redis?.host ?? ''}:${String(redis?.port ?? 0)}`);
  });

  it('fail-closed: a stalled Redis is detected within the command timeout, with one probe in flight', async () => {
    const proxy = await withProxy();
    const gw = await startRedisGateway(redisUrlVia(proxy), 'closed', 1000);
    expect((await get(gw.port)).status).toBe(200);
    proxy.stall();
    const started = performance.now();
    const response = await get(gw.port);
    expect(response.status).toBe(503);
    expect(performance.now() - started).toBeLessThan(600);

    // 20 concurrent probes share one bounded ping and all report not ready promptly.
    const probeStart = performance.now();
    const statuses = await Promise.all(Array.from({ length: 20 }, () => ready(gw.opsPort)));
    expect(statuses.every((status) => status === 503)).toBe(true);
    expect(performance.now() - probeStart).toBeLessThan(600);
  });

  it('fail-open: per-instance buckets apply while Redis is down; ready, but reports degraded', async () => {
    const proxy = await withProxy();
    const gw = await startRedisGateway(redisUrlVia(proxy), 'open', 2);
    proxy.cut();
    const responses = [await get(gw.port), await get(gw.port), await get(gw.port)];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 429]);
    for (const response of responses) expect(response.headers['x-ratelimit-mode']).toBe('degraded');
    expect(await readyBody(gw.opsPort)).toEqual({
      status: 200,
      body: { status: 'ready', redis: 'unavailable', rateLimit: 'degraded' },
    });
    expect((await send(gw.opsPort, { path: '/health' })).status).toBe(200);

    proxy.restore();
    expect(
      await eventually(async () => (await get(gw.port)).headers['x-ratelimit-mode'] === undefined),
    ).toBe(true);
    expect(await readyBody(gw.opsPort)).toEqual({
      status: 200,
      body: { status: 'ready', redis: 'up' },
    });
  });
});

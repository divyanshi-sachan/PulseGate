import { parseClients } from '@pulsegate/config';
import { afterEach, describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.ts';
import {
  captureLogs,
  configFor,
  send,
  startGateway,
  startUpstream,
  type MockUpstream,
  type RawResponse,
  type RouteDef,
  type RunningGateway,
} from './harness.ts';

/**
 * Response cache end to end (ADR-0035, ADR-0036). The mock upstream echoes a per-call counter, so a
 * HIT is recognizable by a stale counter value; query parameters make it emit cache-relevant headers.
 */

const KEY_A = generateApiKey();
const KEY_B = generateApiKey();
const clients = parseClients({
  clients: [
    { id: 'client-a', keys: [{ id: 'k', sha256: hashApiKey(KEY_A) }] },
    { id: 'client-b', keys: [{ id: 'k', sha256: hashApiKey(KEY_B) }] },
  ],
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Mock upstream: body "call-<n>"; ?cc= Cache-Control, ?cookie=1 Set-Cookie, ?vary= Vary, ?status=, ?size=. */
function countingHandler(): Parameters<typeof startUpstream>[0] {
  let calls = 0;
  return (req, res) => {
    calls++;
    const params = new URL(req.url ?? '/', 'http://x').searchParams;
    const cc = params.get('cc');
    if (cc !== null) res.setHeader('cache-control', cc);
    if (params.get('cookie') === '1') res.setHeader('set-cookie', 'session=abc');
    const vary = params.get('vary');
    if (vary !== null) res.setHeader('vary', vary);
    res.statusCode = Number(params.get('status') ?? '200');
    res.setHeader('content-type', 'text/plain');
    const size = params.get('size');
    if (size !== null) {
      res.write('x'.repeat(Number(size) / 2));
      res.end('x'.repeat(Number(size) / 2));
      return;
    }
    res.end(`call-${String(calls)}`);
  };
}

interface Setup {
  gw: RunningGateway;
  upstream: MockUpstream;
  logs: ReturnType<typeof captureLogs>;
  advanceClock: (ms: number) => void;
}

const cached = (extra: RouteDef = {}): RouteDef => ({
  auth: { required: true },
  cache: { enabled: true, ttlSeconds: 30, maxResponseBytes: 1024 },
  ...extra,
});

async function setup(routes: RouteDef[], extra: Record<string, unknown> = {}): Promise<Setup> {
  const upstream = await startUpstream(countingHandler());
  cleanups.push(() => upstream.close());
  const logs = captureLogs();
  let now = 1_000_000;
  const gw = await startGateway(configFor(upstream.url, routes, extra), {
    ...logs.options,
    clients,
    cacheClock: () => now,
  });
  cleanups.push(() => gw.close());
  return {
    gw,
    upstream,
    logs,
    advanceClock: (ms) => {
      now += ms;
    },
  };
}

const as = (
  gw: RunningGateway,
  key: string,
  path = '/api/orders/1',
  headers: Record<string, string> = {},
) => send(gw.port, { path, headers: { 'x-api-key': key, ...headers } });

const xcache = (response: RawResponse) => response.headers['x-cache'];

describe('response cache (ADR-0036)', () => {
  it('serves a HIT without calling the upstream, with fresh gateway headers', async () => {
    const { gw, upstream } = await setup([cached()]);
    const miss = await as(gw, KEY_A);
    const hit = await as(gw, KEY_A);
    expect([xcache(miss), miss.body]).toEqual(['MISS', 'call-1']);
    expect([xcache(hit), hit.body, hit.status]).toEqual(['HIT', 'call-1', 200]);
    expect(upstream.requests).toHaveLength(1);
    expect(hit.headers.age).toBe('0');
    expect(hit.headers['content-type']).toBe('text/plain');
    expect(hit.headers['x-request-id']).not.toBe(miss.headers['x-request-id']);
    expect(hit.headers['x-ratelimit-limit']).toBeDefined();
  });

  it('isolates clients on authenticated routes by default', async () => {
    const { gw, upstream } = await setup([cached()]);
    expect((await as(gw, KEY_A)).body).toBe('call-1');
    expect((await as(gw, KEY_B)).body).toBe('call-2');
    expect((await as(gw, KEY_A)).body).toBe('call-1');
    expect((await as(gw, KEY_B)).body).toBe('call-2');
    expect(upstream.requests).toHaveLength(2);
  });

  it('shares entries across clients only with scope: "shared"', async () => {
    const { gw, upstream } = await setup([
      cached({ cache: { enabled: true, ttlSeconds: 30, scope: 'shared' } }),
    ]);
    expect((await as(gw, KEY_A)).body).toBe('call-1');
    const other = await as(gw, KEY_B);
    expect([xcache(other), other.body]).toEqual(['HIT', 'call-1']);
    expect(upstream.requests).toHaveLength(1);
  });

  it('still applies the rate limit to cache hits', async () => {
    const { gw } = await setup([
      cached({ rateLimit: { capacity: 2, refillRatePerSecond: 0.001 } }),
    ]);
    await as(gw, KEY_A);
    expect(xcache(await as(gw, KEY_A))).toBe('HIT');
    expect((await as(gw, KEY_A)).status).toBe(429);
  });

  it('expires entries after the TTL, capped by the upstream max-age', async () => {
    const { gw, advanceClock } = await setup([cached()]);
    await as(gw, KEY_A, '/api/orders/1');
    await as(gw, KEY_A, '/api/orders/2?cc=max-age%3D5');
    advanceClock(6000);
    expect(xcache(await as(gw, KEY_A, '/api/orders/1'))).toBe('HIT');
    expect(xcache(await as(gw, KEY_A, '/api/orders/2?cc=max-age%3D5'))).toBe('MISS');
    advanceClock(25_000);
    const expired = await as(gw, KEY_A, '/api/orders/1');
    expect([xcache(expired), expired.headers.age]).toEqual(['MISS', undefined]);
  });

  it.each([
    ['Set-Cookie', '?cookie=1'],
    ['Cache-Control: private', '?cc=private'],
    ['Cache-Control: no-store', '?cc=no-store'],
    ['a non-200 status', '?status=404'],
    ['an unconfigured Vary', '?vary=Accept-Language'],
  ])('never stores a response with %s', async (_label, query) => {
    const { gw, upstream, logs } = await setup([cached()]);
    await as(gw, KEY_A, `/api/orders/1${query}`);
    expect(xcache(await as(gw, KEY_A, `/api/orders/1${query}`))).toBe('MISS');
    expect(upstream.requests).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logs.lines()).toContainEqual(
      expect.objectContaining({
        msg: 'request completed',
        cacheStatus: 'miss',
        cacheStore: 'not_storable',
      }),
    );
  });

  it('varies on configured headers', async () => {
    const { gw, upstream } = await setup([
      cached({ cache: { enabled: true, ttlSeconds: 30, varyHeaders: ['Accept'] } }),
    ]);
    const json = { accept: 'application/json' };
    const html = { accept: 'text/html' };
    await as(gw, KEY_A, '/api/orders/1?vary=Accept', json);
    expect(xcache(await as(gw, KEY_A, '/api/orders/1?vary=Accept', json))).toBe('HIT');
    expect(xcache(await as(gw, KEY_A, '/api/orders/1?vary=Accept', html))).toBe('MISS');
    expect(upstream.requests).toHaveLength(2);
  });

  it('keeps distinct queries apart', async () => {
    const { gw } = await setup([cached()]);
    await as(gw, KEY_A, '/api/orders?page=1');
    expect(xcache(await as(gw, KEY_A, '/api/orders?page=2'))).toBe('MISS');
    expect(xcache(await as(gw, KEY_A, '/api/orders?page=1'))).toBe('HIT');
  });

  it('streams oversized bodies to the client in full but does not store them', async () => {
    const { gw, logs } = await setup([cached()]);
    const first = await as(gw, KEY_A, '/api/orders/1?size=4096');
    expect(first.body).toHaveLength(4096);
    expect(xcache(await as(gw, KEY_A, '/api/orders/1?size=4096'))).toBe('MISS');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logs.lines()).toContainEqual(expect.objectContaining({ cacheStore: 'too_large' }));
  });

  it('bypasses when the client sends no-cache or the Authorization header is forwarded', async () => {
    const { gw, upstream } = await setup([
      cached(),
      cached({ id: 'fwd', pathPrefix: '/api/fwd', forwarding: { authorization: true } }),
    ]);
    await as(gw, KEY_A);
    expect(xcache(await as(gw, KEY_A, '/api/orders/1', { 'cache-control': 'no-cache' }))).toBe(
      'BYPASS',
    );
    await as(gw, KEY_A, '/api/fwd', { authorization: 'Bearer t' });
    expect(xcache(await as(gw, KEY_A, '/api/fwd', { authorization: 'Bearer t' }))).toBe('BYPASS');
    expect(upstream.requests).toHaveLength(4);
  });

  it('serves hits while the upstream circuit breaker is open', async () => {
    const { gw, upstream } = await setup([cached()]);
    await as(gw, KEY_A, '/api/orders/1');
    // Five consecutive upstream 503s on other paths open the breaker (default failureThreshold 5).
    for (let i = 0; i < 5; i++) await as(gw, KEY_A, `/api/orders/err-${String(i)}?status=503`);
    const rejected = await as(gw, KEY_A, '/api/orders/uncached');
    expect(rejected.status).toBe(503);
    expect(rejected.body).toContain('CIRCUIT_OPEN');
    const calls = upstream.requests.length;
    const hit = await as(gw, KEY_A, '/api/orders/1');
    expect([hit.status, xcache(hit), hit.body]).toEqual([200, 'HIT', 'call-1']);
    expect(upstream.requests).toHaveLength(calls);
  });
});

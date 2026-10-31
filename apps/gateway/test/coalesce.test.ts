import { request as httpRequest } from 'node:http';
import { parseClients } from '@pulsegate/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.ts';
import {
  captureLogs,
  configFor,
  jsonBody,
  send,
  startGateway,
  startUpstream,
  type MockUpstream,
  type RawResponse,
  type RouteDef,
  type RunningGateway,
} from './harness.ts';

/**
 * Request deduplication end to end (ADR-0050, plan §4). The upstream holds every response until the test releases it,
 * so concurrent requests are provably in flight together; the test releases only after the gateway reports the
 * expected number of waiters (no sleeps for the main cases). Bodies are "call-<n>", so sharing is visible.
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

interface Gated {
  upstream: MockUpstream;
  release: () => void;
  /** Answers the next calls immediately instead of waiting. */
  open: () => void;
}

/** Upstream that answers with "call-<n>" once released. ?cookie=1 adds Set-Cookie; ?size=N pads the body. */
async function gatedUpstream(
  behavior: (call: number) => { status?: number } = () => ({}),
): Promise<Gated> {
  let released = false;
  const waiting: (() => void)[] = [];
  let calls = 0;
  const upstream = await startUpstream((req, res) => {
    const call = ++calls;
    const respond = () => {
      const { status = 200 } = behavior(call);
      const params = new URL(req.url ?? '/', 'http://x').searchParams;
      res.statusCode = status;
      res.setHeader('content-type', 'text/plain');
      if (params.get('cookie') === '1') res.setHeader('set-cookie', 'sid=abc');
      const size = Number(params.get('size') ?? '0');
      res.end(`call-${String(call)}${'x'.repeat(size)}`);
    };
    if (released) respond();
    else waiting.push(respond);
  });
  cleanups.push(() => upstream.close());
  return {
    upstream,
    release: () => {
      released = true;
      for (const respond of waiting.splice(0)) respond();
    },
    open: () => {
      released = true;
    },
  };
}

async function gateway(
  gated: Gated,
  cache: Record<string, unknown> = {},
  route: RouteDef = {},
  extra: Record<string, unknown> = {},
  logs = captureLogs(),
): Promise<{ gw: RunningGateway; logs: ReturnType<typeof captureLogs> }> {
  const gw = await startGateway(
    configFor(
      gated.upstream.url,
      [{ cache: { enabled: true, ttlSeconds: 60, scope: 'shared', ...cache }, ...route }],
      extra,
    ),
    { ...logs.options, clients },
  );
  cleanups.push(() => gw.close());
  return { gw, logs };
}

/** Starts n concurrent requests; resolves to their promises (not awaited). */
function burst(gw: RunningGateway, n: number, path = '/api/orders/item'): Promise<RawResponse>[] {
  return Array.from({ length: n }, () => send(gw.port, { path }));
}

const xcache = (responses: RawResponse[]) => responses.map((r) => r.headers['x-cache']).sort();

function metricValue(text: string, name: string, labels: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${name}{`) && l.includes(labels));
  return line === undefined ? 0 : Number(line.split(' ').at(-1));
}

describe('request deduplication (ADR-0050)', () => {
  it('makes one upstream call for concurrent misses and serves the rest from its entry', async () => {
    const gated = await gatedUpstream();
    const { gw, logs } = await gateway(gated);
    const pending = burst(gw, 8);
    await vi.waitFor(() => {
      expect(gated.upstream.requests).toHaveLength(1);
      expect(gw.gateway.coalescing.stats().waiters).toBe(7);
    });
    gated.release();
    const responses = await Promise.all(pending);

    expect(gated.upstream.requests).toHaveLength(1);
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(new Set(responses.map((r) => r.body))).toEqual(new Set(['call-1']));
    expect(xcache(responses)).toEqual(['COALESCED', ...Array<string>(6).fill('COALESCED'), 'MISS']);
    for (const r of responses) expect(r.headers['content-type']).toBe('text/plain');
    // Each response carries its own request ID.
    expect(new Set(responses.map((r) => r.headers['x-request-id'])).size).toBe(8);
    expect(gw.gateway.coalescing.stats()).toEqual({ pendingKeys: 0, waiters: 0 });

    // Metrics: 1 miss, 7 coalesced, one store, no fallbacks.
    const text = await gw.gateway.metrics.text();
    expect(metricValue(text, 'pulsegate_cache_requests_total', 'result="miss"')).toBe(1);
    expect(metricValue(text, 'pulsegate_cache_requests_total', 'result="coalesced"')).toBe(7);
    expect(metricValue(text, 'pulsegate_cache_stores_total', 'result="stored"')).toBe(1);
    expect(text).not.toContain('pulsegate_cache_coalesce_fallbacks_total{');

    // The log names the leader on every coalesced request.
    const leaderId = responses.find((r) => r.headers['x-cache'] === 'MISS')?.headers[
      'x-request-id'
    ];
    const completed = logs.lines().filter((l) => l['msg'] === 'request completed');
    const coalesced = completed.filter((l) => l['cacheStatus'] === 'coalesced');
    expect(coalesced).toHaveLength(7);
    for (const line of coalesced) expect(line['coalescedWith']).toBe(leaderId);

    // The stored entry now serves plain hits, with no new upstream call.
    const hit = await send(gw.port, { path: '/api/orders/item' });
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(hit.body).toBe('call-1');
    expect(gated.upstream.requests).toHaveLength(1);
  });

  it('never coalesces across clients on a per-client route', async () => {
    const gated = await gatedUpstream();
    const { gw } = await gateway(gated, { scope: 'client' }, { auth: { required: true } });
    const asClient = (key: string) =>
      send(gw.port, { path: '/api/orders/item', headers: { 'x-api-key': key } });
    const pending = [asClient(KEY_A), asClient(KEY_B), asClient(KEY_A), asClient(KEY_B)];
    await vi.waitFor(() => {
      expect(gated.upstream.requests).toHaveLength(2); // one leader per client
      expect(gw.gateway.coalescing.stats().waiters).toBe(2);
    });
    gated.release();
    const responses = await Promise.all(pending);
    expect(gated.upstream.requests).toHaveLength(2);
    // Each client's two requests share a body; the two clients' bodies differ.
    expect(responses[0]?.body).toBe(responses[2]?.body);
    expect(responses[1]?.body).toBe(responses[3]?.body);
    expect(responses[0]?.body).not.toBe(responses[1]?.body);
  });

  it('does not coalesce away rate limiting: waiters have each passed the limiter', async () => {
    const gated = await gatedUpstream();
    const { gw } = await gateway(
      gated,
      {},
      { rateLimit: { capacity: 3, refillRatePerSecond: 0.001 } },
    );
    const pending = burst(gw, 5);
    await vi.waitFor(() => {
      expect(gw.gateway.coalescing.stats().waiters).toBe(2); // leader + 2 waiters hold the 3 tokens
    });
    gated.release();
    const responses = await Promise.all(pending);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 429, 429]);
    expect(gated.upstream.requests).toHaveLength(1);
  });

  it('never shares a response the cache would not store (Set-Cookie): everyone fetches for themselves', async () => {
    const gated = await gatedUpstream();
    const { gw } = await gateway(gated);
    const pending = burst(gw, 3, '/api/orders/item?cookie=1');
    await vi.waitFor(() => {
      expect(gw.gateway.coalescing.stats().waiters).toBe(2);
    });
    gated.release();
    const responses = await Promise.all(pending);
    expect(gated.upstream.requests).toHaveLength(3);
    expect(new Set(responses.map((r) => r.body)).size).toBe(3);
    expect(xcache(responses)).toEqual(['MISS', 'MISS', 'MISS']);
    const text = await gw.gateway.metrics.text();
    expect(
      metricValue(text, 'pulsegate_cache_coalesce_fallbacks_total', 'reason="not_storable"'),
    ).toBe(2);
    expect(metricValue(text, 'pulsegate_cache_requests_total', 'result="coalesced"')).toBe(0);
  });

  it('never shares an oversized response: everyone fetches for themselves', async () => {
    const gated = await gatedUpstream();
    const { gw } = await gateway(gated, { maxResponseBytes: 16 });
    const pending = burst(gw, 3, '/api/orders/item?size=200');
    await vi.waitFor(() => {
      expect(gw.gateway.coalescing.stats().waiters).toBe(2);
    });
    gated.release();
    const responses = await Promise.all(pending);
    expect(gated.upstream.requests).toHaveLength(3);
    expect(xcache(responses)).toEqual(['MISS', 'MISS', 'MISS']);
    const text = await gw.gateway.metrics.text();
    expect(
      metricValue(text, 'pulsegate_cache_coalesce_fallbacks_total', 'reason="too_large"'),
    ).toBe(2);
  });

  it("does not hand the leader's upstream error to waiters: they fetch for themselves", async () => {
    const gated = await gatedUpstream((call) => ({ status: call === 1 ? 503 : 200 }));
    const { gw } = await gateway(gated);
    const pending = burst(gw, 3);
    await vi.waitFor(() => {
      expect(gw.gateway.coalescing.stats().waiters).toBe(2);
    });
    gated.release();
    const responses = await Promise.all(pending);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 503]);
    expect(gated.upstream.requests).toHaveLength(3);
  });

  it("hands off when the leader's client disconnects: one new upstream call serves the waiters", async () => {
    const gated = await gatedUpstream();
    const { gw } = await gateway(gated);
    // The leader, on a raw request we can abort.
    const leader = httpRequest({
      host: '127.0.0.1',
      port: gw.port,
      path: '/api/orders/item',
      agent: false,
    });
    leader.on('error', () => undefined);
    leader.end();
    await vi.waitFor(() => {
      expect(gated.upstream.requests).toHaveLength(1);
    });
    const waiters = burst(gw, 2);
    await vi.waitFor(() => {
      expect(gw.gateway.coalescing.stats().waiters).toBe(2);
    });
    leader.destroy();
    // One waiter becomes the new leader (a second upstream call); the other waits on it.
    await vi.waitFor(() => {
      expect(gated.upstream.requests).toHaveLength(2);
    });
    gated.release();
    const responses = await Promise.all(waiters);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(xcache(responses)).toEqual(['COALESCED', 'MISS']);
    expect(gated.upstream.requests).toHaveLength(2);
    const text = await gw.gateway.metrics.text();
    expect(metricValue(text, 'pulsegate_cache_coalesce_fallbacks_total', 'reason="handoff"')).toBe(
      2,
    );
    expect(gw.gateway.coalescing.stats()).toEqual({ pendingKeys: 0, waiters: 0 });
  });

  it("hands off when the leader's client leaves mid-body: the safety net ends the fill", async () => {
    let calls = 0;
    const upstream = await startUpstream((req, res) => {
      calls++;
      if (calls === 1) {
        // Headers and a first chunk, then silence: the leader's body never completes.
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10' });
        res.write('par');
        return;
      }
      res.setHeader('content-type', 'text/plain');
      res.end('whole-body');
    });
    cleanups.push(() => upstream.close());
    const gw = await startGateway(
      configFor(upstream.url, [{ cache: { enabled: true, ttlSeconds: 60, scope: 'shared' } }]),
      { logger: false },
    );
    cleanups.push(() => gw.close());

    const leader = httpRequest({
      host: '127.0.0.1',
      port: gw.port,
      path: '/api/orders/item',
      agent: false,
    });
    leader.on('error', () => undefined);
    const gotHeaders = new Promise<void>((resolve) => {
      leader.on('response', (res) => {
        res.on('error', () => undefined);
        res.resume();
        resolve();
      });
    });
    leader.end();
    await gotHeaders;
    const waiters = burst(gw, 2);
    await vi.waitFor(() => {
      expect(gw.gateway.coalescing.stats().waiters).toBe(2);
    });
    leader.destroy();
    const responses = await Promise.all(waiters);
    expect(responses.map((r) => [r.status, r.body])).toEqual([
      [200, 'whole-body'],
      [200, 'whole-body'],
    ]);
    expect(xcache(responses)).toEqual(['COALESCED', 'MISS']);
    expect(upstream.requests).toHaveLength(2);
    expect(gw.gateway.coalescing.stats()).toEqual({ pendingKeys: 0, waiters: 0 });
  });

  it('never extends the route deadline: a waiter that waited gets 504 no later than its own deadline', async () => {
    const gated = await gatedUpstream(); // never released
    const { gw } = await gateway(gated, {}, { timeoutMs: 400 });
    const started = performance.now();
    const pending = burst(gw, 3);
    const responses = await Promise.all(pending);
    const elapsed = performance.now() - started;
    expect(responses.map((r) => r.status)).toEqual([504, 504, 504]);
    for (const r of responses) {
      expect((jsonBody(r) as { error: { code: string } }).error.code).toBe('UPSTREAM_TIMEOUT');
    }
    // Waiting and any hand-off share one 400 ms budget; a second full timeout would take about 800 ms.
    expect(elapsed).toBeLessThan(700);
    expect(gw.gateway.coalescing.stats()).toEqual({ pendingKeys: 0, waiters: 0 });
    gated.open();
  });

  it('can be switched off per route: every concurrent miss goes upstream, as before', async () => {
    const gated = await gatedUpstream();
    const { gw } = await gateway(gated, { coalesce: false });
    const pending = burst(gw, 4);
    await vi.waitFor(() => {
      expect(gated.upstream.requests).toHaveLength(4);
    });
    expect(gw.gateway.coalescing.stats()).toEqual({ pendingKeys: 0, waiters: 0 });
    gated.release();
    const responses = await Promise.all(pending);
    expect(xcache(responses)).toEqual(['MISS', 'MISS', 'MISS', 'MISS']);
    const text = await gw.gateway.metrics.text();
    expect(metricValue(text, 'pulsegate_cache_requests_total', 'result="coalesced"')).toBe(0);
  });

  it('bounds waiters per key: beyond the bound, requests go upstream and the fallback is counted', async () => {
    const gated = await gatedUpstream();
    const { gw } = await gateway(
      gated,
      {},
      {},
      { responseCache: { coalesce: { maxWaitersPerKey: 2 } } },
    );
    const pending = burst(gw, 5);
    await vi.waitFor(() => {
      expect(gw.gateway.coalescing.stats().waiters).toBe(2);
      expect(gated.upstream.requests).toHaveLength(3); // the leader and the two requests beyond the bound
    });
    gated.release();
    const responses = await Promise.all(pending);
    expect(responses.map((r) => r.status)).toEqual(Array(5).fill(200));
    expect(gated.upstream.requests).toHaveLength(3);
    const text = await gw.gateway.metrics.text();
    expect(
      metricValue(text, 'pulsegate_cache_coalesce_fallbacks_total', 'reason="waiter_limit"'),
    ).toBe(2);
    expect(metricValue(text, 'pulsegate_cache_requests_total', 'result="coalesced"')).toBe(2);
  });

  it('bounds the keys being filled: further keys go upstream without coalescing', async () => {
    const gated = await gatedUpstream();
    const { gw } = await gateway(
      gated,
      {},
      {},
      { responseCache: { coalesce: { maxPendingKeys: 1 } } },
    );
    const a = send(gw.port, { path: '/api/orders/a' });
    await vi.waitFor(() => {
      expect(gw.gateway.coalescing.stats().pendingKeys).toBe(1);
    });
    const b = send(gw.port, { path: '/api/orders/b' });
    await vi.waitFor(() => {
      expect(gated.upstream.requests).toHaveLength(2);
    });
    gated.release();
    expect((await Promise.all([a, b])).map((r) => r.status)).toEqual([200, 200]);
    const text = await gw.gateway.metrics.text();
    expect(
      metricValue(text, 'pulsegate_cache_coalesce_fallbacks_total', 'reason="key_limit"'),
    ).toBe(1);
  });
});

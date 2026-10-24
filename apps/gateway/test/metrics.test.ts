import { request as httpRequest } from 'node:http';
import { parseClients } from '@pulsegate/config';
import { afterEach, describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.ts';
import {
  configFor,
  send,
  startGateway,
  startUpstream,
  type RouteDef,
  type RunningGateway,
} from './harness.ts';

/** Metrics end to end (ADR-0036): values match real traffic; label sets stay bounded. */

const KEY = generateApiKey();
const clients = parseClients({
  clients: [{ id: 'acme', keys: [{ id: 'k', sha256: hashApiKey(KEY) }] }],
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Minimal Prometheus text-format parser (counters, gauges, histogram series). */
function parse(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (match === null) continue;
    const labels: Record<string, string> = {};
    for (const pair of (match[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g))
      labels[pair[1] ?? ''] = pair[2] ?? '';
    samples.push({ name: match[1] ?? '', labels, value: Number(match[3]) });
  }
  return samples;
}

async function scrape(gw: RunningGateway): Promise<Sample[]> {
  const response = await gw.gateway.operations.inject({ url: '/metrics' });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toMatch(/^text\/plain/);
  return parse(response.body);
}

function value(samples: Sample[], name: string, labels: Record<string, string> = {}): number {
  return samples
    .filter((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))
    .reduce((sum, s) => sum + s.value, 0);
}

async function setup(
  routes: RouteDef[],
  handler?: Parameters<typeof startUpstream>[0],
  extra = {},
) {
  const upstream = await startUpstream(handler);
  cleanups.push(() => upstream.close());
  const gw = await startGateway(configFor(upstream.url, routes, extra), {
    logger: false,
    clients,
    random: () => 0,
  });
  cleanups.push(() => gw.close());
  return { gw, upstream };
}

describe('/metrics (ADR-0036)', () => {
  it('counts requests by route, status class and error code', async () => {
    const { gw } = await setup([
      {
        id: 'orders',
        auth: { required: true },
        rateLimit: { capacity: 3, refillRatePerSecond: 0.001 },
      },
    ]);
    const auth = { 'x-api-key': KEY };
    await send(gw.port, { path: '/api/orders', headers: auth });
    await send(gw.port, { path: '/api/orders', headers: auth });
    await send(gw.port, { path: '/api/orders' }); // 401
    await send(gw.port, { path: '/nope' }); // 404
    await send(gw.port, { path: '/api/orders', headers: auth });
    await send(gw.port, { path: '/api/orders', headers: auth }); // 429
    await new Promise((resolve) => setTimeout(resolve, 20));

    const m = await scrape(gw);
    const requests = 'pulsegate_requests_total';
    expect(value(m, requests, { route: 'orders', status_class: '2xx', code: 'none' })).toBe(3);
    expect(
      value(m, requests, { route: 'orders', status_class: '4xx', code: 'AUTHENTICATION_FAILED' }),
    ).toBe(1);
    expect(
      value(m, requests, { route: 'orders', status_class: '4xx', code: 'RATE_LIMIT_EXCEEDED' }),
    ).toBe(1);
    expect(
      value(m, requests, { route: 'unmatched', status_class: '4xx', code: 'ROUTE_NOT_FOUND' }),
    ).toBe(1);
    expect(value(m, 'pulsegate_request_duration_seconds_count', { route: 'orders' })).toBe(5);
    expect(
      value(m, 'pulsegate_rate_limit_decisions_total', {
        route: 'orders',
        decision: 'allowed',
        mode: 'local',
      }),
    ).toBe(3);
    expect(value(m, 'pulsegate_rate_limit_decisions_total', { decision: 'rejected' })).toBe(1);
    expect(
      value(m, 'pulsegate_upstream_requests_total', {
        upstream: 'orders-service',
        outcome: 'success',
      }),
    ).toBe(3);
    expect(value(m, 'pulsegate_active_requests')).toBe(0);
    expect(m.some((s) => s.name.startsWith('pulsegate_process_'))).toBe(true);
  });

  it('counts upstream attempts and retries separately from client requests', async () => {
    let calls = 0;
    const { gw } = await setup([{ id: 'flaky', retries: { maxAttempts: 3 } }], (_req, res) => {
      calls++;
      res.statusCode = calls <= 2 ? 503 : 200;
      res.end('x');
    });
    expect((await send(gw.port, { path: '/api/orders' })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const m = await scrape(gw);
    expect(value(m, 'pulsegate_requests_total', { route: 'flaky' })).toBe(1);
    expect(value(m, 'pulsegate_upstream_requests_total', { outcome: 'failure' })).toBe(2);
    expect(value(m, 'pulsegate_upstream_requests_total', { outcome: 'success' })).toBe(1);
    expect(value(m, 'pulsegate_upstream_duration_seconds_count')).toBe(3);
    expect(value(m, 'pulsegate_retries_total', { route: 'flaky' })).toBe(2);
  });

  it('tracks breaker transitions and the current state', async () => {
    const { gw } = await setup([{ id: 'down' }], (req) => req.socket.destroy(), {
      circuitBreaker: { failureThreshold: 2 },
    });
    let m = await scrape(gw);
    expect(
      value(m, 'pulsegate_circuit_breaker_state', { upstream: 'orders-service', state: 'closed' }),
    ).toBe(1);
    for (let i = 0; i < 3; i++) await send(gw.port, { path: '/api/orders' });
    m = await scrape(gw);
    expect(
      value(m, 'pulsegate_circuit_breaker_transitions_total', {
        upstream: 'orders-service',
        from: 'closed',
        to: 'open',
      }),
    ).toBe(1);
    expect(
      value(m, 'pulsegate_circuit_breaker_state', { upstream: 'orders-service', state: 'open' }),
    ).toBe(1);
    expect(
      value(m, 'pulsegate_circuit_breaker_state', { upstream: 'orders-service', state: 'closed' }),
    ).toBe(0);
    expect(value(m, 'pulsegate_requests_total', { code: 'CIRCUIT_OPEN' })).toBe(1);
  });

  it('reports cache lookups, stores and size', async () => {
    const { gw } = await setup([{ id: 'cached', cache: { enabled: true, ttlSeconds: 60 } }]);
    await send(gw.port, { path: '/api/orders/1' });
    await send(gw.port, { path: '/api/orders/1' });
    await send(gw.port, { path: '/api/orders/1', headers: { 'cache-control': 'no-cache' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const m = await scrape(gw);
    expect(value(m, 'pulsegate_cache_requests_total', { route: 'cached', result: 'miss' })).toBe(1);
    expect(value(m, 'pulsegate_cache_requests_total', { route: 'cached', result: 'hit' })).toBe(1);
    expect(value(m, 'pulsegate_cache_requests_total', { route: 'cached', result: 'bypass' })).toBe(
      1,
    );
    expect(value(m, 'pulsegate_cache_stores_total', { route: 'cached', result: 'stored' })).toBe(1);
    expect(value(m, 'pulsegate_cache_entries')).toBe(1);
    expect(value(m, 'pulsegate_cache_bytes')).toBeGreaterThan(0);
  });

  it('returns the in-flight gauge to 0 and counts a client abort once', async () => {
    const { gw } = await setup([{ id: 'slow' }], (_req, res) =>
      setTimeout(() => res.end('late'), 300),
    );
    await new Promise<void>((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port: gw.port, path: '/api/orders' });
      req.on('error', () => {
        resolve();
      });
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const m = await scrape(gw);
    expect(value(m, 'pulsegate_active_requests')).toBe(0);
    expect(value(m, 'pulsegate_requests_total', { route: 'slow', code: 'CLIENT_ABORTED' })).toBe(1);
    expect(value(m, 'pulsegate_requests_total', { route: 'slow' })).toBe(1);
  });

  it('keeps label sets bounded no matter what traffic arrives', async () => {
    const { gw } = await setup(
      [
        { id: 'orders', auth: { required: false } },
        { id: 'secure', pathPrefix: '/api/secure', auth: { required: true } },
      ],
      undefined,
      { server: { trustedProxies: ['127.0.0.1'] } },
    );
    const labelValues = async () => {
      const m = await scrape(gw);
      const values = new Map<string, Set<string>>();
      // Gateway metrics only: Node's runtime metrics (GC kinds etc.) are bounded but appear over time.
      for (const sample of m.filter(
        (s) => s.name.startsWith('pulsegate_') && !/^pulsegate_(process|nodejs)_/.test(s.name),
      )) {
        for (const [label, v] of Object.entries(sample.labels)) {
          if (label === 'le') continue;
          values.set(label, (values.get(label) ?? new Set()).add(v));
        }
      }
      return values;
    };

    // Warm-up covering every response kind once.
    await send(gw.port, { path: '/api/orders' });
    await send(gw.port, { path: '/nope' });
    await send(gw.port, { path: '/api/secure' });
    await send(gw.port, { path: '/api/secure', headers: { 'x-api-key': KEY } });
    const before = await labelValues();

    // Spray: random paths, ids in paths, many client IPs, bad keys, queries.
    for (let i = 0; i < 300; i++) {
      const rand = Math.random().toString(36).slice(2);
      await send(gw.port, {
        path: [`/api/orders/${rand}?q=${rand}`, `/x/${rand}`, `/api/secure/${rand}`][i % 3] ?? '/',
        headers: {
          'x-forwarded-for': `198.51.${String(i % 250)}.${String(i % 200)}`,
          ...(i % 2 === 0 ? { 'x-api-key': generateApiKey() } : {}),
        },
      });
    }
    const after = await labelValues();

    expect([...(after.get('route') ?? [])].sort()).toEqual(['orders', 'secure', 'unmatched']);
    for (const [label, values] of after) {
      expect({ label, values: [...values].sort() }).toEqual({
        label,
        values: [...(before.get(label) ?? [])].sort(),
      });
      for (const v of values) {
        expect(v).not.toMatch(/\/|req_|pg_|198\.51|acme/);
      }
    }
  });
});

describe('metrics review checks (ADR-0036 review)', () => {
  it('serves /metrics only on the operations listener', async () => {
    const { gw } = await setup([{ id: 'orders' }]);
    const publicResponse = await send(gw.port, { path: '/metrics' });
    expect(publicResponse.status).toBe(404);
    expect(publicResponse.body).toContain('ROUTE_NOT_FOUND');
    expect(publicResponse.body).not.toContain('pulsegate_');
    expect((await gw.gateway.operations.inject({ url: '/metrics' })).statusCode).toBe(200);
  });

  it('counts a cache hit as a request but not as an upstream attempt', async () => {
    const { gw } = await setup([{ id: 'cached', cache: { enabled: true, ttlSeconds: 60 } }]);
    await send(gw.port, { path: '/api/orders/1' });
    await send(gw.port, { path: '/api/orders/1' });
    await send(gw.port, { path: '/api/orders/1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const m = await scrape(gw);
    expect(value(m, 'pulsegate_requests_total', { route: 'cached' })).toBe(3);
    expect(value(m, 'pulsegate_upstream_requests_total')).toBe(1);
    expect(value(m, 'pulsegate_upstream_duration_seconds_count')).toBe(1);
    expect(value(m, 'pulsegate_retries_total')).toBe(0);
  });

  it('follows a full breaker cycle: closed -> open -> half-open -> closed', async () => {
    let healthy = false;
    const upstream = await startUpstream((req, res) => {
      if (healthy) res.end('ok');
      else req.socket.destroy();
    });
    cleanups.push(() => upstream.close());
    let clock = 0;
    const gw = await startGateway(
      configFor(upstream.url, [{ id: 'flappy' }], {
        circuitBreaker: { failureThreshold: 1, openDurationMs: 1000 },
      }),
      { logger: false, breakerClock: () => clock },
    );
    cleanups.push(() => gw.close());
    await send(gw.port, { path: '/api/orders' }); // fail -> open
    await send(gw.port, { path: '/api/orders' }); // rejected while open
    healthy = true;
    clock += 1000;
    await send(gw.port, { path: '/api/orders' }); // probe succeeds -> closed
    await new Promise((resolve) => setTimeout(resolve, 20));
    const m = await scrape(gw);
    const transition = (from: string, to: string) =>
      value(m, 'pulsegate_circuit_breaker_transitions_total', {
        upstream: 'orders-service',
        from,
        to,
      });
    expect([
      transition('closed', 'open'),
      transition('open', 'half-open'),
      transition('half-open', 'closed'),
    ]).toEqual([1, 1, 1]);
    expect(
      value(m, 'pulsegate_circuit_breaker_state', { upstream: 'orders-service', state: 'closed' }),
    ).toBe(1);
    expect(
      value(m, 'pulsegate_circuit_breaker_state', { upstream: 'orders-service', state: 'open' }),
    ).toBe(0);
    expect(value(m, 'pulsegate_upstream_requests_total')).toBe(2); // the failure and the probe
    expect(value(m, 'pulsegate_requests_total', { route: 'flappy', code: 'CIRCUIT_OPEN' })).toBe(1);
  });

  it('stays internally consistent across a mix of hits, retries, aborts and errors', async () => {
    // The flaky path fails only on its own first call, whatever else happened before.
    let flakyCalls = 0;
    const upstream = await startUpstream((req, res) => {
      const url = req.url ?? '';
      if (url.includes('flaky') && ++flakyCalls === 1) {
        res.statusCode = 503;
        res.end('busy');
      } else if (url.includes('slow')) setTimeout(() => res.end('late'), 300);
      else res.end('ok');
    });
    cleanups.push(() => upstream.close());
    const gw = await startGateway(
      configFor(upstream.url, [
        { id: 'mixed', retries: { maxAttempts: 2 }, cache: { enabled: true, ttlSeconds: 60 } },
      ]),
      { logger: false, random: () => 0 },
    );
    cleanups.push(() => gw.close());

    const sent = { total: 0 };
    const go = async (path: string) => {
      sent.total++;
      return send(gw.port, { path });
    };
    await go('/api/orders/cached');
    await go('/api/orders/cached'); // hit
    await go('/api/orders/flaky-1'); // 503 then 200
    await go('/nope'); // 404 unmatched
    sent.total++;
    await new Promise<void>((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port: gw.port, path: '/api/orders/slow' });
      req.on('error', () => {
        resolve();
      });
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const m = await scrape(gw);
    expect(value(m, 'pulsegate_requests_total')).toBe(sent.total);
    expect(value(m, 'pulsegate_request_duration_seconds_count')).toBe(sent.total);
    expect(value(m, 'pulsegate_active_requests')).toBe(0);
    // Attempts: cached miss 1 + flaky 2 + slow 1 (aborted) = 4; the hit and the 404 never reach the upstream.
    expect(value(m, 'pulsegate_upstream_requests_total')).toBe(4);
    expect(value(m, 'pulsegate_upstream_requests_total', { outcome: 'aborted' })).toBe(1);
    expect(value(m, 'pulsegate_retries_total', { route: 'mixed' })).toBe(1);
    expect(value(m, 'pulsegate_requests_total', { code: 'CLIENT_ABORTED' })).toBe(1);
  });
});

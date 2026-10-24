import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { statsResponseSchema, type RouteCounters } from '@pulsegate/admin-contract';
import { loadConfigFile, parseClients } from '@pulsegate/config';
import { createGateway, type Gateway } from '@pulsegate/gateway';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey } from '../../apps/gateway/src/auth/api-key.ts';

/**
 * Real public API smoke tests (docs/plans/real-data-testing.md §1, ADR-0045): correctness through PulseGate against
 * Postman Echo and httpbin. Opt-in (`pnpm test:real`); never load. Etiquette:
 * - at most BUDGET requests to the providers per run (gateway-forwarded + direct), enforced below;
 * - sequential, at least PACE_MS apart, with a descriptive User-Agent, no retries;
 * - a provider that fails its preflight is reported as skipped, never as passed or as a gateway failure.
 */
const BUDGET = 30;
const PACE_MS = 250;
const USER_AGENT = 'PulseGate-real-api-smoke/1.0 (+https://github.com/divyanshi-sachan/PulseGate)';
const ADMIN_TOKEN = createHash('sha256').update(String(Math.random())).digest('hex');
const ECHO = 'https://postman-echo.com';
const HTTPBIN = 'https://httpbin.org';

const KEY = generateApiKey();
let gateway: Gateway;
let gatewayUrl = '';
let adminUrl = '';
const available = { echo: false, httpbin: false };
/** Why a provider isn't available, for the skip note. */
const unavailableBecause: Partial<Record<keyof typeof available, string>> = {};
/** Requests that reached (or were sent directly to) a provider, counted against BUDGET. */
let providerRequests = 0;
let lastProviderRequestAt = 0;

/** What the tests sent, per route, for R9's comparison with the admin API. */
interface Tally {
  requests: number;
  status: Record<'2xx' | '4xx' | '5xx', number>;
  codes: Record<string, number>;
  attemptsSuccess: number;
  cache: { hit: number; miss: number; bypass: number };
  notStorable: number;
}
const tally: Record<string, Tally> = {};
function routeTally(id: string): Tally {
  tally[id] ??= {
    requests: 0,
    status: { '2xx': 0, '4xx': 0, '5xx': 0 },
    codes: {},
    attemptsSuccess: 0,
    cache: { hit: 0, miss: 0, bypass: 0 },
    notStorable: 0,
  };
  return tally[id];
}

async function pace(): Promise<void> {
  const wait = lastProviderRequestAt + PACE_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastProviderRequestAt = Date.now();
}

function spend(): void {
  providerRequests++;
  // Fail loudly before exceeding the budget, rather than after.
  if (providerRequests > BUDGET) throw new Error(`request budget exceeded (${String(BUDGET)})`);
}

async function direct(url: string): Promise<Response> {
  spend();
  await pace();
  return fetch(url, { headers: { 'user-agent': USER_AGENT } });
}

interface Sent {
  route: string;
  /** Does this request reach the provider? (false for 401/429 decided by the gateway, and cache hits) */
  reachesUpstream: boolean;
}

/** A request through the gateway, recorded in the tally. The provider budget is spent only when it is reached. */
async function viaGateway(
  path: string,
  sent: Sent,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  if (sent.reachesUpstream) {
    spend();
    await pace();
  }
  const response = await fetch(`${gatewayUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'user-agent': USER_AGENT, ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
    redirect: 'manual',
  });
  const t = routeTally(sent.route);
  t.requests++;
  const klass = `${String(Math.floor(response.status / 100))}xx` as keyof Tally['status'];
  if (klass in t.status) t.status[klass]++;
  const cache = response.headers.get('x-cache')?.toLowerCase();
  if (cache === 'hit' || cache === 'miss' || cache === 'bypass') t.cache[cache]++;
  if (sent.reachesUpstream && response.status < 400) t.attemptsSuccess++;
  return response;
}

/** The gateway's normalized error code, or undefined when the response came from the provider. */
async function gatewayCode(response: Response): Promise<string | undefined> {
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return undefined;
  const body = (await response.clone().json()) as {
    error?: { code?: unknown; requestId?: unknown };
  };
  return typeof body.error?.code === 'string' && typeof body.error.requestId === 'string'
    ? body.error.code
    : undefined;
}

function sha256(buffer: ArrayBuffer): string {
  return createHash('sha256').update(Buffer.from(buffer)).digest('hex');
}

beforeAll(async () => {
  const config = await loadConfigFile(
    fileURLToPath(new URL('../../config/routes.real.yaml', import.meta.url)),
  );
  const clients = parseClients({
    clients: [{ id: 'real-smoke', keys: [{ id: 'k1', sha256: hashApiKey(KEY) }] }],
  });
  gateway = createGateway(config, { logger: false, clients, adminToken: ADMIN_TOKEN });
  await gateway.public.listen({ host: '127.0.0.1', port: 0 });
  await gateway.admin?.listen({ host: '127.0.0.1', port: 0 });
  gatewayUrl = `http://127.0.0.1:${String((gateway.public.server.address() as AddressInfo).port)}`;
  adminUrl = `http://127.0.0.1:${String((gateway.admin?.server.address() as AddressInfo).port)}`;

  // Preflight: one direct request per provider. REAL_API_ONLY=echo|httpbin limits a run to one provider (e.g. when the
  // other is known to be down); the excluded one is reported as skipped, through the same path as a failed preflight.
  // An empty value (the workflow's default input) means both providers.
  const rawOnly = process.env['REAL_API_ONLY'];
  const only = rawOnly === undefined || rawOnly === '' ? undefined : rawOnly;
  for (const [name, url] of [
    ['echo', `${ECHO}/get?preflight=1`],
    ['httpbin', `${HTTPBIN}/get`],
  ] as const) {
    if (only !== undefined && only !== name) {
      unavailableBecause[name] = 'excluded by REAL_API_ONLY';
      continue;
    }
    try {
      const response = await direct(url);
      available[name] = response.ok;
      if (!response.ok) unavailableBecause[name] = `preflight answered ${String(response.status)}`;
    } catch (error) {
      available[name] = false;
      unavailableBecause[name] =
        `preflight failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
});

afterAll(async () => {
  await gateway.close();
  console.log(`provider requests this run: ${String(providerRequests)} of ${String(BUDGET)}`);
  console.log(`providers available: ${JSON.stringify(available)}`);
});

function needs(provider: keyof typeof available, skip: (note?: string) => void): void {
  if (!available[provider]) {
    skip(
      `${provider} not tested: ${unavailableBecause[provider] ?? 'unavailable'} (not a gateway result)`,
    );
  }
}

const withKey = { 'x-api-key': KEY };

describe('Postman Echo through PulseGate', () => {
  let echoed: { args: unknown; url: string; headers: Record<string, string> } | undefined;
  let requestId: string | null = null;

  it('R1: routes, strips the prefix and keeps the query untouched', async ({ skip }) => {
    needs('echo', skip);
    const response = await viaGateway(
      '/real/echo/get?a=1&b=two',
      {
        route: 'real-echo',
        reachesUpstream: true,
      },
      { headers: { ...withKey, 'x-pulsegate-probe': 'kept' } },
    );
    expect(response.status, 'upstream status').toBe(200);
    expect(await gatewayCode(response)).toBeUndefined();
    requestId = response.headers.get('x-request-id');
    echoed = (await response.json()) as typeof echoed;
    expect(echoed?.args).toEqual({ a: '1', b: 'two' });
    expect(echoed?.url).toBe('https://postman-echo.com/get?a=1&b=two');
    routeTally('real-echo').notStorable++; // Set-Cookie: never stored (ADR-0036)
  });

  it('R2: strips the API key and passes end-to-end headers (User-Agent, custom headers)', ({
    skip,
  }) => {
    needs('echo', skip);
    if (echoed === undefined) {
      skip('R1 produced no echo');
      return;
    }
    const headers = echoed.headers;
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['user-agent']).toBe(USER_AGENT);
    expect(headers['x-pulsegate-probe']).toBe('kept');
    expect(requestId).toMatch(/^req_/);
    // X-Request-ID and X-Forwarded-For can't be checked here: Postman Echo's edge drops both even on direct requests
    // (probed 2026-10-24). Their forwarding is covered by apps/gateway/test/proxy.test.ts against a local upstream.
  });

  it('R3: forwards a JSON body on POST, exactly once', async ({ skip }) => {
    needs('echo', skip);
    const payload = { order: 42, items: ['a', 'b'], note: 'ünïcødé' };
    const response = await viaGateway(
      '/real/echo/post',
      { route: 'real-echo', reachesUpstream: true },
      {
        method: 'POST',
        headers: { ...withKey, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    expect(response.status, 'upstream status').toBe(200);
    expect(response.headers.get('x-cache')).toBe('BYPASS'); // POST never uses the cache
    expect(((await response.json()) as { json: unknown }).json).toEqual(payload);
  });

  it('R5: rejects a missing or wrong key without calling the provider', async ({ skip }) => {
    needs('echo', skip);
    const missing = await viaGateway('/real/echo/get', {
      route: 'real-echo',
      reachesUpstream: false,
    });
    const wrong = await viaGateway(
      '/real/echo/get',
      { route: 'real-echo', reachesUpstream: false },
      {
        headers: { 'x-api-key': generateApiKey() },
      },
    );
    for (const response of [missing, wrong]) {
      expect(response.status).toBe(401);
      expect(await gatewayCode(response)).toBe('AUTHENTICATION_FAILED');
    }
    routeTally('real-echo').codes['AUTHENTICATION_FAILED'] = 2;
  });

  it('R6: allows 3, then rejects with 429 and rate-limit headers, without calling the provider', async ({
    skip,
  }) => {
    needs('echo', skip);
    const results: Response[] = [];
    for (let i = 0; i < 4; i++) {
      results.push(
        await viaGateway(`/real/limited/get?i=${String(i)}`, {
          route: 'real-limited',
          reachesUpstream: i < 3,
        }),
      );
    }
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 429]);
    const limited = results[3];
    if (limited === undefined) throw new Error('no fourth response');
    expect(await gatewayCode(limited)).toBe('RATE_LIMIT_EXCEEDED');
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(limited.headers.get('x-ratelimit-limit')).toBe('3');
    routeTally('real-limited').codes['RATE_LIMIT_EXCEEDED'] = 1;
  });

  it('R8: never stores a response that sets cookies, even on a cache-enabled route', async ({
    skip,
  }) => {
    needs('echo', skip);
    for (let i = 0; i < 2; i++) {
      const response = await viaGateway(
        '/real/echo/get?cookie-check=1',
        {
          route: 'real-echo',
          reachesUpstream: true,
        },
        { headers: withKey },
      );
      expect(response.status, 'upstream status').toBe(200);
      expect(response.headers.get('set-cookie')).not.toBeNull();
      expect(response.headers.get('x-cache')).toBe('MISS');
      routeTally('real-echo').notStorable++;
    }
  });
});

describe('httpbin through PulseGate', () => {
  it('R2b: never forwards X-API-Key, where the provider would visibly echo it', async ({
    skip,
  }) => {
    needs('httpbin', skip);
    const probe = {
      'x-api-key': 'pg_should_never_reach_the_upstream',
      'x-pulsegate-probe': 'kept',
    };
    // Control: sent directly, httpbin echoes the key, so its absence below is the gateway's doing.
    spend();
    await pace();
    const control = await fetch(`${HTTPBIN}/headers`, {
      headers: { 'user-agent': USER_AGENT, ...probe },
    });
    const controlHeaders = ((await control.json()) as { headers: Record<string, string> }).headers;
    expect(controlHeaders['X-Api-Key']).toBe(probe['x-api-key']);

    const response = await viaGateway(
      '/real/httpbin/headers',
      { route: 'real-httpbin', reachesUpstream: true },
      { headers: probe },
    );
    expect(response.status, 'upstream status').toBe(200);
    const headers = ((await response.json()) as { headers: Record<string, string> }).headers;
    expect(headers['X-Api-Key']).toBeUndefined();
    expect(headers['X-Pulsegate-Probe']).toBe('kept');
    expect(headers['User-Agent']).toBe(USER_AGENT);
  });

  it('R4: returns byte-identical bodies and keeps the content type', async ({ skip }) => {
    needs('httpbin', skip);
    // "PulseGate response integrity check", base64url-encoded: a fixed, deterministic body.
    const paths = ['/base64/UHVsc2VHYXRlIHJlc3BvbnNlIGludGVncml0eSBjaGVjaw==', '/json'];
    for (const path of paths) {
      const viaGw = await viaGateway(`/real/httpbin${path}`, {
        route: 'real-httpbin',
        reachesUpstream: true,
      });
      const straight = await direct(`${HTTPBIN}${path}`);
      expect(viaGw.status, `upstream status for ${path}`).toBe(200);
      expect(straight.status).toBe(200);
      expect(viaGw.headers.get('content-type')).toBe(straight.headers.get('content-type'));
      expect(sha256(await viaGw.arrayBuffer()), path).toBe(sha256(await straight.arrayBuffer()));
    }
  });

  it('R7: caches what the provider allows (max-age=60): MISS, then HIT with Age, one upstream call', async ({
    skip,
  }) => {
    needs('httpbin', skip);
    const first = await viaGateway('/real/httpbin/cache/60', {
      route: 'real-httpbin',
      reachesUpstream: true,
    });
    expect(first.status, 'upstream status').toBe(200);
    expect(first.headers.get('cache-control')).toBe('public, max-age=60');
    expect(first.headers.get('x-cache')).toBe('MISS');
    const firstBody = sha256(await first.arrayBuffer());

    const second = await viaGateway('/real/httpbin/cache/60', {
      route: 'real-httpbin',
      reachesUpstream: false,
    });
    expect(second.headers.get('x-cache')).toBe('HIT');
    expect(Number(second.headers.get('age'))).toBeGreaterThanOrEqual(0);
    expect(sha256(await second.arrayBuffer())).toBe(firstBody);
  });
});

describe('admin API agrees with what was sent', () => {
  it('R9: requests, statuses, codes, upstream attempts and cache outcomes per route', async ({
    skip,
  }) => {
    if (!available.echo && !available.httpbin) skip('no provider available');
    const response = await fetch(`${adminUrl}/admin/api/stats`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const stats = statsResponseSchema.parse(await response.json());
    for (const [id, expected] of Object.entries(tally)) {
      const counters: RouteCounters | undefined = stats.routes.find((r) => r.id === id)?.series
        .window.counters;
      expect(counters, id).toBeDefined();
      expect(counters?.requests, `${id} requests`).toBe(expected.requests);
      expect(counters?.status['2xx'], `${id} 2xx`).toBe(expected.status['2xx']);
      expect(counters?.status['4xx'], `${id} 4xx`).toBe(expected.status['4xx']);
      expect(counters?.status['5xx'], `${id} 5xx`).toBe(expected.status['5xx']);
      for (const [code, count] of Object.entries(expected.codes)) {
        expect(counters?.codes[code], `${id} ${code}`).toBe(count);
      }
      expect(counters?.attempts, `${id} attempts`).toEqual({
        success: expected.attemptsSuccess,
        failure: 0,
        aborted: 0,
      });
      expect(counters?.cache, `${id} cache`).toEqual(expected.cache);
      if (id === 'real-echo') expect(counters?.store.notStorable).toBe(expected.notStorable);
    }
    expect(providerRequests).toBeLessThanOrEqual(BUDGET);
  });
});

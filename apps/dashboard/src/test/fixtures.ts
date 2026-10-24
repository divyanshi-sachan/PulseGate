import {
  cacheResponseSchema,
  rateLimitsResponseSchema,
  routesResponseSchema,
  statsResponseSchema,
  upstreamsResponseSchema,
  type CacheResponse,
  type RateLimitsResponse,
  type RoutesResponse,
  type StatsResponse,
  type UpstreamsResponse,
} from '@pulsegate/admin-contract';
import { StatsWindow } from '@pulsegate/observability';
import type { AdminApi } from '../api/client.ts';

/**
 * Contract fixtures come from the gateway's real StatsWindow, then pass through the shared (strict) schemas, so the
 * dashboard's tests can't use a field the API doesn't define or drift from what it actually sends (plan §6).
 */
export const T0 = 1_700_000_000_000;
export const ROUTES = ['orders', 'payments'] as const;

export function trafficWindow() {
  let t = 5_000;
  const window = new StatsWindow({
    routes: [...ROUTES],
    upstreams: ['orders-service'],
    wallClock: () => T0,
    monotonic: () => t,
    random: () => 0.5,
    instanceId: 'gw_fixture',
  });
  return {
    window,
    advance: (ms: number) => {
      t += ms;
    },
    /** A completed request on a route. */
    request: (routeId: string, statusCode: number, latencyMs: number, code?: string) => {
      window.recordRequest({ routeId, statusCode, latencyMs, code });
    },
  };
}

export function statsOf(window: StatsWindow): StatsResponse {
  return statsResponseSchema.parse({
    ...window.envelope(),
    total: window.totalSeries(),
    routes: ROUTES.map((id) => ({ id, series: window.routeSeries(id) })),
  });
}

export function statsFixture(
  requests: { latencyMs: number; statusCode: number }[] = [],
): StatsResponse {
  const { window, request } = trafficWindow();
  for (const r of requests) request('orders', r.statusCode, r.latencyMs);
  return statsOf(window);
}

export function upstreamsOf(
  window: StatsWindow,
  breaker: { state: 'closed' | 'open' | 'half-open'; consecutiveFailures: number },
): UpstreamsResponse {
  return upstreamsResponseSchema.parse({
    ...window.envelope(),
    upstreams: [
      {
        id: 'orders-service',
        baseUrl: 'http://orders-mock:4001',
        breaker: {
          ...breaker,
          halfOpenInFlight: 0,
          settings: {
            failureThreshold: 2,
            openDurationMs: 600_000,
            halfOpenMaxRequests: 1,
            halfOpenSuccessThreshold: 1,
            failureStatuses: [500, 502, 503, 504],
          },
        },
        series: window.upstreamSeries('orders-service'),
      },
    ],
  });
}

export function cacheOf(window: StatsWindow, usage = { entries: 1, bytes: 2048 }): CacheResponse {
  return cacheResponseSchema.parse({
    ...window.envelope(),
    limits: { maxEntries: 10_000, maxBytes: 67_108_864 },
    usage,
    evictions: { lifetime: { capacity: 3, expired: 7 } },
    routes: [
      { id: 'orders', scope: 'shared', ttlSeconds: 600, series: window.routeSeries('orders') },
    ],
  });
}

export function rateLimitsOf(
  window: StatsWindow,
  backend: RateLimitsResponse['backend'] = {
    kind: 'local',
    healthy: true,
    target: null,
    degraded: false,
  },
): RateLimitsResponse {
  return rateLimitsResponseSchema.parse({
    ...window.envelope(),
    mode: backend.kind,
    redisFailurePolicy: backend.kind === 'redis' ? 'open' : null,
    backend,
    maxBuckets: 100_000,
    routes: ROUTES.map((id) => ({
      id,
      policy: { capacity: 3, refillRatePerSecond: 0.001 },
      series: window.routeSeries(id),
    })),
  });
}

export function routesConfigOf(window: StatsWindow): RoutesResponse {
  const route = (id: string, pathPrefix: string, cache: boolean) => ({
    id,
    pathPrefix,
    methods: ['GET'],
    upstreamId: 'orders-service',
    stripPrefix: false,
    authRequired: id === 'payments',
    rateLimit: { capacity: 3, refillRatePerSecond: 0.001 },
    timeoutMs: 3000,
    attemptTimeoutMs: null,
    retries: {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 1000,
      retryableStatuses: [502, 503, 504],
    },
    cache: cache
      ? {
          enabled: true,
          ttlSeconds: 600,
          scope: 'shared',
          varyHeaders: [],
          maxResponseBytes: 262_144,
        }
      : { enabled: false, ttlSeconds: null, scope: null, varyHeaders: [], maxResponseBytes: null },
    forwarding: { authorization: false, forwardedHost: false },
  });
  return routesResponseSchema.parse({
    ...window.envelope(),
    routes: [route('orders', '/api/orders', true), route('payments', '/api/payments', false)],
  });
}

/** An AdminApi whose endpoints answer from the given fixtures (or reject when missing). */
export function fakeApi(answers: {
  stats?: () => Promise<StatsResponse>;
  upstreams?: () => Promise<UpstreamsResponse>;
  routes?: () => Promise<RoutesResponse>;
  rateLimits?: () => Promise<RateLimitsResponse>;
  cache?: () => Promise<CacheResponse>;
}): AdminApi {
  const missing = () => Promise.reject(new Error('not used in this test'));
  return {
    stats: answers.stats ?? missing,
    upstreams: answers.upstreams ?? missing,
    routes: answers.routes ?? missing,
    rateLimits: answers.rateLimits ?? missing,
    cache: answers.cache ?? missing,
  };
}

/** A fetch double that answers every request with `status` and a JSON (or raw) body, recording calls. */
export function fakeFetch(answer: { status: number; body?: unknown; raw?: string }) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
    const text = answer.raw ?? JSON.stringify(answer.body ?? null);
    return Promise.resolve(
      new Response(text, {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch, calls };
}

export const TOKEN = 'f'.repeat(40);

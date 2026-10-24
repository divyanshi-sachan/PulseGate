import type {
  CacheResponse,
  RateLimitsResponse,
  RoutesResponse,
  StatsResponse,
  UpstreamsResponse,
} from '@pulsegate/admin-contract';
import type { MemoryCacheStats } from '@pulsegate/cache';
import type { GatewayConfig } from '@pulsegate/config';
import type { StatsWindow } from '@pulsegate/observability';
import type { CircuitBreakerRegistry } from '@pulsegate/reliability';
import { GatewayError } from '@pulsegate/shared';
import fastify, { type FastifyReply, type FastifyServerOptions } from 'fastify';
import type { AdminTokenVerifier } from './admin-token.ts';

export interface RateLimitBackend {
  kind: 'local' | 'redis';
  healthy: boolean;
  /** host:port only (ADR-0034). */
  target: string | null;
  degraded: boolean;
}

export interface AdminServerDeps {
  config: GatewayConfig;
  stats: StatsWindow;
  breakers: CircuitBreakerRegistry;
  cacheStats: () => MemoryCacheStats;
  rateLimitBackend: () => RateLimitBackend;
  verifier: AdminTokenVerifier;
  fastifyOptions: FastifyServerOptions;
}

export interface AdminRoute {
  method: string;
  url: string;
}

function sendError(reply: FastifyReply, error: GatewayError, requestId: string): FastifyReply {
  return reply
    .code(error.status)
    .header('content-type', 'application/json; charset=utf-8')
    .header('x-request-id', requestId)
    .send(error.toBody(requestId));
}

/**
 * Admin listener (ADR-0020, plan §5): read-only JSON under /admin/api/*, shaped by the shared contracts in
 * `@pulsegate/admin-contract`. One Bearer-token hook, registered before any route, guards every request
 * the listener receives, including unknown paths; `routes` lists what was registered for the bypass test.
 */
export function buildAdminServer(deps: AdminServerDeps) {
  const { config, stats, breakers, verifier } = deps;
  const app = fastify(deps.fastifyOptions);
  const routes: AdminRoute[] = [];
  const authFailures = new WeakSet<object>();

  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) routes.push({ method, url: route.url });
  });

  app.addHook('onRequest', (request, reply, done) => {
    if (verifier.verify(request.headers.authorization)) {
      done();
      return;
    }
    authFailures.add(request);
    void reply.header('www-authenticate', 'Bearer');
    void sendError(reply, new GatewayError('ADMIN_AUTHENTICATION_FAILED'), request.id);
  });

  // JSON only, never cached by browsers or proxies, never sniffed or framed (plan §5).
  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.headers({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
    done(null, payload);
  });

  app.addHook('onResponse', (request, reply, done) => {
    const queryStart = (request.raw.url ?? '').indexOf('?');
    request.log.info(
      {
        method: request.raw.method,
        path: queryStart === -1 ? request.raw.url : request.raw.url?.slice(0, queryStart),
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime * 100) / 100,
        errorCode: authFailures.has(request) ? 'ADMIN_AUTHENTICATION_FAILED' : undefined,
      },
      'admin request completed',
    );
    done();
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(reply, new GatewayError('ROUTE_NOT_FOUND'), request.id),
  );
  app.setErrorHandler((error, request, reply) => {
    request.log.warn({ err: error }, 'admin request failed');
    return sendError(reply, new GatewayError('INTERNAL_ERROR', { cause: error }), request.id);
  });

  const series = (id: string) => {
    const result = stats.routeSeries(id);
    // Every configured route has a series; a missing one is a wiring bug, not a client error.
    if (result === undefined) throw new Error(`no stats series for route ${id}`);
    return result;
  };

  app.get('/admin/api/stats', (): StatsResponse => ({
    ...stats.envelope(),
    total: stats.totalSeries(),
    routes: config.routes.map((route) => ({ id: route.id, series: series(route.id) })),
  }));

  app.get('/admin/api/upstreams', (): UpstreamsResponse => {
    const snapshots = breakers.snapshot();
    return {
      ...stats.envelope(),
      upstreams: config.upstreams.map((upstream) => {
        const upstreamSeries = stats.upstreamSeries(upstream.id);
        const snapshot = snapshots[upstream.id];
        if (upstreamSeries === undefined || snapshot === undefined) {
          throw new Error(`no stats or breaker for upstream ${upstream.id}`);
        }
        return {
          id: upstream.id,
          // Validated config: http(s), no credentials, query or fragment (ADR-0013, ADR-0019).
          baseUrl: upstream.baseUrl,
          breaker: {
            state: snapshot.state,
            consecutiveFailures: snapshot.consecutiveFailures,
            halfOpenInFlight: snapshot.halfOpenInFlight,
            settings: {
              failureThreshold: upstream.circuitBreaker.failureThreshold,
              openDurationMs: upstream.circuitBreaker.openDurationMs,
              halfOpenMaxRequests: upstream.circuitBreaker.halfOpenMaxRequests,
              halfOpenSuccessThreshold: upstream.circuitBreaker.halfOpenSuccessThreshold,
              failureStatuses: [...upstream.circuitBreaker.failureStatuses],
            },
          },
          series: upstreamSeries,
        };
      }),
    };
  });

  // Configuration only: no clients, keys or credentials (plan §5.1).
  app.get('/admin/api/routes', (): RoutesResponse => ({
    ...stats.envelope(),
    routes: config.routes.map((route) => ({
      id: route.id,
      pathPrefix: route.pathPrefix,
      methods: [...route.methods],
      upstreamId: route.upstreamId,
      stripPrefix: route.stripPrefix,
      authRequired: route.auth.required,
      rateLimit: {
        capacity: route.rateLimit.capacity,
        refillRatePerSecond: route.rateLimit.refillRatePerSecond,
      },
      timeoutMs: route.timeoutMs,
      attemptTimeoutMs: route.attemptTimeoutMs ?? null,
      retries: {
        maxAttempts: route.retries.maxAttempts,
        baseDelayMs: route.retries.baseDelayMs,
        maxDelayMs: route.retries.maxDelayMs,
        retryableStatuses: [...route.retries.retryableStatuses],
      },
      cache: route.cache.enabled
        ? {
            enabled: true,
            ttlSeconds: route.cache.ttlSeconds,
            scope: route.cache.scope,
            varyHeaders: [...route.cache.varyHeaders],
            maxResponseBytes: route.cache.maxResponseBytes,
          }
        : {
            enabled: false,
            ttlSeconds: null,
            scope: null,
            varyHeaders: [],
            maxResponseBytes: null,
          },
      forwarding: {
        authorization: route.forwarding.authorization,
        forwardedHost: route.forwarding.forwardedHost,
      },
    })),
  }));

  app.get('/admin/api/rate-limits', (): RateLimitsResponse => ({
    ...stats.envelope(),
    mode: config.rateLimit.mode,
    redisFailurePolicy:
      config.rateLimit.mode === 'redis' ? config.rateLimit.redisFailurePolicy : null,
    backend: deps.rateLimitBackend(),
    maxBuckets: config.rateLimit.maxBuckets,
    routes: config.routes.map((route) => ({
      id: route.id,
      policy: {
        capacity: route.rateLimit.capacity,
        refillRatePerSecond: route.rateLimit.refillRatePerSecond,
      },
      series: series(route.id),
    })),
  }));

  app.get('/admin/api/cache', (): CacheResponse => {
    const usage = deps.cacheStats();
    return {
      ...stats.envelope(),
      limits: {
        maxEntries: config.responseCache.maxEntries,
        maxBytes: config.responseCache.maxBytes,
      },
      usage: { entries: usage.entries, bytes: usage.bytes },
      evictions: {
        lifetime: { capacity: usage.evictedCapacity, expired: usage.evictedExpired },
      },
      routes: config.routes.flatMap((route) =>
        route.cache.enabled
          ? [
              {
                id: route.id,
                scope: route.cache.scope,
                ttlSeconds: route.cache.ttlSeconds,
                series: series(route.id),
              },
            ]
          : [],
      ),
    };
  });

  return { app, routes };
}

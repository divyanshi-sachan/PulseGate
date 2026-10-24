import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  assertClientsForAuth,
  ConfigError,
  type ClientsConfig,
  type GatewayConfig,
} from '@pulsegate/config';
import {
  LocalTokenBucketLimiter,
  RateLimiterUnavailableError,
  RedisTokenBucketLimiter,
  ResilientRateLimiter,
  type RateLimiter,
} from '@pulsegate/rate-limiter';
import { Redis } from 'ioredis';
import {
  cacheableHeaders,
  cacheKey,
  cachePartition,
  MemoryResponseCache,
  requestBypassReason,
  storability,
} from '@pulsegate/cache';
import { GatewayMetrics } from '@pulsegate/observability';
import { CircuitBreakerRegistry } from '@pulsegate/reliability';
import { GatewayError, isGatewayError } from '@pulsegate/shared';
import fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import {
  ApiKeyAuthenticator,
  AuthenticationError,
  type ClientIdentity,
} from './auth/authenticator.ts';
import { resolveClientAddress, TrustedProxies } from './proxy/client-address.ts';
import {
  CircuitOpenError,
  ClientAbortedError,
  ProxyService,
  type BodyCapture,
} from './proxy/proxy-service.ts';
import { UpstreamRegistry } from './proxy/upstream-registry.ts';
import { parseRedisUrl } from './redis/redis-url.ts';
import { singleFlight } from './redis/single-flight.ts';
import { parseRequestTarget } from './routing/request-target.ts';
import { MethodNotAllowedError, RouteRegistry } from './routing/route-registry.ts';

export interface GatewayOptions {
  /** Fastify logger setting; defaults to pino at LOG_LEVEL (or "info"). */
  logger?: FastifyServerOptions['logger'];
  /** Validated clients file; required when any route has auth.required (ADR-0031). */
  clients?: ClientsConfig;
  /** Rate limiter override, e.g. a limiter with a fake clock in tests (default: local, ADR-0032). */
  limiter?: RateLimiter;
  /** Local-limiter sweep interval (default 60 s); shorter in tests. */
  sweepIntervalMs?: number;
  /** Backoff jitter source (default Math.random); deterministic in tests (ADR-0033). */
  random?: () => number;
  /** Clock for circuit breakers (default performance.now); fake in tests. */
  breakerClock?: () => number;
  /** Redis connection URL, from the REDIS_URL env var; required when rateLimit.mode is "redis" (ADR-0034). */
  redisUrl?: string;
  /** Wall clock for cache TTLs (default Date.now); fake in tests (ADR-0036). */
  cacheClock?: () => number;
  /** Include Node process metrics in /metrics (default true). */
  processMetrics?: boolean;
}

export interface Gateway {
  /** Public data-plane listener: proxied traffic only (ADR-0022). */
  readonly public: FastifyInstance;
  /** Operations listener: /health and /ready (ADR-0022). */
  readonly operations: FastifyInstance;
  /** Prometheus metrics served on the operations listener's /metrics (ADR-0036). */
  readonly metrics: GatewayMetrics;
  /** Listens on the configured hosts and ports. */
  start(): Promise<void>;
  /**
   * Graceful shutdown (ADR-0030): /ready turns 503, the public listener stops accepting, in-flight
   * requests drain for up to `server.shutdownTimeoutMs`, then remaining connections and upstream calls
   * are force-closed. Idempotent: repeated calls return the same promise.
   */
  close(): Promise<ShutdownResult>;
}

export interface ShutdownResult {
  /** True when the drain deadline expired and connections were force-closed. */
  forced: boolean;
}

/** Gateway request IDs are always generated, never taken from the client (ADR-0027). */
export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

/** Outgoing headers as the cache rules expect them (numbers as strings). */
function normalizeHeaders(
  headers: Record<string, string | string[] | number | undefined>,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = typeof value === 'number' ? String(value) : value;
  }
  return out;
}

interface RequestOutcome {
  routeId?: string;
  clientId?: string;
  authFailure?: string;
  errorCode?: string;
  /** Upstream attempts made, including retries (ADR-0033). */
  attempts?: number;
  /** "degraded" when a fail-open local fallback decided (ADR-0034). */
  rateLimitMode?: string;
  /** hit | miss | bypass on cache-enabled routes (ADR-0036). */
  cacheStatus?: 'hit' | 'miss' | 'bypass';
  /** What happened to a miss's response: stored | not_storable | too_large. */
  cacheStore?: 'stored' | 'not_storable' | 'too_large';
  /** Request metrics are recorded exactly once (completion or abort). */
  metricsRecorded?: boolean;
}

/** How often full buckets are swept from the local limiter (ADR-0032). */
const SWEEP_INTERVAL_MS = 60_000;

function sendError(reply: FastifyReply, error: GatewayError, requestId: string): FastifyReply {
  if (error instanceof MethodNotAllowedError) void reply.header('allow', error.allow);
  if (error instanceof CircuitOpenError) {
    void reply.header('retry-after', String(error.retryAfterSeconds));
  }
  return reply
    .code(error.status)
    .header('content-type', 'application/json; charset=utf-8')
    .header('x-request-id', requestId)
    .send(error.toBody(requestId));
}

/** Writes a normalized 400 straight to a socket Node will not hand to Fastify (ADR-0023). */
function rejectSocket(
  socket: Duplex,
  message: string,
  log: FastifyBaseLogger,
  metrics: GatewayMetrics,
): void {
  // The peer may already be gone (e.g. a reset during parsing).
  if (!socket.writable) return;
  metrics.requestCompleted({
    routeId: undefined,
    statusCode: 400,
    code: 'BAD_REQUEST',
    durationSeconds: 0,
  });
  const requestId = newRequestId();
  const body = JSON.stringify(
    new GatewayError('BAD_REQUEST', { publicMessage: message }).toBody(requestId),
  );
  socket.on('error', () => undefined);
  socket.end(
    [
      'HTTP/1.1 400 Bad Request',
      'Content-Type: application/json; charset=utf-8',
      `Content-Length: ${String(Buffer.byteLength(body))}`,
      `X-Request-ID: ${requestId}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n'),
  );
  log.info(
    { requestId, statusCode: 400, errorCode: 'BAD_REQUEST', reason: message },
    'request rejected',
  );
}

function baseOptions(options: GatewayOptions): FastifyServerOptions {
  return {
    logger: options.logger ?? { level: process.env['LOG_LEVEL'] ?? 'info' },
    // The onResponse hook writes one redacted line per request instead of Fastify's default logs.
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    requestIdHeader: false,
    genReqId: newRequestId,
    trustProxy: false,
    return503OnClosing: true,
  };
}

function buildPublicServer(
  config: GatewayConfig,
  options: GatewayOptions,
  upstreams: UpstreamRegistry,
  limiter: RateLimiter,
  breakers: CircuitBreakerRegistry,
  cache: MemoryResponseCache,
  cacheNow: () => number,
  metrics: GatewayMetrics,
) {
  const limiterMode = config.rateLimit.mode;
  const authenticator =
    options.clients === undefined ? undefined : new ApiKeyAuthenticator(options.clients);
  const routes = new RouteRegistry(config.routes);
  const trusted = new TrustedProxies(config.server.trustedProxies);
  const proxy = new ProxyService({
    limits: config.server.limits,
    breakers,
    ...(options.random === undefined ? {} : { random: options.random }),
    onAttemptSettled: (upstreamId, attemptOutcome, seconds) => {
      metrics.upstreamAttempt(upstreamId, attemptOutcome, seconds);
    },
  });
  const outcomes = new WeakMap<FastifyRequest, RequestOutcome>();

  const app = fastify({
    ...baseOptions(options),
    // Malformed HTTP that Node's parser rejects never reaches a route; answer in the normalized shape
    // (ADR-0011) instead of Fastify's default body.
    clientErrorHandler: (error, socket) => {
      rejectSocket(socket, 'Malformed HTTP request', app.log, metrics);
      app.log.debug({ err: error }, 'HTTP parser rejected request');
    },
    frameworkErrors: (error, request, reply) => {
      outcomes.set(request, { errorCode: 'BAD_REQUEST' });
      request.log.debug({ err: error }, 'framework rejected request');
      void sendError(reply, new GatewayError('BAD_REQUEST'), request.id);
    },
  });

  // Bodies are streamed to the upstream untouched, never parsed by the gateway.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, _payload, done) => {
    done(null);
  });

  app.server.on('upgrade', (_request, socket: Duplex) => {
    rejectSocket(socket, 'Protocol upgrade not supported', app.log, metrics);
  });
  app.server.on('connect', (_request, socket: Duplex) => {
    rejectSocket(socket, 'CONNECT not supported', app.log, metrics);
  });

  const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const outcome: RequestOutcome = {};
    outcomes.set(request, outcome);
    const response: ServerResponse = reply.raw;
    const client = new AbortController();
    response.once('close', () => {
      if (!response.writableFinished) client.abort();
    });

    try {
      const target = parseRequestTarget(request.raw.url ?? '');
      const match = routes.match(request.raw.method ?? '', target.rawPath);
      outcome.routeId = match.route.id;

      let identity: ClientIdentity | undefined;
      if (match.route.auth.required) {
        // createGateway refuses to start without clients when a route needs auth.
        if (authenticator === undefined) throw new GatewayError('INTERNAL_ERROR');
        identity = authenticator.authenticate(request.headers['x-api-key']);
        outcome.clientId = identity.clientId;
      }

      const forwardedForHeader = request.headers['x-forwarded-for'];
      const address = resolveClientAddress(
        request.raw.socket.remoteAddress ?? '',
        Array.isArray(forwardedForHeader) ? forwardedForHeader.join(',') : forwardedForHeader,
        trusted,
      );

      // Per route and caller: client id when authenticated, otherwise the resolved client IP (ADR-0032).
      const subject =
        identity === undefined ? `ip:${address.clientIp}` : `client:${identity.clientId}`;
      let decision;
      try {
        decision = await limiter.consume(`${match.route.id}:${subject}`, match.route.rateLimit);
      } catch (error) {
        if (!(error instanceof RateLimiterUnavailableError)) throw error;
        // Fail-closed: the shared limiter can't decide (ADR-0034).
        metrics.rateLimiterUnavailable(match.route.id);
        void reply.header('retry-after', '1');
        throw new GatewayError('RATE_LIMITER_UNAVAILABLE', { cause: error });
      }
      const rateHeaders: Record<string, string> = {
        'x-ratelimit-limit': String(decision.limit),
        'x-ratelimit-remaining': String(decision.remaining),
        'x-ratelimit-reset': String(Math.ceil(decision.resetAfterMs / 1000)),
      };
      if (decision.degraded === true) {
        // Fail-open fallback: per-instance budget while Redis is unavailable (ADR-0034).
        rateHeaders['x-ratelimit-mode'] = 'degraded';
        outcome.rateLimitMode = 'degraded';
      }
      metrics.rateLimitDecision(
        match.route.id,
        decision.allowed,
        decision.degraded === true ? 'degraded' : limiterMode,
      );
      void reply.headers(rateHeaders);
      if (!decision.allowed) {
        void reply.header(
          'retry-after',
          String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))),
        );
        throw new GatewayError('RATE_LIMIT_EXCEEDED');
      }

      // Response cache, after auth and rate limiting, before the breaker (ADR-0010, ADR-0036).
      const routeCache = match.route.cache.enabled ? match.route.cache : undefined;
      let capture: BodyCapture | undefined;
      if (routeCache !== undefined) {
        const method = request.raw.method ?? 'GET';
        const bypass = requestBypassReason(
          method,
          request.headers,
          match.route.forwarding.authorization,
        );
        if (bypass === undefined) {
          const key = cacheKey({
            routeId: match.route.id,
            method,
            rawPath: target.rawPath,
            rawQuery: target.rawQuery,
            partition: cachePartition(routeCache, identity?.clientId),
            varyHeaders: routeCache.varyHeaders,
            requestHeaders: request.headers,
          });
          const hit = await cache.get(key);
          if (hit !== undefined) {
            outcome.cacheStatus = 'hit';
            metrics.cacheLookup(match.route.id, 'hit');
            return await reply
              .code(hit.statusCode)
              .headers(hit.headers)
              .headers(rateHeaders)
              .header('x-cache', 'HIT')
              .header('age', String(Math.max(0, Math.floor((cacheNow() - hit.storedAtMs) / 1000))))
              .header('x-request-id', request.id)
              .send(hit.body);
          }
          outcome.cacheStatus = 'miss';
          metrics.cacheLookup(match.route.id, 'miss');
          const routeId = match.route.id;
          capture = {
            begin: (statusCode, headers) => {
              const verdict = storability(statusCode, normalizeHeaders(headers), routeCache);
              if (!verdict.storable) {
                outcome.cacheStore = 'not_storable';
                metrics.cacheStore(routeId, 'not_storable');
                return undefined;
              }
              return {
                maxBytes: routeCache.maxResponseBytes,
                complete: (body) => {
                  const storedAtMs = cacheNow();
                  outcome.cacheStore = 'stored';
                  metrics.cacheStore(routeId, 'stored');
                  void cache.set(key, {
                    statusCode,
                    headers: cacheableHeaders(headers),
                    body,
                    storedAtMs,
                    expiresAtMs: storedAtMs + verdict.ttlMs,
                  });
                },
                tooLarge: () => {
                  outcome.cacheStore = 'too_large';
                  metrics.cacheStore(routeId, 'too_large');
                },
              };
            },
          };
        } else {
          outcome.cacheStatus = 'bypass';
          metrics.cacheLookup(match.route.id, 'bypass');
        }
        rateHeaders['x-cache'] = outcome.cacheStatus === 'miss' ? 'MISS' : 'BYPASS';
        void reply.header('x-cache', rateHeaders['x-cache']);
      }

      const result = await proxy.forward({
        request: request.raw,
        route: match.route,
        upstream: upstreams.getById(match.route.upstreamId),
        forwardedPath: match.forwardedPath,
        rawQuery: target.rawQuery,
        requestId: request.id,
        forwardedFor: address.forwardedFor,
        viaTrustedProxy: address.viaTrustedProxy,
        clientSignal: client.signal,
        onAttempt: () => {
          outcome.attempts = (outcome.attempts ?? 0) + 1;
        },
        ...(capture === undefined ? {} : { capture }),
        onBodyError: (error) => {
          const code = isGatewayError(error) ? error.code : 'UPSTREAM_UNAVAILABLE';
          outcome.errorCode = code;
          request.log.warn(
            { routeId: outcome.routeId, errorCode: code, err: error },
            'response aborted mid-stream',
          );
        },
      });

      return await reply
        .code(result.statusCode)
        .headers(result.headers)
        .headers(rateHeaders)
        .header('x-request-id', request.id)
        .send(result.body);
    } catch (error) {
      if (error instanceof ClientAbortedError) {
        outcome.errorCode = 'CLIENT_ABORTED';
        return reply;
      }
      const gatewayError = isGatewayError(error)
        ? error
        : new GatewayError('INTERNAL_ERROR', { cause: error });
      outcome.errorCode = gatewayError.code;
      if (gatewayError instanceof AuthenticationError) outcome.authFailure = gatewayError.reason;
      // CIRCUIT_OPEN is an expected rejection: no upstream was called (ADR-0033).
      // Gateway-side 503s are logged once per state change elsewhere, not per request.
      const upstreamFailed =
        gatewayError.status >= 502 &&
        gatewayError.code !== 'CIRCUIT_OPEN' &&
        gatewayError.code !== 'RATE_LIMITER_UNAVAILABLE';
      if (gatewayError.code === 'INTERNAL_ERROR' || upstreamFailed) {
        request.log.warn(
          {
            routeId: outcome.routeId,
            err: gatewayError.cause ?? gatewayError,
          },
          'upstream request failed',
        );
      }
      return sendError(reply, gatewayError, request.id);
    }
  };

  app.all('/', handle);
  app.all('/*', handle);
  app.setNotFoundHandler(handle);

  // In-flight gauge; 'close' fires even when the client aborts, unlike onResponse.
  app.addHook('onRequest', (request, reply, done) => {
    const end = metrics.requestStarted();
    reply.raw.once('close', () => {
      end();
      const outcome = outcomes.get(request);
      if (!reply.raw.writableFinished && outcome?.metricsRecorded !== true) {
        if (outcome !== undefined) outcome.metricsRecorded = true;
        metrics.requestCompleted({
          routeId: outcome?.routeId,
          statusCode: reply.statusCode,
          code: 'CLIENT_ABORTED',
          durationSeconds: reply.elapsedTime / 1000,
        });
      }
    });
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    const outcome = outcomes.get(request);
    if (outcome?.metricsRecorded !== true) {
      if (outcome !== undefined) outcome.metricsRecorded = true;
      metrics.requestCompleted({
        routeId: outcome?.routeId,
        statusCode: reply.statusCode,
        code: outcome?.errorCode,
        durationSeconds: reply.elapsedTime / 1000,
      });
      metrics.retries(outcome?.routeId, (outcome?.attempts ?? 1) - 1);
    }
    const queryStart = (request.raw.url ?? '').indexOf('?');
    request.log.info(
      {
        routeId: outcome?.routeId,
        clientId: outcome?.clientId,
        method: request.raw.method,
        path: queryStart === -1 ? request.raw.url : request.raw.url?.slice(0, queryStart),
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime * 100) / 100,
        errorCode: outcome?.errorCode,
        authFailure: outcome?.authFailure,
        attempts: outcome?.attempts,
        rateLimitMode: outcome?.rateLimitMode,
        cacheStatus: outcome?.cacheStatus,
        cacheStore: outcome?.cacheStore,
      },
      'request completed',
    );
    done();
  });

  return app;
}

interface Readiness {
  ready: boolean;
  body: Record<string, string>;
}

function buildOperationsServer(
  options: GatewayOptions,
  readiness: () => Promise<Readiness>,
  metrics: GatewayMetrics,
) {
  const app = fastify(baseOptions(options));
  // Liveness only: healthy whenever the process can answer, regardless of dependencies (ADR-0030).
  app.get('/health', () => ({ status: 'ok' }));
  // Prometheus scrape endpoint (ADR-0022, ADR-0036): bounded labels only.
  app.get('/metrics', async (_request, reply) =>
    reply.type(metrics.contentType).send(await metrics.text()),
  );
  app.get('/ready', async (_request, reply) => {
    const { ready, body } = await readiness();
    return reply.code(ready ? 200 : 503).send(body);
  });
  return app;
}

/** Startup could not complete; the process should exit non-zero (ADR-0034 review). */
export class GatewayStartupError extends Error {
  override readonly name = 'GatewayStartupError';
}

/**
 * Waits for the first Redis connection, bounded by connectTimeoutMs. If Redis isn't reachable in time,
 * startup **fails** in both policies instead of silently running on local limits (ADR-0034 review):
 * the orchestrator restarts the instance and readiness never reports a half-configured gateway.
 */
async function waitForRedis(parts: RedisLimiterParts, config: GatewayConfig): Promise<void> {
  const { redis } = parts;
  if (redis.status === 'ready') return;
  const timeoutMs = config.rateLimit.redis.connectTimeoutMs;
  const connected = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      redis.off('ready', onReady);
      resolve(false);
    }, timeoutMs);
    const onReady = () => {
      clearTimeout(timer);
      resolve(true);
    };
    redis.once('ready', onReady);
  });
  if (!connected) {
    redis.disconnect();
    throw new GatewayStartupError(
      `Redis at ${parts.target} was not reachable within ${String(timeoutMs)} ms (rateLimit.redis.connectTimeoutMs); refusing to start`,
    );
  }
}

interface RedisLimiterParts {
  redis: Redis;
  limiter: ResilientRateLimiter;
  /** host:port only (ADR-0034). */
  target: string;
}

/** Builds the Redis client and the failure-policy wrapper (ADR-0034). */
function buildRedisLimiter(
  config: GatewayConfig,
  redisUrl: string | undefined,
  logRef: { current?: FastifyBaseLogger },
): RedisLimiterParts | undefined {
  const rateLimit = config.rateLimit;
  if (rateLimit.mode !== 'redis') return undefined;
  if (redisUrl === undefined || redisUrl === '') {
    throw new ConfigError([
      {
        path: 'rateLimit.mode',
        message: 'is "redis", so the REDIS_URL environment variable must be set (ADR-0034)',
      },
    ]);
  }
  // Only host:port is ever logged; error text is scrubbed of the URL and credentials.
  const { target, redact } = parseRedisUrl(redisUrl);
  const redis = new Redis(redisUrl, {
    commandTimeout: rateLimit.redis.commandTimeoutMs,
    connectTimeout: rateLimit.redis.connectTimeoutMs,
    // Fail fast while disconnected instead of queueing commands behind a dead connection.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 100, 2000),
  });
  // Connection errors surface through health changes below; an unhandled 'error' event would crash.
  redis.on('error', (error: Error) => {
    logRef.current?.debug({ redis: target, err: redact(error.message) }, 'redis connection error');
  });
  const limiter = new ResilientRateLimiter({
    primary: new RedisTokenBucketLimiter(redis),
    policy: rateLimit.redisFailurePolicy,
    fallback: new LocalTokenBucketLimiter({ maxBuckets: rateLimit.maxBuckets }),
    onHealthChange: (healthy, error) => {
      if (healthy) logRef.current?.info({ redis: target }, 'redis rate limiter recovered');
      else {
        logRef.current?.warn(
          {
            redis: target,
            policy: rateLimit.redisFailurePolicy,
            err: redact(error instanceof Error ? error.message : String(error)),
          },
          'redis rate limiter unavailable',
        );
      }
    },
  });
  return { redis, limiter, target };
}

export function createGateway(config: GatewayConfig, options: GatewayOptions = {}): Gateway {
  assertClientsForAuth(config, options.clients, 'clients file');
  // Loggers exist only once the public server is built; these callbacks run later.
  const logRef: { current?: FastifyBaseLogger } = {};
  const redisParts =
    options.limiter === undefined ? buildRedisLimiter(config, options.redisUrl, logRef) : undefined;
  const limiter =
    options.limiter ??
    redisParts?.limiter ??
    new LocalTokenBucketLimiter({ maxBuckets: config.rateLimit.maxBuckets });
  const upstreams = new UpstreamRegistry(config.upstreams);
  let ready = false;
  const cacheRef: { current?: MemoryResponseCache } = {};
  const metrics = new GatewayMetrics({
    routes: config.routes.map((route) => route.id),
    upstreams: config.upstreams.map((upstream) => upstream.id),
    cacheStats: () => cacheRef.current?.stats() ?? { entries: 0, bytes: 0 },
    defaultMetrics: options.processMetrics ?? true,
  });
  const breakers = new CircuitBreakerRegistry(config.upstreams, {
    ...(options.breakerClock === undefined ? {} : { now: options.breakerClock }),
    onTransition: (upstreamId, transition) => {
      metrics.breakerTransition(upstreamId, transition.from, transition.to);
      logRef.current?.warn({ upstreamId, ...transition }, 'circuit breaker state changed');
    },
  });
  const cacheNow = options.cacheClock ?? Date.now;
  const cache = new MemoryResponseCache({
    ...config.responseCache,
    now: cacheNow,
    onEvict: (reason) => {
      metrics.cacheEviction(reason);
    },
  });
  cacheRef.current = cache;
  const publicServer = buildPublicServer(
    config,
    options,
    upstreams,
    limiter,
    breakers,
    cache,
    cacheNow,
    metrics,
  );
  logRef.current = publicServer.log;

  let lastLruEvictions = 0;
  // Local buckets: the limiter itself, or the fail-open fallback behind Redis (ADR-0032, ADR-0034).
  const localBuckets =
    limiter instanceof LocalTokenBucketLimiter
      ? limiter
      : limiter instanceof ResilientRateLimiter
        ? limiter.fallback
        : undefined;
  // Periodic maintenance: expired cache entries, full local buckets (ADR-0032, ADR-0036).
  const sweeper = setInterval(() => {
    cache.sweep();
    if (localBuckets === undefined) return;
    localBuckets.sweep();
    const { evictedLru, buckets, maxBuckets } = localBuckets.stats();
    if (evictedLru > lastLruEvictions) {
      publicServer.log.warn(
        { evicted: evictedLru - lastLruEvictions, buckets, maxBuckets },
        'rate-limit bucket cap reached; least-recently-used buckets were evicted',
      );
      lastLruEvictions = evictedLru;
    }
  }, options.sweepIntervalMs ?? SWEEP_INTERVAL_MS).unref();
  // Readiness (ADR-0030, ADR-0034 review): actively ping Redis on each probe (bounded by commandTimeoutMs,
  // one ping in flight at a time), so a drained instance notices recovery without traffic.
  const pingRedis = singleFlight(async () => {
    if (redisParts === undefined) return true;
    try {
      await redisParts.redis.ping();
      return true;
    } catch {
      return false;
    }
  });
  const readiness = async (): Promise<Readiness> => {
    if (!ready) return { ready: false, body: { status: 'not_ready' } };
    if (redisParts === undefined || config.rateLimit.mode !== 'redis') {
      return { ready: true, body: { status: 'ready' } };
    }
    if (await pingRedis()) return { ready: true, body: { status: 'ready', redis: 'up' } };
    // Fail-closed can't serve without Redis; fail-open keeps serving with degraded local limits.
    return config.rateLimit.redisFailurePolicy === 'closed'
      ? { ready: false, body: { status: 'not_ready', redis: 'unavailable' } }
      : { ready: true, body: { status: 'ready', redis: 'unavailable', rateLimit: 'degraded' } };
  };
  const operations = buildOperationsServer(options, readiness, metrics);
  let closing: Promise<ShutdownResult> | undefined;

  async function shutdown(): Promise<ShutdownResult> {
    ready = false;
    clearInterval(sweeper);
    // An object, not a let: the flag is set inside the timer callback.
    const state = { forced: false };
    const deadline = setTimeout(() => {
      state.forced = true;
      publicServer.log.warn(
        { shutdownTimeoutMs: config.server.shutdownTimeoutMs },
        'drain deadline reached; closing remaining connections',
      );
      // Closing client sockets aborts their upstream calls through the client signal.
      publicServer.server.closeAllConnections();
    }, config.server.shutdownTimeoutMs);
    try {
      await publicServer.close();
    } finally {
      clearTimeout(deadline);
    }
    await (state.forced ? upstreams.destroy() : upstreams.close());
    await operations.close();
    if (redisParts !== undefined) {
      await redisParts.redis.quit().catch(() => {
        redisParts.redis.disconnect();
      });
    }
    return { forced: state.forced };
  }

  return {
    public: publicServer,
    operations,
    metrics,
    async start() {
      if (redisParts !== undefined) await waitForRedis(redisParts, config);
      await operations.listen({ host: config.operations.host, port: config.operations.port });
      await publicServer.listen({ host: config.server.host, port: config.server.port });
      ready = true;
    },
    close() {
      closing ??= shutdown();
      return closing;
    },
  };
}

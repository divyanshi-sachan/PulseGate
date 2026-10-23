import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  assertClientsForAuth,
  ConfigError,
  type ClientsConfig,
  type GatewayConfig,
} from '@pulsegate/config';
import { LocalTokenBucketLimiter, type RateLimiter } from '@pulsegate/rate-limiter';
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
import { ClientAbortedError, ProxyService } from './proxy/proxy-service.ts';
import { UpstreamRegistry } from './proxy/upstream-registry.ts';
import { parseRequestTarget } from './routing/request-target.ts';
import { MethodNotAllowedError, RouteRegistry } from './routing/route-registry.ts';

export interface GatewayOptions {
  /** Fastify logger setting; defaults to pino at LOG_LEVEL (or "info"). */
  logger?: FastifyServerOptions['logger'];
  /** Validated clients file; required when any route has auth.required (ADR-0031). */
  clients?: ClientsConfig;
  /** Rate limiter override, e.g. a limiter with a fake clock in tests (default: local, ADR-0032). */
  limiter?: RateLimiter;
}

export interface Gateway {
  /** Public data-plane listener: proxied traffic only (ADR-0022). */
  readonly public: FastifyInstance;
  /** Operations listener: /health and /ready (ADR-0022). */
  readonly operations: FastifyInstance;
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

interface RequestOutcome {
  routeId?: string;
  clientId?: string;
  authFailure?: string;
  errorCode?: string;
}

/** How often full buckets are swept from the local limiter (ADR-0032). */
const SWEEP_INTERVAL_MS = 60_000;

function sendError(reply: FastifyReply, error: GatewayError, requestId: string): FastifyReply {
  if (error instanceof MethodNotAllowedError) void reply.header('allow', error.allow);
  return reply
    .code(error.status)
    .header('content-type', 'application/json; charset=utf-8')
    .header('x-request-id', requestId)
    .send(error.toBody(requestId));
}

/** Writes a normalized 400 straight to a socket Node will not hand to Fastify (ADR-0023). */
function rejectSocket(socket: Duplex, message: string, log: FastifyBaseLogger): void {
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
) {
  const authenticator =
    options.clients === undefined ? undefined : new ApiKeyAuthenticator(options.clients);
  const routes = new RouteRegistry(config.routes);
  const trusted = new TrustedProxies(config.server.trustedProxies);
  const proxy = new ProxyService(config.server.limits);
  const outcomes = new WeakMap<FastifyRequest, RequestOutcome>();

  const app = fastify({
    ...baseOptions(options),
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
    rejectSocket(socket, 'Protocol upgrade not supported', app.log);
  });
  app.server.on('connect', (_request, socket: Duplex) => {
    rejectSocket(socket, 'CONNECT not supported', app.log);
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
      const decision = await limiter.consume(`${match.route.id}:${subject}`, match.route.rateLimit);
      const rateHeaders = {
        'x-ratelimit-limit': String(decision.limit),
        'x-ratelimit-remaining': String(decision.remaining),
        'x-ratelimit-reset': String(Math.ceil(decision.resetAfterMs / 1000)),
      };
      void reply.headers(rateHeaders);
      if (!decision.allowed) {
        void reply.header(
          'retry-after',
          String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))),
        );
        throw new GatewayError('RATE_LIMIT_EXCEEDED');
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
      if (gatewayError.code === 'INTERNAL_ERROR' || gatewayError.status >= 502) {
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

  app.addHook('onResponse', (request, reply, done) => {
    const outcome = outcomes.get(request);
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
      },
      'request completed',
    );
    done();
  });

  return app;
}

function buildOperationsServer(options: GatewayOptions, isReady: () => boolean) {
  const app = fastify(baseOptions(options));
  app.get('/health', () => ({ status: 'ok' }));
  app.get('/ready', (_request, reply) =>
    isReady() ? { status: 'ready' } : reply.code(503).send({ status: 'not_ready' }),
  );
  return app;
}

export function createGateway(config: GatewayConfig, options: GatewayOptions = {}): Gateway {
  assertClientsForAuth(config, options.clients, 'clients file');
  if (config.rateLimit.mode === 'redis' && options.limiter === undefined) {
    throw new ConfigError([
      { path: 'rateLimit.mode', message: '"redis" is not implemented yet (Phase 4); use "local"' },
    ]);
  }
  const limiter =
    options.limiter ?? new LocalTokenBucketLimiter({ maxBuckets: config.rateLimit.maxBuckets });
  const upstreams = new UpstreamRegistry(config.upstreams);
  let ready = false;
  const publicServer = buildPublicServer(config, options, upstreams, limiter);

  let lastLruEvictions = 0;
  const sweeper =
    limiter instanceof LocalTokenBucketLimiter
      ? setInterval(() => {
          limiter.sweep();
          const { evictedLru, buckets } = limiter.stats();
          if (evictedLru > lastLruEvictions) {
            publicServer.log.warn(
              {
                evicted: evictedLru - lastLruEvictions,
                buckets,
                maxBuckets: config.rateLimit.maxBuckets,
              },
              'rate-limit bucket cap reached; least-recently-used buckets were evicted',
            );
            lastLruEvictions = evictedLru;
          }
        }, SWEEP_INTERVAL_MS).unref()
      : undefined;
  const operations = buildOperationsServer(options, () => ready);
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
    return { forced: state.forced };
  }

  return {
    public: publicServer,
    operations,
    async start() {
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

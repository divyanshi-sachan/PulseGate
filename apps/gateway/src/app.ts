import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { GatewayConfig } from '@pulsegate/config';
import { GatewayError, isGatewayError } from '@pulsegate/shared';
import fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { resolveClientAddress, TrustedProxies } from './proxy/client-address.ts';
import { ClientAbortedError, ProxyService } from './proxy/proxy-service.ts';
import { UpstreamRegistry } from './proxy/upstream-registry.ts';
import { parseRequestTarget } from './routing/request-target.ts';
import { MethodNotAllowedError, RouteRegistry } from './routing/route-registry.ts';

export interface GatewayOptions {
  /** Fastify logger setting; defaults to pino at LOG_LEVEL (or "info"). */
  logger?: FastifyServerOptions['logger'];
}

export interface Gateway {
  /** Public data-plane listener: proxied traffic only (ADR-0022). */
  readonly public: FastifyInstance;
  /** Operations listener: /health and /ready (ADR-0022). */
  readonly operations: FastifyInstance;
  /** Listens on the configured hosts and ports. */
  start(): Promise<void>;
  /** Stops accepting traffic, drains in-flight requests and closes upstream pools. */
  close(): Promise<void>;
}

/** Gateway request IDs are always generated, never taken from the client (ADR-0027). */
export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

interface RequestOutcome {
  routeId?: string;
  errorCode?: string;
}

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
) {
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

      const forwardedForHeader = request.headers['x-forwarded-for'];
      const address = resolveClientAddress(
        request.raw.socket.remoteAddress ?? '',
        Array.isArray(forwardedForHeader) ? forwardedForHeader.join(',') : forwardedForHeader,
        trusted,
      );

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
            { routeId: outcome.routeId, errorCode: code },
            'response aborted mid-stream',
          );
        },
      });

      return await reply
        .code(result.statusCode)
        .headers(result.headers)
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
        method: request.raw.method,
        path: queryStart === -1 ? request.raw.url : request.raw.url?.slice(0, queryStart),
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime * 100) / 100,
        errorCode: outcome?.errorCode,
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
  const upstreams = new UpstreamRegistry(config.upstreams);
  let ready = false;
  const publicServer = buildPublicServer(config, options, upstreams);
  const operations = buildOperationsServer(options, () => ready);

  return {
    public: publicServer,
    operations,
    async start() {
      await operations.listen({ host: config.operations.host, port: config.operations.port });
      await publicServer.listen({ host: config.server.host, port: config.server.port });
      ready = true;
    },
    async close() {
      ready = false;
      await publicServer.close();
      await upstreams.close();
      await operations.close();
    },
  };
}

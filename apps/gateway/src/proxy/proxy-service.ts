import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import { pipeline, Transform, type Readable } from 'node:stream';
import type { RouteConfig } from '@pulsegate/config';
import { GatewayError } from '@pulsegate/shared';
import type { Dispatcher } from 'undici';
import { buildUpstreamHeaders, filterResponseHeaders } from './headers.ts';
import type { RegisteredUpstream } from './upstream-registry.ts';

export interface ProxyLimits {
  maxRequestBodyBytes: number;
  maxResponseBodyBytes: number;
}

export interface ForwardRequest {
  request: IncomingMessage;
  route: RouteConfig;
  upstream: RegisteredUpstream;
  forwardedPath: string;
  rawQuery: string;
  requestId: string;
  forwardedFor: readonly string[];
  viaTrustedProxy: boolean;
  /** Aborted when the client goes away; cancels the upstream call. */
  clientSignal: AbortSignal;
  /** Called if the response body fails after headers were sent (the client connection is aborted). */
  onBodyError: (error: unknown) => void;
}

export interface ProxyResponse {
  statusCode: number;
  headers: OutgoingHttpHeaders;
  body: Readable;
}

/** Thrown when the client disconnected first; there is nobody left to answer (ADR-0024). */
export class ClientAbortedError extends Error {
  override readonly name = 'ClientAbortedError';
}

/** Fails the stream once more than `maxBytes` pass through, without buffering (ADR-0018). */
function byteLimit(maxBytes: number, makeError: () => Error): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) callback(makeError());
      else callback(null, chunk);
    },
  });
}

function declaredLength(value: string | string[] | undefined): number | undefined {
  if (value === undefined || Array.isArray(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

function hasBody(request: IncomingMessage): boolean {
  const length = declaredLength(request.headers['content-length']);
  return request.headers['transfer-encoding'] !== undefined || (length ?? 0) > 0;
}

/** Joins the upstream base path with the forwarded raw path and raw query (ADR-0019 step 6). */
export function upstreamTarget(basePath: string, forwardedPath: string, rawQuery: string): string {
  return `${basePath}${forwardedPath}${rawQuery === '' ? '' : `?${rawQuery}`}`;
}

/** Forwards one request to its upstream (single attempt; retries and breakers come in Phase 3). */
export class ProxyService {
  readonly #limits: ProxyLimits;

  constructor(limits: ProxyLimits) {
    this.#limits = limits;
  }

  async forward(input: ForwardRequest): Promise<ProxyResponse> {
    const { request, route, upstream } = input;
    const { maxRequestBodyBytes, maxResponseBodyBytes } = this.#limits;

    const requestLength = declaredLength(request.headers['content-length']);
    if (requestLength !== undefined && requestLength > maxRequestBodyBytes) {
      throw new GatewayError('PAYLOAD_TOO_LARGE');
    }

    let body: Readable | undefined;
    if (hasBody(request)) {
      const limiter = byteLimit(maxRequestBodyBytes, () => new GatewayError('PAYLOAD_TOO_LARGE'));
      body = pipeline(request, limiter, () => undefined);
    }

    const deadline = AbortSignal.timeout(route.timeoutMs);
    const signal = AbortSignal.any([deadline, input.clientSignal]);

    let response: Dispatcher.ResponseData;
    try {
      response = await upstream.dispatcher.request({
        path: upstreamTarget(upstream.config.basePath, input.forwardedPath, input.rawQuery),
        method: request.method as Dispatcher.HttpMethod,
        headers: buildUpstreamHeaders(request.headers, {
          route,
          requestId: input.requestId,
          forwardedFor: input.forwardedFor,
          viaTrustedProxy: input.viaTrustedProxy,
          connectionProto: 'http',
        }),
        body: body ?? null,
        signal,
      });
    } catch (error) {
      body?.destroy();
      if (body?.errored instanceof GatewayError) throw body.errored;
      if (error instanceof GatewayError) throw error;
      if (input.clientSignal.aborted) throw new ClientAbortedError('Client disconnected');
      if (deadline.aborted) throw new GatewayError('UPSTREAM_TIMEOUT', { cause: error });
      throw new GatewayError('UPSTREAM_UNAVAILABLE', { cause: error });
    }

    const responseLength = declaredLength(response.headers['content-length']);
    if (responseLength !== undefined && responseLength > maxResponseBodyBytes) {
      // destroy() emits an AbortError; without a listener it would crash the process.
      response.body.on('error', () => undefined);
      response.body.destroy();
      throw new GatewayError('UPSTREAM_RESPONSE_TOO_LARGE');
    }

    const limited = byteLimit(
      maxResponseBodyBytes,
      () => new GatewayError('UPSTREAM_RESPONSE_TOO_LARGE'),
    );
    const responseBody = pipeline(response.body, limited, (error) => {
      if (error !== null && !input.clientSignal.aborted) {
        input.onBodyError(deadline.aborted ? new GatewayError('UPSTREAM_TIMEOUT') : error);
      }
    });

    return {
      statusCode: response.statusCode,
      headers: filterResponseHeaders(response.headers),
      body: responseBody,
    };
  }
}

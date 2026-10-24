import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import { pipeline, Transform, type Readable } from 'node:stream';
import { setTimeout as sleepFor } from 'node:timers/promises';
import type { RouteConfig } from '@pulsegate/config';
import {
  backoffDelayMs,
  isRetryEligible,
  type BreakerPermit,
  type CircuitBreaker,
  type CircuitBreakerRegistry,
} from '@pulsegate/reliability';
import { GatewayError } from '@pulsegate/shared';
import type { Dispatcher } from 'undici';
import { buildUpstreamHeaders, filterResponseHeaders } from './headers.ts';
import type { RegisteredUpstream } from './upstream-registry.ts';

export interface ProxyLimits {
  maxRequestBodyBytes: number;
  maxResponseBodyBytes: number;
}

export interface ProxyServiceOptions {
  limits: ProxyLimits;
  breakers: CircuitBreakerRegistry;
  /** Jitter source for backoff; injectable for tests (default Math.random). */
  random?: () => number;
  /** Called once per upstream attempt when its breaker permit settles (ADR-0036 metrics). */
  onAttemptSettled?: (
    upstreamId: string,
    outcome: 'success' | 'failure' | 'aborted',
    seconds: number,
  ) => void;
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
  /** Called once per upstream attempt (for the request log's `attempts`). */
  onAttempt?: () => void;
  /** Optional tee of the final response body, e.g. for the response cache (ADR-0036). */
  capture?: BodyCapture;
}

/** Decides per final response whether to collect a copy of its body while it streams to the client. */
export interface BodyCapture {
  begin(statusCode: number, headers: OutgoingHttpHeaders): CaptureSink | undefined;
}

export interface CaptureSink {
  maxBytes: number;
  /** The full body arrived cleanly within maxBytes. */
  complete(body: Buffer): void;
  /** The body exceeded maxBytes; nothing is kept. */
  tooLarge(): void;
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

/** 503 CIRCUIT_OPEN carrying the Retry-After value (ADR-0033). */
export class CircuitOpenError extends GatewayError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterMs: number) {
    super('CIRCUIT_OPEN');
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  }
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

/** Discards an upstream body we won't forward; destroy() errors must not crash the process. */
function discard(response: Dispatcher.ResponseData): void {
  response.body.on('error', () => undefined);
  response.body.destroy();
}

/** Joins the upstream base path with the forwarded raw path and raw query (ADR-0019 step 6). */
export function upstreamTarget(basePath: string, forwardedPath: string, rawQuery: string): string {
  return `${basePath}${forwardedPath}${rawQuery === '' ? '' : `?${rawQuery}`}`;
}

type AttemptResult =
  | { kind: 'response'; response: Dispatcher.ResponseData }
  | { kind: 'error'; error: GatewayError; retryable: boolean };

/**
 * Upstream executor (ADR-0033): circuit-breaker permit per attempt, attempt and overall deadlines,
 * bounded retries with full-jitter backoff for eligible requests, and breaker outcomes settled per
 * ADR-0024 (a successful-status attempt settles when its body finishes).
 */
export class ProxyService {
  readonly #limits: ProxyLimits;
  readonly #breakers: CircuitBreakerRegistry;
  readonly #random: () => number;
  readonly #onAttemptSettled: ProxyServiceOptions['onAttemptSettled'];

  constructor(options: ProxyServiceOptions) {
    this.#limits = options.limits;
    this.#breakers = options.breakers;
    this.#random = options.random ?? Math.random;
    this.#onAttemptSettled = options.onAttemptSettled;
  }

  /** Reports the attempt's outcome and duration when its permit settles (exactly once). */
  #observed(permit: BreakerPermit, upstreamId: string): BreakerPermit {
    const report = this.#onAttemptSettled;
    if (report === undefined) return permit;
    const started = performance.now();
    let reported = false;
    const settle = (outcome: 'success' | 'failure' | 'aborted', apply: () => void) => {
      apply();
      if (reported) return;
      reported = true;
      report(upstreamId, outcome, (performance.now() - started) / 1000);
    };
    return {
      success: () => {
        settle('success', () => {
          permit.success();
        });
      },
      failure: () => {
        settle('failure', () => {
          permit.failure();
        });
      },
      release: () => {
        settle('aborted', () => {
          permit.release();
        });
      },
    };
  }

  async forward(input: ForwardRequest): Promise<ProxyResponse> {
    const { request, route, upstream } = input;
    const requestLength = declaredLength(request.headers['content-length']);
    if (requestLength !== undefined && requestLength > this.#limits.maxRequestBodyBytes) {
      throw new GatewayError('PAYLOAD_TOO_LARGE');
    }

    let body: Readable | undefined;
    if (hasBody(request)) {
      const limiter = byteLimit(
        this.#limits.maxRequestBodyBytes,
        () => new GatewayError('PAYLOAD_TOO_LARGE'),
      );
      body = pipeline(request, limiter, () => undefined);
    }

    const breaker = this.#breakers.get(upstream.config.id);
    const deadlineAt = performance.now() + route.timeoutMs;
    const deadline = AbortSignal.timeout(route.timeoutMs);
    const method = request.method ?? 'GET';
    const maxAttempts = isRetryEligible(method, body !== undefined, route.retries)
      ? route.retries.maxAttempts
      : 1;

    const first = breaker.tryAcquire();
    if (!first.allowed) {
      body?.destroy();
      throw new CircuitOpenError(first.retryAfterMs);
    }
    let permit: BreakerPermit = this.#observed(first.permit, upstream.config.id);

    for (let attempt = 1; ; attempt++) {
      input.onAttempt?.();
      const result = await this.#attempt(input, body, permit, deadline);
      const canRetry = attempt < maxAttempts;

      if (result.kind === 'error') {
        if (!result.retryable || !canRetry) throw result.error;
        const next = await this.#nextPermit(
          breaker,
          attempt,
          route,
          deadline,
          deadlineAt,
          input.clientSignal,
        );
        if (next === undefined) throw result.error;
        permit = this.#observed(next, upstream.config.id);
        continue;
      }

      const { response } = result;
      const failureStatus = upstream.config.circuitBreaker.failureStatuses.includes(
        response.statusCode,
      );
      const retryableStatus = route.retries.retryableStatuses.includes(response.statusCode);

      if (retryableStatus && canRetry) {
        // Hold the real response until the next attempt is actually allowed (ADR-0033).
        if (failureStatus) permit.failure();
        else permit.success();
        let next: BreakerPermit | undefined;
        try {
          next = await this.#nextPermit(
            breaker,
            attempt,
            route,
            deadline,
            deadlineAt,
            input.clientSignal,
          );
        } catch (error) {
          // The client left during backoff: release the held body and its socket now, instead of
          // leaving the connection busy until undici's body timeout.
          discard(response);
          throw error;
        }
        if (next === undefined) return this.#respond(response, undefined, deadline, input);
        // Destroyed rather than drained: a retryable error body may be large, and reading it only
        // to keep one connection alive isn't worth it. Undici opens a new connection as needed.
        discard(response);
        permit = this.#observed(next, upstream.config.id);
        continue;
      }

      if (failureStatus) {
        permit.failure();
        return this.#respond(response, undefined, deadline, input);
      }
      return this.#respond(response, permit, deadline, input);
    }
  }

  /** One upstream call. Settles `permit` itself for every failure it reports. */
  async #attempt(
    input: ForwardRequest,
    body: Readable | undefined,
    permit: BreakerPermit,
    deadline: AbortSignal,
  ): Promise<AttemptResult> {
    const { request, route, upstream } = input;
    const attemptTimeout =
      route.attemptTimeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(route.attemptTimeoutMs);
    const signal = AbortSignal.any(
      [deadline, input.clientSignal, attemptTimeout].filter((s) => s !== undefined),
    );

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
      // Client-side problems are not the upstream's fault: release, don't count (ADR-0024).
      if (body?.errored instanceof GatewayError) {
        permit.release();
        throw body.errored;
      }
      if (error instanceof GatewayError) {
        permit.release();
        throw error;
      }
      if (input.clientSignal.aborted) {
        permit.release();
        throw new ClientAbortedError('Client disconnected');
      }
      permit.failure();
      if (deadline.aborted) {
        return {
          kind: 'error',
          error: new GatewayError('UPSTREAM_TIMEOUT', { cause: error }),
          retryable: false,
        };
      }
      if (attemptTimeout?.aborted === true) {
        return {
          kind: 'error',
          error: new GatewayError('UPSTREAM_TIMEOUT', { cause: error }),
          retryable: true,
        };
      }
      return {
        kind: 'error',
        error: new GatewayError('UPSTREAM_UNAVAILABLE', { cause: error }),
        retryable: true,
      };
    }

    if (response.statusCode === 101) {
      // Upgrade was never requested (ADR-0023); treat as a protocol error.
      discard(response);
      permit.failure();
      return { kind: 'error', error: new GatewayError('UPSTREAM_UNAVAILABLE'), retryable: false };
    }
    return { kind: 'response', response };
  }

  /**
   * Waits the backoff and returns a permit for the next attempt, or undefined when retrying isn't
   * possible (deadline would pass, breaker refuses). Throws ClientAbortedError if the client leaves.
   */
  async #nextPermit(
    breaker: CircuitBreaker,
    attempt: number,
    route: RouteConfig,
    deadline: AbortSignal,
    deadlineAt: number,
    clientSignal: AbortSignal,
  ): Promise<BreakerPermit | undefined> {
    const delay = backoffDelayMs(attempt, route.retries, this.#random);
    if (performance.now() + delay >= deadlineAt) return undefined;
    try {
      await sleepFor(delay, undefined, { signal: AbortSignal.any([deadline, clientSignal]) });
    } catch {
      if (clientSignal.aborted) throw new ClientAbortedError('Client disconnected');
      return undefined;
    }
    const next = breaker.tryAcquire();
    return next.allowed ? next.permit : undefined;
  }

  /** Streams the chosen response to the client; settles `permit` (if any) when the body finishes. */
  #respond(
    response: Dispatcher.ResponseData,
    permit: BreakerPermit | undefined,
    deadline: AbortSignal,
    input: ForwardRequest,
  ): ProxyResponse {
    const { maxResponseBodyBytes } = this.#limits;
    const responseLength = declaredLength(response.headers['content-length']);
    if (responseLength !== undefined && responseLength > maxResponseBodyBytes) {
      discard(response);
      permit?.failure();
      throw new GatewayError('UPSTREAM_RESPONSE_TOO_LARGE');
    }

    const limited = byteLimit(
      maxResponseBodyBytes,
      () => new GatewayError('UPSTREAM_RESPONSE_TOO_LARGE'),
    );
    const headers = filterResponseHeaders(response.headers);
    const sink = input.capture?.begin(response.statusCode, headers);
    const collected: Buffer[] = [];
    let collectedBytes = 0;
    let overflow =
      sink !== undefined && responseLength !== undefined && responseLength > sink.maxBytes;
    // Reported as soon as it is known, so the request log line can include it.
    if (overflow) sink?.tooLarge();
    // Copies chunks up to the sink's limit while passing every chunk through unchanged.
    const tee = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (sink !== undefined && !overflow) {
          collectedBytes += chunk.length;
          if (collectedBytes > sink.maxBytes) {
            overflow = true;
            collected.length = 0;
            sink.tooLarge();
          } else collected.push(chunk);
        }
        callback(null, chunk);
      },
    });
    const body = pipeline(response.body, limited, tee, (error) => {
      // On success Node passes `undefined` here, although @types/node declares `Error | null`.
      if (input.clientSignal.aborted) {
        permit?.release();
        return;
      }
      if (error instanceof Error) {
        permit?.failure();
        input.onBodyError(deadline.aborted ? new GatewayError('UPSTREAM_TIMEOUT') : error);
        return;
      }
      permit?.success();
      if (sink !== undefined && !overflow) sink.complete(Buffer.concat(collected));
    });

    return { statusCode: response.statusCode, headers, body };
  }
}

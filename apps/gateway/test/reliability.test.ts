import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayOptions } from '../src/index.ts';
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
 * Fault-injection tests for retries and circuit breakers (ADR-0007, 0016, 0024, 0033) against real
 * upstream sockets. Backoff jitter is 0 and the breaker clock is fake, so nothing waits on real timers
 * except the timeout tests.
 */

type Step = (req: IncomingMessage, res: ServerResponse) => void;
const ok: Step = (_req, res) => res.end('ok');
const busy: Step = (_req, res) => {
  res.statusCode = 503;
  res.end('busy');
};
const reset: Step = (req) => req.socket.destroy();
const status =
  (code: number): Step =>
  (_req, res) => {
    res.statusCode = code;
    res.end(String(code));
  };
const slow =
  (ms: number): Step =>
  (_req, res) =>
    setTimeout(() => res.end('slow'), ms);

/** Runs steps[i] for the i-th request, repeating the last step afterwards. */
function scripted(...steps: Step[]): Parameters<typeof startUpstream>[0] {
  let calls = 0;
  return (req, res) => {
    const step = steps[Math.min(calls, steps.length - 1)] ?? ok;
    calls++;
    step(req, res);
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface Setup {
  gw: RunningGateway;
  upstream: MockUpstream;
  logs: ReturnType<typeof captureLogs>;
  advanceBreakerClock: (ms: number) => void;
}

async function setup(
  handler: Parameters<typeof startUpstream>[0],
  routes: RouteDef[],
  extra: Record<string, unknown> = {},
  options: GatewayOptions = {},
): Promise<Setup> {
  const upstream = await startUpstream(handler);
  cleanups.push(() => upstream.close());
  const logs = captureLogs();
  let clock = 0;
  const gw = await startGateway(configFor(upstream.url, routes, extra), {
    ...logs.options,
    random: () => 0,
    breakerClock: () => clock,
    ...options,
  });
  cleanups.push(() => gw.close());
  return {
    gw,
    upstream,
    logs,
    advanceBreakerClock: (ms) => {
      clock += ms;
    },
  };
}

const retrying = (maxAttempts: number, extra: RouteDef = {}): RouteDef => ({
  retries: { maxAttempts },
  ...extra,
});
const breaker = (failureThreshold: number) => ({
  circuitBreaker: { failureThreshold, openDurationMs: 10_000 },
});
const errorCode = (response: RawResponse) =>
  (jsonBody(response) as { error: { code: string } }).error.code;

async function completedLines(logs: Setup['logs']) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return logs.lines().filter((line) => line['msg'] === 'request completed');
}

describe('retries (ADR-0016, ADR-0033)', () => {
  it('retries retryable statuses and returns the eventual success', async () => {
    const { gw, upstream, logs } = await setup(scripted(busy, busy, ok), [retrying(3)]);
    const response = await send(gw.port, { path: '/api/orders' });
    expect(response.status).toBe(200);
    expect(response.body).toBe('ok');
    expect(upstream.requests).toHaveLength(3);
    expect((await completedLines(logs))[0]).toMatchObject({ statusCode: 200, attempts: 3 });
  });

  it('retries connection resets', async () => {
    const { gw, upstream } = await setup(scripted(reset, ok), [retrying(2)]);
    expect((await send(gw.port, { path: '/api/orders' })).status).toBe(200);
    expect(upstream.requests).toHaveLength(2);
  });

  it('returns the last real upstream response when attempts run out', async () => {
    const { gw, upstream } = await setup(scripted(busy), [retrying(3)]);
    const response = await send(gw.port, { path: '/api/orders' });
    expect(response.status).toBe(503);
    expect(response.body).toBe('busy');
    expect(upstream.requests).toHaveLength(3);
  });

  it('does not retry statuses outside retryableStatuses', async () => {
    const { gw, upstream } = await setup(scripted(status(500)), [retrying(3)]);
    expect((await send(gw.port, { path: '/api/orders' })).status).toBe(500);
    expect(upstream.requests).toHaveLength(1);
  });

  it('never retries POST, or GET with a body', async () => {
    const { gw, upstream } = await setup(scripted(busy), [
      retrying(3, { methods: ['GET', 'POST'] }),
    ]);
    expect((await send(gw.port, { method: 'POST', path: '/api/orders', body: '{}' })).status).toBe(
      503,
    );
    expect(upstream.requests).toHaveLength(1);
    // Node's client sends a GET body without framing unless Content-Length is set explicitly.
    const getWithBody = await send(gw.port, {
      method: 'GET',
      path: '/api/orders',
      headers: { 'content-length': '1' },
      body: 'x',
    });
    expect(getWithBody.status).toBe(503);
    expect(upstream.requests).toHaveLength(2);
  });

  it('cuts a hung attempt at attemptTimeoutMs and retries within the deadline', async () => {
    const { gw, upstream } = await setup(scripted(slow(2000), ok), [
      retrying(2, { attemptTimeoutMs: 100, timeoutMs: 3000 }),
    ]);
    const started = performance.now();
    const response = await send(gw.port, { path: '/api/orders' });
    expect(response.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(upstream.requests).toHaveLength(2);
  });

  it('fails fast instead of sleeping when the next backoff would overrun the deadline', async () => {
    // Jitter near 1 makes the first backoff ~999 ms, far beyond the 400 ms deadline.
    const { gw, upstream } = await setup(
      scripted(reset),
      [
        retrying(3, {
          timeoutMs: 400,
          retries: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 1000 },
        }),
      ],
      {},
      { random: () => 0.999 },
    );
    const started = performance.now();
    const response = await send(gw.port, { path: '/api/orders' });
    expect(response.status).toBe(502);
    expect(performance.now() - started).toBeLessThan(150);
    expect(upstream.requests).toHaveLength(1);
  });

  it('stops retrying when the overall deadline passes', async () => {
    const { gw, upstream } = await setup(scripted(slow(1000)), [
      retrying(10, { attemptTimeoutMs: 150, timeoutMs: 400 }),
    ]);
    const started = performance.now();
    const response = await send(gw.port, { path: '/api/orders' });
    const elapsed = performance.now() - started;
    expect(response.status).toBe(504);
    expect(errorCode(response)).toBe('UPSTREAM_TIMEOUT');
    expect(elapsed).toBeLessThan(900);
    expect(upstream.requests.length).toBeLessThanOrEqual(3);
  });
});

describe('circuit breaker (ADR-0024, ADR-0033)', () => {
  it('opens after consecutive failures and then rejects without calling the upstream', async () => {
    const { gw, upstream, logs } = await setup(scripted(reset), [{}], breaker(3));
    for (let i = 0; i < 3; i++)
      expect((await send(gw.port, { path: '/api/orders' })).status).toBe(502);

    const rejected = await send(gw.port, { path: '/api/orders' });
    expect(rejected.status).toBe(503);
    expect(errorCode(rejected)).toBe('CIRCUIT_OPEN');
    expect(rejected.headers['retry-after']).toBe('10');
    expect(rejected.headers['x-ratelimit-limit']).toBeDefined();
    expect(upstream.requests).toHaveLength(3);

    expect(logs.lines()).toContainEqual(
      expect.objectContaining({
        msg: 'circuit breaker state changed',
        upstreamId: 'orders-service',
        from: 'closed',
        to: 'open',
        reason: 'failure-threshold',
      }),
    );
    // No upstream was called, so the line has no attempts field.
    const last = (await completedLines(logs)).at(-1);
    expect(last).toMatchObject({ errorCode: 'CIRCUIT_OPEN', statusCode: 503 });
    expect(last?.['attempts']).toBeUndefined();
    expect(logs.lines().filter((line) => line['msg'] === 'upstream request failed')).toHaveLength(
      3,
    );
  });

  it('isolates a failing upstream from healthy ones', async () => {
    const failing = await startUpstream(scripted(reset));
    const healthy = await startUpstream(scripted(ok));
    cleanups.push(
      () => failing.close(),
      () => healthy.close(),
    );
    const config = configFor(
      failing.url,
      [{}, { id: 'pay', pathPrefix: '/api/payments', upstreamId: 'payments' }],
      {
        upstreams: [
          { id: 'orders-service', baseUrl: failing.url, circuitBreaker: { failureThreshold: 1 } },
          { id: 'payments', baseUrl: healthy.url },
        ],
      },
    );
    const gw = await startGateway(config, { logger: false, random: () => 0 });
    cleanups.push(() => gw.close());

    expect((await send(gw.port, { path: '/api/orders' })).status).toBe(502);
    expect((await send(gw.port, { path: '/api/orders' })).status).toBe(503);
    expect((await send(gw.port, { path: '/api/payments' })).status).toBe(200);
  });

  it('recovers through half-open once the upstream is healthy again', async () => {
    const { gw, logs, advanceBreakerClock } = await setup(
      scripted(reset, reset, ok),
      [{}],
      breaker(2),
    );
    await send(gw.port, { path: '/api/orders' });
    await send(gw.port, { path: '/api/orders' });
    expect((await send(gw.port, { path: '/api/orders' })).status).toBe(503);

    advanceBreakerClock(10_000);
    expect((await send(gw.port, { path: '/api/orders' })).status).toBe(200);
    expect((await send(gw.port, { path: '/api/orders' })).status).toBe(200);

    const transitions = logs
      .lines()
      .filter((line) => line['msg'] === 'circuit breaker state changed')
      .map((line) => `${String(line['from'])}->${String(line['to'])}`);
    expect(transitions).toEqual(['closed->open', 'open->half-open', 'half-open->closed']);
  });

  it('re-opens when the half-open probe fails', async () => {
    const { gw, upstream, advanceBreakerClock } = await setup(scripted(reset), [{}], breaker(1));
    await send(gw.port, { path: '/api/orders' });
    advanceBreakerClock(10_000);
    expect((await send(gw.port, { path: '/api/orders' })).status).toBe(502);
    expect((await send(gw.port, { path: '/api/orders' })).status).toBe(503);
    expect(upstream.requests).toHaveLength(2);
  });

  it('does not count upstream 4xx as failures', async () => {
    const { gw } = await setup(scripted(status(404)), [{}], breaker(2));
    for (let i = 0; i < 5; i++)
      expect((await send(gw.port, { path: '/api/orders' })).status).toBe(404);
  });

  it('stops retrying when the breaker opens mid-sequence and returns the last real response', async () => {
    const { gw, upstream, logs } = await setup(scripted(busy), [retrying(5)], breaker(2));
    const response = await send(gw.port, { path: '/api/orders' });
    expect(response.status).toBe(503);
    expect(response.body).toBe('busy');
    expect(upstream.requests).toHaveLength(2);
    expect((await completedLines(logs))[0]).toMatchObject({ attempts: 2 });
  });

  it('counts an oversized response exactly once and never retries it', async () => {
    const { gw, upstream } = await setup(
      scripted((_req, res) => res.end('x'.repeat(64))),
      [retrying(3)],
      { ...breaker(2), server: { limits: { maxResponseBodyBytes: 16 } } },
    );
    expect(errorCode(await send(gw.port, { path: '/api/orders' }))).toBe(
      'UPSTREAM_RESPONSE_TOO_LARGE',
    );
    expect(upstream.requests).toHaveLength(1);
    expect(errorCode(await send(gw.port, { path: '/api/orders' }))).toBe(
      'UPSTREAM_RESPONSE_TOO_LARGE',
    );
    expect(errorCode(await send(gw.port, { path: '/api/orders' }))).toBe('CIRCUIT_OPEN');
  });

  it('does not count a client disconnect against the upstream', async () => {
    const { gw } = await setup(scripted(slow(300), ok), [{}], breaker(1));
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
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await send(gw.port, { path: '/api/orders' })).status).toBe(200);
  });
});

import { connect } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createGateway, type Gateway } from '../src/index.ts';
import { configFor, freePort, send, startUpstream, type MockUpstream } from './harness.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Starts the real public + operations listeners via gateway.start() on free ports. */
async function startFull(upstream: MockUpstream, shutdownTimeoutMs: number) {
  const [publicPort, opsPort] = [await freePort(), await freePort()];
  const config = configFor(upstream.url, [{ timeoutMs: 30_000 }], {
    server: { host: '127.0.0.1', port: publicPort, shutdownTimeoutMs },
    operations: { port: opsPort },
  });
  const gateway = createGateway(config, { logger: false });
  cleanups.push(() => gateway.close());
  await gateway.start();
  return { gateway, publicPort, opsPort };
}

async function readyStatus(opsPort: number): Promise<number> {
  return (await send(opsPort, { path: '/ready' })).status;
}

function slowUpstream(delayMs: number): Promise<MockUpstream> {
  return startUpstream((_req, res) => setTimeout(() => res.end('done'), delayMs));
}

function track(upstream: MockUpstream): MockUpstream {
  cleanups.push(() => upstream.close());
  return upstream;
}

/** Resolves once the upstream has received `count` requests. */
async function untilReceived(upstreamRequests: unknown[], count: number): Promise<void> {
  for (let i = 0; i < 200 && upstreamRequests.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('readiness (ADR-0022, ADR-0030)', () => {
  it('is 503 before start, 200 once both listeners are up', async () => {
    const upstream = track(await startUpstream());
    const config = configFor(upstream.url);
    const gateway: Gateway = createGateway(config, { logger: false });
    cleanups.push(() => gateway.close());
    expect((await gateway.operations.inject({ url: '/ready' })).statusCode).toBe(503);

    const { opsPort } = await startFull(upstream, 1000);
    expect(await readyStatus(opsPort)).toBe(200);
  });

  it('does not depend on upstream health: an unreachable upstream is a request error, not unreadiness', async () => {
    const upstream = await startUpstream();
    const { opsPort, publicPort } = await startFull(upstream, 1000);
    await upstream.close();
    expect((await send(publicPort, { path: '/api/orders' })).status).toBe(502);
    expect(await readyStatus(opsPort)).toBe(200);
  });
});

describe('graceful shutdown (ADR-0030)', () => {
  it('drains an in-flight request, reports not ready, and refuses new connections', async () => {
    const upstream = track(await slowUpstream(300));
    const { gateway, publicPort, opsPort } = await startFull(upstream, 5000);

    const inFlight = send(publicPort, { path: '/api/orders/1' });
    await untilReceived(upstream.requests, 1);

    const closing = gateway.close();
    // Readiness flips immediately so load balancers stop routing here.
    expect(await readyStatus(opsPort).catch(() => 'closed')).toSatisfy(
      (status) => status === 503 || status === 'closed',
    );
    // The listener no longer accepts new connections.
    const socket = connect(publicPort, '127.0.0.1');
    const [event] = await Promise.race([
      once(socket, 'error').then(() => ['error'] as const),
      once(socket, 'connect').then(() => ['connect'] as const),
    ]);
    socket.destroy();
    expect(event).toBe('error');

    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(response.body).toBe('done');
    expect(await closing).toEqual({ forced: false });
  });

  it('force-closes connections and cancels upstream calls after the drain deadline', async () => {
    const upstream = track(await slowUpstream(10_000));
    const { gateway, publicPort } = await startFull(upstream, 150);

    const inFlight = send(publicPort, { path: '/api/orders/1' }).then(
      () => 'completed',
      () => 'connection closed',
    );
    await untilReceived(upstream.requests, 1);

    const started = performance.now();
    const result = await gateway.close();
    const elapsed = performance.now() - started;

    expect(result).toEqual({ forced: true });
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(2000);
    expect(await inFlight).toBe('connection closed');
  });

  it('is idempotent', async () => {
    const upstream = track(await startUpstream());
    const { gateway } = await startFull(upstream, 1000);
    const first = gateway.close();
    expect(gateway.close()).toBe(first);
    await first;
  });
});

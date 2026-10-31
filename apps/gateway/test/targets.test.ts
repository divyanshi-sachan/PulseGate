import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureLogs,
  configFor,
  freePort,
  send,
  startGateway,
  startUpstream,
  type MockUpstream,
  type RouteDef,
  type RunningGateway,
} from './harness.ts';

/**
 * Several targets behind one upstream (ADR-0051): distribution, passive ejection, retries landing on another target,
 * re-admission through one probe at a time, and what must never count against a target.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

type Handler = Parameters<typeof startUpstream>[0];

/** A replica that records requests; `status` can be changed during a test. */
async function replica(init: { status?: number; handler?: Handler } = {}) {
  const state = { status: init.status ?? 200 };
  const upstream: MockUpstream = await startUpstream(
    init.handler ??
      ((_req, res) => {
        res.statusCode = state.status;
        res.setHeader('content-type', 'text/plain');
        res.end(String(state.status));
      }),
  );
  cleanups.push(() => upstream.close());
  return { upstream, state };
}

async function gatewayFor(
  urls: string[],
  upstream: Record<string, unknown> = {},
  route: RouteDef = {},
  now?: () => number,
): Promise<{ gw: RunningGateway; logs: ReturnType<typeof captureLogs> }> {
  const logs = captureLogs('warn');
  const gw = await startGateway(
    configFor(urls[0] ?? '', [route], {
      upstreams: [{ id: 'orders-service', targets: urls, ...upstream }],
    }),
    { ...logs.options, ...(now === undefined ? {} : { breakerClock: now }) },
  );
  cleanups.push(() => gw.close());
  return { gw, logs };
}

const get = (gw: RunningGateway, path = '/api/orders/item') => send(gw.port, { path });
const counts = (replicas: { upstream: MockUpstream }[]) =>
  replicas.map((r) => r.upstream.requests.length);

function metricValue(text: string, name: string, labels: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${name}{`) && l.includes(labels));
  return line === undefined ? 0 : Number(line.split(' ').at(-1));
}

describe('distribution (ADR-0051)', () => {
  it('round-robins sequential requests evenly across the targets', async () => {
    const replicas = [await replica(), await replica(), await replica()];
    const { gw } = await gatewayFor(replicas.map((r) => r.upstream.url));
    for (let i = 0; i < 300; i++) expect((await get(gw)).status).toBe(200);
    expect(counts(replicas)).toEqual([100, 100, 100]);
    const text = await gw.gateway.metrics.text();
    for (const t of ['t0', 't1', 't2']) {
      expect(
        metricValue(
          text,
          'pulsegate_upstream_target_requests_total',
          `target="${t}",outcome="success"`,
        ),
      ).toBe(100);
      expect(
        metricValue(text, 'pulsegate_upstream_target_state', `target="${t}",state="healthy"`),
      ).toBe(1);
    }
  });

  it('least-connections keeps traffic away from a target that is holding a request', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = await replica({
      handler: (_req, res) => {
        void held.then(() => res.end('slow'));
      },
    });
    const fast1 = await replica();
    const fast2 = await replica();
    const { gw } = await gatewayFor(
      [slow, fast1, fast2].map((r) => r.upstream.url),
      {
        loadBalancing: 'least-connections',
      },
    );
    const first = get(gw); // lands on t0 (all idle) and stays in flight
    await vi.waitFor(() => {
      expect(slow.upstream.requests).toHaveLength(1);
    });
    for (let i = 0; i < 20; i++) expect((await get(gw)).status).toBe(200);
    expect(counts([slow, fast1, fast2])).toEqual([1, 10, 10]);
    release();
    expect((await first).body).toBe('slow');
  });
});

describe('passive ejection (ADR-0051)', () => {
  it('ejects a failing target after the configured consecutive failures and logs and counts it', async () => {
    const replicas = [await replica(), await replica({ status: 503 }), await replica()];
    const { gw, logs } = await gatewayFor(
      replicas.map((r) => r.upstream.url),
      {
        outlierEjection: { consecutiveFailures: 3, ejectionMs: 3_600_000 },
      },
    );
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await get(gw)).status);

    expect(replicas[1]?.upstream.requests).toHaveLength(3); // exactly the failures that ejected it
    expect(statuses.filter((s) => s === 503)).toHaveLength(3);
    expect(counts([replicas[0] as never, replicas[2] as never])).toEqual([14, 13]); // the rest, alternating
    const text = await gw.gateway.metrics.text();
    expect(
      metricValue(text, 'pulsegate_upstream_target_state', 'target="t1",state="ejected"'),
    ).toBe(1);
    expect(
      metricValue(text, 'pulsegate_upstream_target_state', 'target="t1",state="healthy"'),
    ).toBe(0);
    expect(metricValue(text, 'pulsegate_upstream_target_ejections_total', 'target="t1"')).toBe(1);
    expect(
      metricValue(
        text,
        'pulsegate_upstream_target_requests_total',
        'target="t1",outcome="failure"',
      ),
    ).toBe(3);
    // The service-level breaker saw successes in between and stayed closed: it can't see one bad replica.
    expect(
      metricValue(text, 'pulsegate_circuit_breaker_transitions_total', 'upstream="orders-service"'),
    ).toBe(0);
    const change = logs.lines().filter((l) => l['msg'] === 'upstream target state changed');
    expect(change).toHaveLength(1);
    expect(change[0]).toMatchObject({
      upstreamId: 'orders-service',
      targetId: 't1',
      from: 'healthy',
      to: 'ejected',
    });
  });

  it('does not eject for upstream 4xx responses', async () => {
    const replicas = [await replica({ status: 404 }), await replica({ status: 404 })];
    const { gw } = await gatewayFor(
      replicas.map((r) => r.upstream.url),
      {
        outlierEjection: { consecutiveFailures: 2 },
      },
    );
    for (let i = 0; i < 20; i++) expect((await get(gw)).status).toBe(404);
    expect(counts(replicas)).toEqual([10, 10]);
    expect(await gw.gateway.metrics.text()).not.toContain(
      'pulsegate_upstream_target_ejections_total{',
    );
  });

  it('does not eject when clients abandon requests (neutral outcomes)', async () => {
    const hung = await replica({ handler: () => undefined }); // never answers
    const ok = await replica();
    const { gw } = await gatewayFor(
      [hung, ok].map((r) => r.upstream.url),
      {
        outlierEjection: { consecutiveFailures: 2 },
      },
    );
    for (let i = 0; i < 4; i++) {
      // Round-robin alternates: this request reaches the hung target, and the client then gives up.
      const req = httpRequest({
        host: '127.0.0.1',
        port: gw.port,
        path: '/api/orders/item',
        agent: false,
      });
      req.on('error', () => undefined);
      req.end();
      await vi.waitFor(() => {
        expect(hung.upstream.requests).toHaveLength(i + 1);
      });
      req.destroy();
      expect((await get(gw)).status).toBe(200); // the next one goes to the other target
    }
    // Four abandoned requests on a target that ejects after 2 failures: it must still be healthy.
    const text = await gw.gateway.metrics.text();
    expect(
      metricValue(text, 'pulsegate_upstream_target_state', 'target="t0",state="healthy"'),
    ).toBe(1);
    expect(
      metricValue(
        text,
        'pulsegate_upstream_target_requests_total',
        'target="t0",outcome="aborted"',
      ),
    ).toBe(4);
    expect(text).not.toContain('pulsegate_upstream_target_ejections_total{');
  });

  it('ejects a target that refuses connections, and clients still succeed through retries', async () => {
    const live = await replica();
    const deadUrl = `http://127.0.0.1:${String(await freePort())}`;
    const { gw } = await gatewayFor(
      [deadUrl, live.upstream.url],
      { outlierEjection: { consecutiveFailures: 3, ejectionMs: 3_600_000 } },
      { retries: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } },
    );
    for (let i = 0; i < 20; i++) expect((await get(gw)).status).toBe(200);
    const text = await gw.gateway.metrics.text();
    expect(
      metricValue(text, 'pulsegate_upstream_target_state', 'target="t0",state="ejected"'),
    ).toBe(1);
    expect(
      metricValue(
        text,
        'pulsegate_upstream_target_requests_total',
        'target="t0",outcome="failure"',
      ),
    ).toBe(3);
    expect(live.upstream.requests).toHaveLength(20);
  });
});

describe('retries land on a different target (ADR-0051)', () => {
  it('retries a failed attempt on another target, so every client request succeeds', async () => {
    const bad = await replica({ status: 503 });
    const good = await replica();
    const { gw } = await gatewayFor(
      [bad, good].map((r) => r.upstream.url),
      { outlierEjection: { consecutiveFailures: 5, ejectionMs: 3_600_000 } },
      { retries: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } },
    );
    expect((await get(gw)).status).toBe(200);
    expect(counts([bad, good])).toEqual([1, 1]); // the retry went to the other target, not back to the same one
    for (let i = 0; i < 9; i++) expect((await get(gw)).status).toBe(200);
    // The bad target kept failing first until its fifth consecutive failure ejected it; then it got nothing.
    expect(counts([bad, good])).toEqual([5, 10]);
  });

  /**
   * With least-connections, the failed target has fewer in-flight attempts than a busy one, so without an explicit
   * exclusion the retry would go straight back to it. Target 0 holds a request open; target 1 is the broken one.
   */
  async function busyTargetAndBrokenTarget(broken: 'status' | 'refused') {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const busy = await replica({
      handler: (_req, res) => {
        calls++;
        if (calls === 1) void held.then(() => res.end('held'));
        else res.end('busy-target');
      },
    });
    const brokenUrl =
      broken === 'status'
        ? (await replica({ status: 503 })).upstream.url
        : `http://127.0.0.1:${String(await freePort())}`;
    const { gw } = await gatewayFor(
      [busy.upstream.url, brokenUrl],
      { loadBalancing: 'least-connections', outlierEjection: { consecutiveFailures: 10 } },
      { retries: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } },
    );
    const first = get(gw); // all idle: lands on target 0 and stays in flight
    await vi.waitFor(() => {
      expect(busy.upstream.requests).toHaveLength(1);
    });
    return { gw, first, release };
  }

  it.each(['status', 'refused'] as const)(
    'least-connections retry avoids the failed target even when the other is busier (%s)',
    async (broken) => {
      const { gw, first, release } = await busyTargetAndBrokenTarget(broken);
      // Target 1 has fewer in-flight attempts, so it is chosen first, fails, and the retry must go to target 0.
      const response = await get(gw);
      expect(response.status).toBe(200);
      expect(response.body).toBe('busy-target');
      release();
      await first;
    },
  );

  it('cuts a hung target at the attempt timeout and retries elsewhere within the deadline', async () => {
    const hung = await replica({ handler: () => undefined });
    const good = await replica();
    const { gw } = await gatewayFor(
      [hung, good].map((r) => r.upstream.url),
      {},
      {
        timeoutMs: 3000,
        attemptTimeoutMs: 150,
        retries: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      },
    );
    const started = performance.now();
    const response = await get(gw);
    expect(response.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(counts([hung, good])).toEqual([1, 1]);
  });
});

describe('re-admission (ADR-0051)', () => {
  it('keeps an ejected target out until the ejection ends, then admits it again after a successful probe', async () => {
    let now = 0;
    const flaky = await replica({ status: 503 });
    const steady = await replica();
    const { gw, logs } = await gatewayFor(
      [flaky, steady].map((r) => r.upstream.url),
      { outlierEjection: { consecutiveFailures: 2, ejectionMs: 1000 } },
      {},
      () => now,
    );
    for (let i = 0; i < 4; i++) await get(gw); // t0 fails twice (requests 1 and 3) and is ejected
    const afterEjection = flaky.upstream.requests.length;
    expect(afterEjection).toBe(2);
    for (let i = 0; i < 6; i++) expect((await get(gw)).status).toBe(200);
    expect(flaky.upstream.requests).toHaveLength(afterEjection); // no traffic while ejected

    flaky.state.status = 200; // the replica recovers
    now = 1000; // the ejection time is over
    for (let i = 0; i < 6; i++) expect((await get(gw)).status).toBe(200);
    expect(flaky.upstream.requests.length).toBeGreaterThan(afterEjection);

    const text = await gw.gateway.metrics.text();
    expect(
      metricValue(text, 'pulsegate_upstream_target_state', 'target="t0",state="healthy"'),
    ).toBe(1);
    const transitions = logs
      .lines()
      .filter((l) => l['msg'] === 'upstream target state changed' && l['targetId'] === 't0')
      .map((l) => `${String(l['from'])}->${String(l['to'])}`);
    expect(transitions).toEqual(['healthy->ejected', 'ejected->probing', 'probing->healthy']);
  });
});

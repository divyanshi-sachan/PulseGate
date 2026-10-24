import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.ts';
import {
  cacheOf,
  fakeApi,
  rateLimitsOf,
  routesConfigOf,
  statsOf,
  trafficWindow,
  upstreamsOf,
} from '../test/fixtures.ts';
import Cache from './Cache.tsx';
import Overview from './Overview.tsx';
import RateLimits from './RateLimits.tsx';
import Routes from './Routes.tsx';
import Upstreams from './Upstreams.tsx';

const onUnauthorized = vi.fn();

/** The e2e traffic mix of plan §7, recorded into a real StatsWindow. */
function e2eTraffic() {
  const t = trafficWindow();
  const w = t.window;
  // orders: 1 miss then 4 hits (cache), all allowed.
  for (let i = 0; i < 5; i++) {
    w.recordRateLimit('orders', true, false);
    w.recordCacheLookup('orders', i === 0 ? 'miss' : 'hit');
    t.request('orders', 200, 10 + i);
  }
  w.recordCacheStore('orders', 'stored');
  w.recordAttempt({
    routeId: 'orders',
    upstreamId: 'orders-service',
    outcome: 'success',
    latencyMs: 9,
  });
  // payments: capacity 3 → 3 allowed, 2 rejected; two failed attempts open the breaker.
  for (let i = 0; i < 5; i++) {
    const allowed = i < 3;
    w.recordRateLimit('payments', allowed, false);
    t.request(
      'payments',
      allowed ? 502 : 429,
      20,
      allowed ? 'UPSTREAM_UNAVAILABLE' : 'RATE_LIMIT_EXCEEDED',
    );
  }
  for (let i = 0; i < 2; i++) {
    w.recordAttempt({
      routeId: 'payments',
      upstreamId: 'orders-service',
      outcome: 'failure',
      latencyMs: 30,
    });
  }
  t.advance(3_000);
  return t;
}

describe('Overview', () => {
  it('shows the empty state instead of flat charts when the window is quiet', async () => {
    const { window } = trafficWindow();
    render(
      <Overview
        api={fakeApi({ stats: () => Promise.resolve(statsOf(window)) })}
        onUnauthorized={onUnauthorized}
      />,
    );
    expect((await screen.findByTestId('empty-state')).textContent).toContain(
      'No traffic in the last 5 minutes',
    );
    expect(screen.getByTestId('kpi-requests').textContent).toBe('0');
    expect(screen.getByTestId('kpi-error-rate').textContent).toBe('—');
    expect(screen.queryByRole('figure')).toBeNull();
  });

  it('shows KPIs and the three trend charts with their table alternatives', async () => {
    const { window } = e2eTraffic();
    render(
      <Overview
        api={fakeApi({ stats: () => Promise.resolve(statsOf(window)) })}
        onUnauthorized={onUnauthorized}
      />,
    );
    expect((await screen.findByTestId('kpi-requests')).textContent).toBe('10');
    expect(screen.getByTestId('kpi-success-rate').textContent).toBe('50 %');
    expect(screen.getByTestId('kpi-error-rate').textContent).toBe('30 %');
    expect(screen.getByTestId('kpi-p99').nextElementSibling?.textContent).toBe(
      'low confidence, n=10',
    );
    const figures = screen.getAllByRole('figure');
    expect(figures.map((f) => f.getAttribute('aria-labelledby') !== null)).toEqual([
      true,
      true,
      true,
    ]);
    const latency = screen.getByRole('table', { name: 'Latency' });
    expect(within(latency).getAllByRole('row')).toHaveLength(2); // header + one bucket
    expect(screen.getByText('gw_fixture')).toBeDefined();
  });
});

describe('Routes', () => {
  async function renderRoutes() {
    const { window } = e2eTraffic();
    render(
      <Routes
        api={fakeApi({
          stats: () => Promise.resolve(statsOf(window)),
          routes: () => Promise.resolve(routesConfigOf(window)),
        })}
        onUnauthorized={onUnauthorized}
      />,
    );
    await screen.findByTestId('route-row-orders');
  }

  it('lists every route with its window numbers', async () => {
    await renderRoutes();
    expect(screen.getByTestId('route-cache-orders').textContent).toBe('80 %');
    expect(screen.getByTestId('route-rejected-payments').textContent).toBe('40 %');
    expect(screen.getByTestId('route-cache-payments').textContent).toBe('—');
    expect(screen.getByRole('img', { name: /orders throughput trend/ })).toBeDefined();
  });

  it('sorts by a column, announcing the direction', async () => {
    await renderRoutes();
    const header = screen.getByRole('columnheader', { name: /Rate limited/ });
    await userEvent.click(within(header).getByRole('button'));
    expect(header.getAttribute('aria-sort')).toBe('descending');
    const order = () => screen.getAllByTestId(/^route-row-/).map((r) => r.dataset['testid']);
    expect(order()).toEqual(['route-row-payments', 'route-row-orders']);
    await userEvent.click(within(header).getByRole('button'));
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(order()).toEqual(['route-row-orders', 'route-row-payments']);
  });

  it('shows the selected route configuration and trends', async () => {
    await renderRoutes();
    await userEvent.click(screen.getByRole('button', { name: 'payments' }));
    const detail = screen.getByTestId('route-detail');
    expect(within(detail).getByText('API key required')).toBeDefined();
    expect(within(detail).getByText(/Up to 3 attempts on 502, 503, 504/)).toBeDefined();
    expect(within(detail).getByRole('table', { name: 'payments: latency' })).toBeDefined();
  });
});

describe('Upstreams', () => {
  it('shows the breaker state as text and the attempt failure rate', async () => {
    const { window } = e2eTraffic();
    render(
      <Upstreams
        api={fakeApi({
          upstreams: () =>
            Promise.resolve(upstreamsOf(window, { state: 'open', consecutiveFailures: 2 })),
        })}
        onUnauthorized={onUnauthorized}
      />,
    );
    const badge = await screen.findByTestId('breaker-orders-service');
    expect(badge.textContent).toContain('Open');
    expect(badge.dataset['state']).toBe('open');
    expect(screen.getByTestId('upstream-failure-rate-orders-service').textContent).toBe('67 %');
    expect(screen.getByText('2 / 2')).toBeDefined();
  });
});

describe('Cache', () => {
  it('shows the hit ratio without bypasses, memory against its bounds and evictions', async () => {
    const t = e2eTraffic();
    t.window.recordCacheLookup('orders', 'bypass');
    render(
      <Cache
        api={fakeApi({ cache: () => Promise.resolve(cacheOf(t.window)) })}
        onUnauthorized={onUnauthorized}
      />,
    );
    expect((await screen.findByTestId('cache-hit-ratio-orders')).textContent).toBe('80 %');
    expect(screen.getByTestId('cache-bypass-rate-orders').textContent).toBe('17 %');
    expect(screen.getByTestId('cache-store-rate-orders').textContent).toBe('100 %');
    expect(screen.getByTestId('cache-entries').textContent).toBe('1 of 10,000 (< 0.1 %)');
    expect(screen.getByTestId('cache-bytes').textContent).toBe('2.0 KiB of 64 MiB (< 0.1 %)');
    expect(screen.getByLabelText('Entries')).toHaveProperty('value', 1);
    expect(screen.getByText(/3 for space, 7/)).toBeDefined();
  });
});

describe('Rate limits', () => {
  it('shows the rejection rate per route and the local backend', async () => {
    const { window } = e2eTraffic();
    render(
      <RateLimits
        api={fakeApi({ rateLimits: () => Promise.resolve(rateLimitsOf(window)) })}
        onUnauthorized={onUnauthorized}
      />,
    );
    expect((await screen.findByTestId('rejection-rate-payments')).textContent).toBe('40 %');
    expect(screen.getByTestId('rejection-rate-orders').textContent).toBe('0 %');
    expect(screen.getByText('Local (per instance)')).toBeDefined();
    expect(screen.queryByTestId('rate-limit-degraded')).toBeNull();
    // Only routes with limiter decisions get a trend chart.
    expect(screen.getAllByRole('figure')).toHaveLength(2);
  });

  it('announces fail-open degradation and shows the Redis target', async () => {
    const { window } = e2eTraffic();
    render(
      <RateLimits
        api={fakeApi({
          rateLimits: () =>
            Promise.resolve(
              rateLimitsOf(window, {
                kind: 'redis',
                healthy: false,
                target: 'redis:6379',
                degraded: true,
              }),
            ),
        })}
        onUnauthorized={onUnauthorized}
      />,
    );
    expect((await screen.findByTestId('rate-limit-degraded')).textContent).toContain('fail-open');
    expect(screen.getByText('redis:6379')).toBeDefined();
    expect(within(screen.getByTestId('rate-limit-health')).getByText('Unavailable')).toBeDefined();
  });
});

describe('screen states (plan §4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  it('keeps showing data with a stale banner after two missed polls, then recovers', async () => {
    const { window } = e2eTraffic();
    const answers = [
      () => Promise.resolve(statsOf(window)),
      () => Promise.reject(new ApiError('unreachable', 'The admin API could not be reached')),
      () => Promise.reject(new ApiError('unreachable', 'The admin API could not be reached')),
      () => Promise.resolve(statsOf(window)),
    ];
    let call = 0;
    const ok = () => Promise.resolve(statsOf(window));
    const stats = () => (answers[call++] ?? ok)();
    render(<Overview api={fakeApi({ stats: () => stats() })} onUnauthorized={onUnauthorized} />);
    await tick(0);
    expect(screen.getByTestId('kpi-requests').textContent).toBe('10');
    await tick(5_000);
    expect(screen.queryByTestId('stale-banner')).toBeNull();
    await tick(5_000);
    expect(screen.getByTestId('stale-banner').textContent).toContain('The last 2 refreshes failed');
    expect(screen.getByTestId('kpi-requests').textContent).toBe('10');
    await tick(5_000);
    expect(screen.queryByTestId('stale-banner')).toBeNull();
  });

  it('shows an unreachable API with a retry button when nothing has loaded yet', async () => {
    const { window } = trafficWindow();
    let fail = true;
    const stats = vi.fn(() =>
      fail ? Promise.reject(new ApiError('unreachable', 'down')) : Promise.resolve(statsOf(window)),
    );
    render(<Overview api={fakeApi({ stats })} onUnauthorized={onUnauthorized} />);
    await tick(0);
    expect(screen.getByTestId('screen-error').textContent).toContain('could not be reached');
    fail = false;
    act(() => {
      screen.getByRole('button', { name: 'Try again' }).click();
    });
    await tick(0);
    expect(screen.queryByTestId('screen-error')).toBeNull();
    expect(screen.getByTestId('kpi-requests').textContent).toBe('0');
  });

  it('pauses, resumes and refreshes on demand', async () => {
    const { window } = trafficWindow();
    const stats = vi.fn(() => Promise.resolve(statsOf(window)));
    render(<Overview api={fakeApi({ stats })} onUnauthorized={onUnauthorized} />);
    await tick(0);
    act(() => {
      screen.getByRole('button', { name: 'Pause' }).click();
    });
    expect(screen.getByRole('button', { name: 'Resume' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByTestId('last-updated').textContent).toContain('paused');
    await tick(30_000);
    expect(stats).toHaveBeenCalledTimes(1);
    act(() => {
      screen.getByTestId('refresh-now').click();
    });
    await tick(0);
    expect(stats).toHaveBeenCalledTimes(2);
    act(() => {
      screen.getByRole('button', { name: 'Resume' }).click();
    });
    await tick(0);
    expect(stats).toHaveBeenCalledTimes(3);
  });

  it('notes a young window (collecting since the gateway started)', async () => {
    const { window } = trafficWindow();
    render(
      <Overview
        api={fakeApi({ stats: () => Promise.resolve(statsOf(window)) })}
        onUnauthorized={onUnauthorized}
      />,
    );
    await tick(0);
    expect(screen.getByText(/collecting for 0 s \(since the gateway started\)/)).toBeDefined();
  });
});

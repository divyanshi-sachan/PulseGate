import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type AdminApi } from '../api/client.ts';
import { createTokenStore, TOKEN_KEY } from '../auth/token-store.ts';
import {
  cacheOf,
  fakeApi,
  statsFixture,
  TOKEN,
  trafficWindow,
  upstreamsOf,
} from '../test/fixtures.ts';
import { App, SESSION_EXPIRED } from './App.tsx';

function api(stats: AdminApi['stats']): AdminApi {
  const unused = () => Promise.reject(new Error('not used'));
  return { stats, upstreams: unused, routes: unused, rateLimits: unused, cache: unused };
}

describe('app shell', () => {
  it('starts at the token gate without a stored token', () => {
    render(
      <App store={createTokenStore()} connect={() => api(() => Promise.resolve(statsFixture()))} />,
    );
    expect(screen.getByRole('heading', { name: 'PulseGate admin' })).toBeDefined();
  });

  it('opens the overview with a stored token and shows window KPIs', async () => {
    const store = createTokenStore();
    store.set(TOKEN);
    const fixture = statsFixture([
      { latencyMs: 10, statusCode: 200 },
      { latencyMs: 20, statusCode: 503 },
    ]);
    render(<App store={store} connect={() => api(() => Promise.resolve(fixture))} />);
    expect((await screen.findByTestId('kpi-requests')).textContent).toBe('2');
    expect(screen.getByTestId('kpi-error-rate').textContent).toBe('50 %');
    expect(screen.getByText('gw_fixture')).toBeDefined();
    // p95 and p99 tiles: shown, but marked low confidence with n.
    expect(screen.getAllByText(/low confidence, n=2/)).toHaveLength(2);
  });

  it('goes back to the gate with a notice when the stored token is rejected, and forgets it', async () => {
    const store = createTokenStore();
    store.set(TOKEN);
    render(
      <App
        store={store}
        connect={() => api(() => Promise.reject(new ApiError('unauthorized', 'rejected', 401)))}
      />,
    );
    expect(await screen.findByText(SESSION_EXPIRED)).toBeDefined();
    expect(screen.getByLabelText('Admin token')).toBeDefined();
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('shows an unreachable API as an error on the screen, not as a sign-out', async () => {
    const store = createTokenStore();
    store.set(TOKEN);
    render(
      <App
        store={store}
        connect={() => api(() => Promise.reject(new ApiError('unreachable', 'x')))}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toContain('could not be reached');
    expect(store.get()).toBe(TOKEN);
  });

  it('signs out on request', async () => {
    const store = createTokenStore();
    store.set(TOKEN);
    const connect = vi.fn(() => api(() => Promise.resolve(statsFixture())));
    render(<App store={store} connect={connect} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(screen.getByLabelText('Admin token')).toBeDefined();
    expect(store.get()).toBeUndefined();
  });

  it('accepts a token at the gate and keeps it for the tab', async () => {
    const store = createTokenStore();
    render(<App store={store} connect={() => api(() => Promise.resolve(statsFixture()))} />);
    await userEvent.type(screen.getByLabelText('Admin token'), `${TOKEN}{Enter}`);
    expect(await screen.findByTestId('kpi-requests')).toBeDefined();
    expect(window.sessionStorage.getItem(TOKEN_KEY)).toBe(TOKEN);
  });

  it('navigates between screens with real URLs, and back', async () => {
    const store = createTokenStore();
    store.set(TOKEN);
    const { window: w } = trafficWindow();
    const connect = () =>
      fakeApi({
        stats: () => Promise.resolve(statsFixture()),
        upstreams: () =>
          Promise.resolve(upstreamsOf(w, { state: 'closed', consecutiveFailures: 0 })),
      });
    render(<App store={store} connect={connect} />);
    await screen.findByTestId('kpi-requests');
    const nav = screen.getByRole('navigation', { name: 'Screens' });
    expect(within(nav).getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe(
      'page',
    );
    await userEvent.click(within(nav).getByRole('link', { name: 'Upstreams' }));
    expect(window.location.pathname).toBe('/admin/ui/upstreams');
    expect(await screen.findByTestId('breaker-orders-service')).toBeDefined();
    expect(within(nav).getByRole('link', { name: 'Upstreams' }).getAttribute('aria-current')).toBe(
      'page',
    );
    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe('/admin/ui/');
    });
    expect(await screen.findByTestId('kpi-requests')).toBeDefined();
  });

  it('opens the screen named in the URL', async () => {
    window.history.replaceState(null, '', '/admin/ui/cache');
    const store = createTokenStore();
    store.set(TOKEN);
    const { window: w } = trafficWindow();
    render(
      <App store={store} connect={() => fakeApi({ cache: () => Promise.resolve(cacheOf(w)) })} />,
    );
    expect(await screen.findByRole('heading', { name: 'Cache', level: 1 })).toBeDefined();
  });
});

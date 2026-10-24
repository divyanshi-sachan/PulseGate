import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type AdminApi } from '../api/client.ts';
import { createTokenStore, TOKEN_KEY } from '../auth/token-store.ts';
import { statsFixture, TOKEN } from '../test/fixtures.ts';
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
    // Two samples: shown, but marked as low confidence with n.
    expect(screen.getByText(/low confidence, n=2/)).toBeDefined();
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
});

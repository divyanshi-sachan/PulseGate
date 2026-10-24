import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type AdminApi } from '../api/client.ts';
import { statsFixture, TOKEN } from '../test/fixtures.ts';
import { TokenGate } from './TokenGate.tsx';

function apiAnswering(stats: AdminApi['stats']): AdminApi {
  const unused = () => Promise.reject(new Error('not used'));
  return { stats, upstreams: unused, routes: unused, rateLimits: unused, cache: unused };
}

function renderGate(stats: AdminApi['stats']) {
  const connect = vi.fn<(token: string) => AdminApi>(() => apiAnswering(stats));
  const onAuthenticated = vi.fn();
  render(<TokenGate connect={connect} onAuthenticated={onAuthenticated} />);
  return { connect, onAuthenticated, input: screen.getByLabelText('Admin token') };
}

describe('token gate (ADR-0037)', () => {
  it('uses a masked, non-autocompleted field', () => {
    const { input } = renderGate(() => Promise.resolve(statsFixture()));
    expect(input).toHaveProperty('type', 'password');
    expect(input.getAttribute('autocomplete')).toBe('off');
  });

  it('explains the length rule before calling the API', async () => {
    const { connect, input } = renderGate(() => Promise.resolve(statsFixture()));
    await userEvent.type(input, 'too-short{Enter}');
    expect(screen.getByRole('alert').textContent).toContain('at least 32 characters');
    expect(connect).not.toHaveBeenCalled();
  });

  it('verifies the token against the API, then accepts it trimmed', async () => {
    const stats = vi.fn(() => Promise.resolve(statsFixture()));
    const { connect, onAuthenticated, input } = renderGate(stats);
    await userEvent.type(input, `  ${TOKEN}  {Enter}`);
    expect(connect).toHaveBeenCalledWith(TOKEN);
    expect(stats).toHaveBeenCalledTimes(1);
    expect(onAuthenticated).toHaveBeenCalledWith(TOKEN);
  });

  it('reports a rejected token and does not accept it', async () => {
    const { onAuthenticated, input } = renderGate(() =>
      Promise.reject(new ApiError('unauthorized', 'rejected', 401)),
    );
    await userEvent.type(input, `${TOKEN}{Enter}`);
    expect((await screen.findByRole('alert')).textContent).toContain('This token was rejected');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('reports an unreachable gateway', async () => {
    const { input } = renderGate(() => Promise.reject(new ApiError('unreachable', 'down')));
    await userEvent.type(input, `${TOKEN}{Enter}`);
    expect((await screen.findByRole('alert')).textContent).toContain('could not be reached');
  });

  it('never shows the token in the page text', async () => {
    const { input } = renderGate(() => Promise.reject(new ApiError('unauthorized', 'x', 401)));
    await userEvent.type(input, `${TOKEN}{Enter}`);
    await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});

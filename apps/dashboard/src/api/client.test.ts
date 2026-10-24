import { describe, expect, it } from 'vitest';
import { fakeFetch, statsFixture, TOKEN } from '../test/fixtures.ts';
import { ApiError, createAdminApi } from './client.ts';

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('admin API client', () => {
  it('sends the token as a Bearer header, same origin, uncached, without cookies', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, body: statsFixture() });
    await createAdminApi({ token: TOKEN, fetch }).stats();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('/admin/api/stats');
    expect(call?.url).not.toContain(TOKEN);
    expect(call?.init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
    });
  });

  it('requests each of the five endpoints', async () => {
    const { fetch, calls } = fakeFetch({ status: 500, body: {} });
    const api = createAdminApi({ token: TOKEN, fetch });
    for (const load of [api.stats, api.upstreams, api.routes, api.rateLimits, api.cache]) {
      await failure(load());
    }
    expect(calls.map((c) => c.url)).toEqual([
      '/admin/api/stats',
      '/admin/api/upstreams',
      '/admin/api/routes',
      '/admin/api/rate-limits',
      '/admin/api/cache',
    ]);
  });

  it('returns a response that matches the contract', async () => {
    const fixture = statsFixture([{ latencyMs: 12, statusCode: 200 }]);
    const { fetch } = fakeFetch({ status: 200, body: fixture });
    const stats = await createAdminApi({ token: TOKEN, fetch }).stats();
    expect(stats.total.window.counters.requests).toBe(1);
  });

  it('maps a 401 to unauthorized with the gateway error code', async () => {
    const { fetch } = fakeFetch({
      status: 401,
      body: { error: { code: 'ADMIN_AUTHENTICATION_FAILED', message: 'x', requestId: 'r' } },
    });
    const error = await failure(createAdminApi({ token: TOKEN, fetch }).stats());
    expect(error).toMatchObject({
      kind: 'unauthorized',
      status: 401,
      code: 'ADMIN_AUTHENTICATION_FAILED',
    });
  });

  it('maps other statuses to http errors', async () => {
    const { fetch } = fakeFetch({ status: 503, raw: 'Service Unavailable' });
    const error = await failure(createAdminApi({ token: TOKEN, fetch }).stats());
    expect(error).toMatchObject({ kind: 'http', status: 503, code: undefined });
  });

  it('rejects a response that does not match the contract, naming the field', async () => {
    const broken = statsFixture() as unknown as {
      total: { window: { counters: { requests: unknown } } };
    };
    broken.total.window.counters.requests = -1;
    const { fetch } = fakeFetch({ status: 200, body: broken });
    const error = await failure(createAdminApi({ token: TOKEN, fetch }).stats());
    expect(error.kind).toBe('invalid-response');
    expect(error.message).toContain('total.window.counters.requests');
  });

  it('rejects a 200 that is not JSON', async () => {
    const { fetch } = fakeFetch({ status: 200, raw: '<html>proxy error</html>' });
    const error = await failure(createAdminApi({ token: TOKEN, fetch }).stats());
    expect(error.kind).toBe('invalid-response');
  });

  it('maps a network failure to unreachable, without the token in the message', async () => {
    const fetch = () => Promise.reject(new TypeError(`Failed to fetch with ${TOKEN}`));
    const error = await failure(createAdminApi({ token: TOKEN, fetch }).stats());
    expect(error.kind).toBe('unreachable');
    expect(error.message).not.toContain(TOKEN);
  });

  it('times out a hung request as unreachable', async () => {
    const fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const error = await failure(createAdminApi({ token: TOKEN, fetch, timeoutMs: 5 }).stats());
    expect(error.kind).toBe('unreachable');
  });

  it("propagates the caller's own abort instead of reporting a failure", async () => {
    const fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const controller = new AbortController();
    const pending = createAdminApi({ token: TOKEN, fetch }).stats(controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(DOMException);
  });
});

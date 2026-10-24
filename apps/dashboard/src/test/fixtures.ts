import { statsResponseSchema, type StatsResponse } from '@pulsegate/admin-contract';
import { StatsWindow } from '@pulsegate/observability';

/**
 * Contract fixtures come from the gateway's real StatsWindow, then pass through the shared schema, so the dashboard's
 * tests can't drift from what the API actually sends (plan §6).
 */
export function statsFixture(
  requests: { latencyMs: number; statusCode: number }[] = [],
): StatsResponse {
  const window = new StatsWindow({
    routes: ['orders'],
    upstreams: ['orders-service'],
    wallClock: () => 1_700_000_000_000,
    monotonic: () => 5_000,
    random: () => 0.5,
    instanceId: 'gw_fixture',
  });
  for (const r of requests) {
    window.recordRequest({ routeId: 'orders', code: undefined, ...r });
  }
  const orders = window.routeSeries('orders');
  if (orders === undefined) throw new Error('fixture route missing');
  return statsResponseSchema.parse({
    ...window.envelope(),
    total: window.totalSeries(),
    routes: [{ id: 'orders', series: orders }],
  });
}

/** A fetch double that answers every request with `status` and a JSON (or raw) body, recording calls. */
export function fakeFetch(answer: { status: number; body?: unknown; raw?: string }) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
    const text = answer.raw ?? JSON.stringify(answer.body ?? null);
    return Promise.resolve(
      new Response(text, {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch, calls };
}

export const TOKEN = 'f'.repeat(40);

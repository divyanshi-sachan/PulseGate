import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Exit criterion (plan §7): the dashboard shows exactly the numbers implied by traffic the test sends itself, and
 * the same numbers the admin API reports. Runs against a fresh stack from scripts/e2e.sh (config/routes.e2e.yaml).
 */
const PUBLIC = process.env['E2E_PUBLIC_URL'] ?? 'http://127.0.0.1:8080';
const TOKEN = process.env['E2E_ADMIN_TOKEN'] ?? 'pulsegate-e2e-admin-token-not-a-secret';

test.describe.configure({ mode: 'serial' });

/** Every request sent through the public port, so totals stay exact even where a scenario polls. */
let sent = 0;
/** Unique per run: the mock's `_failTimes` counters are keyed, so reruns against one stack can't interfere. */
const RUN = `run-${Date.now().toString(36)}`;

async function get(api: APIRequestContext, path: string) {
  sent++;
  return api.get(`${PUBLIC}${path}`);
}

async function statuses(api: APIRequestContext, path: string, times: number): Promise<number[]> {
  const result: number[] = [];
  for (let i = 0; i < times; i++) result.push((await get(api, path)).status());
  return result;
}

async function errorCode(response: { json: () => Promise<unknown> }): Promise<unknown> {
  const body = (await response.json()) as { error?: { code?: unknown } };
  return body.error?.code;
}

interface BreakerView {
  id: string;
  breaker: { state: string; consecutiveFailures: number };
}

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext();
  const admin = async (path: string) =>
    (await (
      await api.get(
        `${process.env['E2E_ADMIN_URL'] ?? 'http://127.0.0.1:9090'}/admin/api/${path}`,
        {
          headers: { authorization: `Bearer ${TOKEN}` },
        },
      )
    ).json()) as Record<string, unknown>;

  // Plan §7 traffic, sequential and explicit (faults via query parameters, never timing).
  expect(await statuses(api, '/e2e/ok/item', 10)).toEqual(Array(10).fill(200));
  expect(await statuses(api, '/e2e/limited/item', 5)).toEqual([200, 200, 200, 429, 429]);
  const cached = [];
  for (let i = 0; i < 5; i++)
    cached.push((await get(api, '/e2e/cached/item')).headers()['x-cache']);
  expect(cached).toEqual(['MISS', 'HIT', 'HIT', 'HIT', 'HIT']);
  // Two failed attempts open the breaker (failureThreshold 2); the third is rejected without an attempt.
  expect(await statuses(api, '/e2e/faulty/item?_reset=1', 3)).toEqual([502, 502, 503]);

  // F1 timeout: the upstream needs 1,500 ms, the route allows 500 ms.
  const slow = [];
  for (let i = 0; i < 3; i++) slow.push(await get(api, '/e2e/slow/item?_delay=1500'));
  expect(slow.map((r) => r.status())).toEqual([504, 504, 504]);
  const [firstSlow] = slow;
  if (firstSlow === undefined) throw new Error('no F1 response');
  expect(await errorCode(firstSlow)).toBe('UPSTREAM_TIMEOUT');

  // F2 retry then success: two 503s, then 200, within maxAttempts 3.
  expect((await get(api, `/e2e/retry/item?_failTimes=2&_key=${RUN}-f2`)).status()).toBe(200);
  // F3 retries exhausted: the third attempt's real 503 passes through.
  const exhausted = await get(api, `/e2e/retry/item?_failTimes=5&_key=${RUN}-f3`);
  expect(exhausted.status()).toBe(503);
  expect(await errorCode(exhausted)).toBeUndefined();

  // F4 breaker opens: two connection failures, then CIRCUIT_OPEN without calling the upstream.
  expect(await statuses(api, '/e2e/recover/item?_reset=1', 2)).toEqual([502, 502]);
  const open = await get(api, '/e2e/recover/item');
  expect(open.status()).toBe(503);
  expect(await errorCode(open)).toBe('CIRCUIT_OPEN');
  expect(open.headers()['retry-after']).toBeDefined();
  const upstreams = (await admin('upstreams'))['upstreams'] as BreakerView[];
  expect(upstreams.find((u) => u.id === 'recover-service')?.breaker.state).toBe('open');

  // F6 isolation: other upstreams keep working while recover-service is open.
  expect((await get(api, '/e2e/ok/item')).status()).toBe(200);

  // F5 recovery: after openDurationMs (3 s) one half-open probe succeeds and closes the breaker. Polled with
  // healthy requests (each counted), never a fixed sleep.
  await expect
    .poll(async () => (await get(api, '/e2e/recover/item')).status(), {
      intervals: [250],
      timeout: 10_000,
    })
    .toBe(200);
  const recovered = (await admin('upstreams'))['upstreams'] as BreakerView[];
  expect(recovered.find((u) => u.id === 'recover-service')?.breaker).toMatchObject({
    state: 'closed',
    consecutiveFailures: 0,
  });
  await api.dispose();
});

/** Any CSP violation in the page is recorded, so a test can assert there were none. */
async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (event: SecurityPolicyViolationEvent) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  return async () => [
    ...(await page.evaluate(
      () => (window as unknown as { cspViolations: string[] }).cspViolations,
    )),
    ...consoleErrors,
  ];
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/admin/ui/');
  await page.getByLabel('Admin token').fill(TOKEN);
  await page.getByRole('button', { name: 'Open dashboard' }).click();
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
}

async function apiJson(page: Page, path: string): Promise<Record<string, unknown>> {
  const response = await page.request.get(`/admin/api/${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function openScreen(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Screens' }).getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  // Read after a fresh poll, not a cached render.
  await page.getByTestId('refresh-now').click();
}

test('a wrong token stays at the gate', async ({ page }) => {
  await page.goto('/admin/ui/');
  await page.getByLabel('Admin token').fill('x'.repeat(40));
  await page.getByRole('button', { name: 'Open dashboard' }).click();
  await expect(page.getByRole('alert')).toContainText('This token was rejected');
  await expect(page.getByLabel('Admin token')).toBeVisible();
});

test('every screen shows the numbers implied by the traffic, matching the API, with no CSP violations', async ({
  page,
}) => {
  const problems = await watchCsp(page);
  const response = await page.goto('/admin/ui/');
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  await signIn(page);

  // Overview: every request the tests sent (plan §7 traffic + F1-F6, including F5's polls).
  const stats = (await apiJson(page, 'stats')) as {
    total: { window: { counters: { requests: number } } };
    routes: {
      id: string;
      series: {
        window: {
          counters: { attempts: { success: number; failure: number }; retries: number };
          rates: { retryRate: number | null };
          latency: { p50: { value: number | null; observations: number } };
        };
      };
    }[];
  };
  expect(stats.total.window.counters.requests).toBe(sent);
  await expect(page.getByTestId('kpi-requests')).toHaveText(sent.toLocaleString('en-US'));

  // F1: latency buckets reflect the 500 ms timeout, not the 1,500 ms upstream delay.
  const slowLatency = stats.routes.find((r) => r.id === 'e2e-slow')?.series.window.latency.p50;
  expect(slowLatency?.observations).toBe(3);
  expect(slowLatency?.value).toBeGreaterThanOrEqual(500);
  expect(slowLatency?.value).toBeLessThan(1000);
  // F2 + F3: 6 attempts (1 success, 5 failures) and 4 retries for 2 requests.
  const retry = stats.routes.find((r) => r.id === 'e2e-retry')?.series.window;
  expect(retry?.counters.attempts).toMatchObject({ success: 1, failure: 5 });
  expect(retry?.counters.retries).toBe(4);
  expect(retry?.rates.retryRate).toBe(2);

  await openScreen(page, 'Routes');
  await expect(page.getByTestId('route-requests-e2e-ok')).toHaveText('11'); // 10 + the F6 isolation check
  await expect(page.getByTestId('route-errors-e2e-slow')).toHaveText('100 %');
  await page.getByRole('button', { name: 'e2e-retry' }).click();
  await expect(page.getByTestId('route-detail')).toContainText('2.00 / req now');
  await expect(page.getByTestId('route-rejected-e2e-limited')).toHaveText('40 %');
  await expect(page.getByTestId('route-cache-e2e-cached')).toHaveText('80 %');
  await expect(page.getByTestId('route-errors-e2e-faulty')).toHaveText('100 %');

  await openScreen(page, 'Cache');
  await expect(page.getByTestId('cache-hit-ratio-e2e-cached')).toHaveText('80 %');
  const cache = (await apiJson(page, 'cache')) as {
    routes: { id: string; series: { window: { rates: { cacheHitRatio: number } } } }[];
  };
  expect(cache.routes.find((r) => r.id === 'e2e-cached')?.series.window.rates.cacheHitRatio).toBe(
    0.8,
  );
  await expect(page.getByTestId('cache-entries')).toContainText('1 of 10,000');

  await openScreen(page, 'Rate limits');
  await expect(page.getByTestId('rejection-rate-e2e-limited')).toHaveText('40 %');
  await expect(page.getByTestId('rejection-rate-e2e-ok')).toHaveText('0 %');

  await openScreen(page, 'Upstreams');
  const breaker = page.getByTestId('breaker-faulty-service');
  await expect(breaker).toHaveAttribute('data-state', 'open');
  await expect(breaker).toContainText('Open');
  await expect(page.getByTestId('breaker-orders-service')).toHaveAttribute('data-state', 'closed');
  await expect(page.getByTestId('upstream-failure-rate-faulty-service')).toHaveText('100 %');
  // F1, F2/F3 and F4/F5 on the Upstreams screen.
  await expect(page.getByTestId('upstream-failure-rate-slow-service')).toHaveText('100 %');
  await expect(page.getByTestId('upstream-failure-rate-retry-service')).toHaveText('83 %'); // 5 of 6
  const recover = page.getByTestId('breaker-recover-service');
  await expect(recover).toHaveAttribute('data-state', 'closed');
  await expect(page.getByTestId('upstream-failure-rate-recover-service')).toHaveText('67 %'); // 2 failures, 1 probe

  // Every screen rendered charts under the strict CSP.
  expect(await problems()).toEqual([]);
});

test('reload keeps the screen and the session; a revoked token returns to the gate', async ({
  page,
}) => {
  await signIn(page);
  await openScreen(page, 'Cache');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Cache', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/ui\/cache$/);

  await page.evaluate(() => {
    window.sessionStorage.setItem('pulsegate.adminToken', 'y'.repeat(40));
  });
  await page.reload();
  await expect(page.getByText('The admin token is no longer accepted')).toBeVisible();
  await expect(page.getByLabel('Admin token')).toBeVisible();
});

test('nothing administrative is served on the public port', async ({ request }) => {
  for (const path of ['/admin/api/stats', '/admin/ui/']) {
    const response = await request.get(`${PUBLIC}${path}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status(), path).toBe(404);
  }
});

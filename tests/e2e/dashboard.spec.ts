import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Exit criterion (plan §7): the dashboard shows exactly the numbers implied by traffic the test sends itself, and
 * the same numbers the admin API reports. Runs against a fresh stack from scripts/e2e.sh (config/routes.e2e.yaml).
 */
const PUBLIC = process.env['E2E_PUBLIC_URL'] ?? 'http://127.0.0.1:8080';
const TOKEN = process.env['E2E_ADMIN_TOKEN'] ?? 'pulsegate-e2e-admin-token-not-a-secret';

test.describe.configure({ mode: 'serial' });

async function statuses(api: APIRequestContext, path: string, times: number): Promise<number[]> {
  const result: number[] = [];
  for (let i = 0; i < times; i++) result.push((await api.get(`${PUBLIC}${path}`)).status());
  return result;
}

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext();
  // Known traffic, sequential and explicit (faults via _reset, never timing).
  expect(await statuses(api, '/e2e/ok/item', 10)).toEqual(Array(10).fill(200));
  expect(await statuses(api, '/e2e/limited/item', 5)).toEqual([200, 200, 200, 429, 429]);
  const cached = [];
  for (let i = 0; i < 5; i++)
    cached.push((await api.get(`${PUBLIC}/e2e/cached/item`)).headers()['x-cache']);
  expect(cached).toEqual(['MISS', 'HIT', 'HIT', 'HIT', 'HIT']);
  // Two failed attempts open the breaker (failureThreshold 2); the third is rejected without an attempt.
  expect(await statuses(api, '/e2e/faulty/item?_reset=1', 3)).toEqual([502, 502, 503]);
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

  // Overview: 10 + 5 + 5 + 3 completed requests.
  const stats = (await apiJson(page, 'stats')) as {
    total: { window: { counters: { requests: number } } };
  };
  expect(stats.total.window.counters.requests).toBe(23);
  await expect(page.getByTestId('kpi-requests')).toHaveText('23');

  await openScreen(page, 'Routes');
  await expect(page.getByTestId('route-requests-e2e-ok')).toHaveText('10');
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

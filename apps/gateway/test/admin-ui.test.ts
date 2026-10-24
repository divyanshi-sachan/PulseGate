import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createGateway, GatewayStartupError, type GatewayOptions } from '../src/index.ts';
import { captureLogs, configFor, freePort, jsonBody, send, startUpstream } from './harness.ts';

const TOKEN = 'b'.repeat(32);
const SECRET = 'TOP-SECRET-OUTSIDE-THE-BUILD';
const INDEX =
  '<!doctype html><title>PulseGate</title><script type="module" src="/admin/ui/assets/app-3f9a.js"></script>';
const SCRIPT = 'console.log("dashboard");';

let base: string;
let root: string;
let outside: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'pulsegate-ui-'));
  root = join(base, 'dist');
  outside = join(base, 'outside.txt');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), INDEX);
  await writeFile(join(root, 'assets', 'app-3f9a.js'), SCRIPT);
  await writeFile(join(root, 'assets', 'app-3f9a.css'), 'body{}');
  await writeFile(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  // Things a build directory must never leak.
  await writeFile(join(root, '.env'), SECRET);
  await writeFile(join(root, 'config.yaml'), SECRET);
  await writeFile(outside, SECRET);
  await symlink(outside, join(root, 'leak.txt'));
  await symlink(base, join(root, 'parent'));
  return () => rm(base, { recursive: true, force: true });
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(options: Partial<GatewayOptions> = {}) {
  const upstream = await startUpstream();
  cleanups.push(() => upstream.close());
  const gateway = createGateway(configFor(upstream.url), {
    logger: false,
    adminToken: TOKEN,
    adminUiDir: root,
    ...options,
  });
  cleanups.push(() => gateway.close());
  if (gateway.admin === undefined) throw new Error('admin listener expected');
  await gateway.admin.listen({ host: '127.0.0.1', port: 0 });
  return { gateway, port: (gateway.admin.server.address() as AddressInfo).port };
}

const STRICT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

describe('admin UI static files (ADR-0037, plan §5)', () => {
  it('serves index.html without a token, with the strict CSP and revalidation', async () => {
    const { port } = await setup();
    const response = await send(port, { path: '/admin/ui/' });
    expect(response.status).toBe(200);
    expect(response.body).toBe(INDEX);
    expect(response.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(INDEX)),
      'cache-control': 'no-cache',
      'content-security-policy': STRICT_CSP,
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
    });
  });

  it('redirects /admin/ui to /admin/ui/', async () => {
    const { port } = await setup();
    const response = await send(port, { path: '/admin/ui' });
    expect(response.status).toBe(308);
    expect(response.headers.location).toBe('/admin/ui/');
  });

  it('caches hashed assets forever with the right content types', async () => {
    const { port } = await setup();
    const script = await send(port, { path: '/admin/ui/assets/app-3f9a.js?v=1' });
    expect(script.status).toBe(200);
    expect(script.body).toBe(SCRIPT);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const style = await send(port, { path: '/admin/ui/assets/app-3f9a.css' });
    expect(style.headers['content-type']).toBe('text/css; charset=utf-8');
    // Outside assets/ nothing is immutable.
    const icon = await send(port, { path: '/admin/ui/favicon.svg' });
    expect(icon.headers).toMatchObject({
      'content-type': 'image/svg+xml',
      'cache-control': 'no-cache',
    });
  });

  it('answers HEAD with headers only', async () => {
    const { port } = await setup();
    const response = await send(port, { method: 'HEAD', path: '/admin/ui/assets/app-3f9a.js' });
    expect(response.status).toBe(200);
    expect(response.body).toBe('');
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength(SCRIPT)));
  });

  it('falls back to index.html for client-side routes, but 404s a missing asset', async () => {
    const { port } = await setup();
    const route = await send(port, { path: '/admin/ui/routes/orders' });
    expect(route.status).toBe(200);
    expect(route.body).toBe(INDEX);
    const missing = await send(port, { path: '/admin/ui/assets/missing-0000.js' });
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toMatch(/^application\/json/);
    expect(missing.headers['cache-control']).toBe('no-store');
    expect((jsonBody(missing) as { error: { code: string } }).error.code).toBe('ROUTE_NOT_FOUND');
  });

  const attacks = [
    '/admin/ui/../api/stats',
    '/admin/ui/../../outside.txt',
    '/admin/ui/%2e%2e/outside.txt',
    '/admin/ui/%2E%2E/%2E%2E/outside.txt',
    '/admin/ui/.%2e/outside.txt',
    '/admin/ui/..%2foutside.txt',
    '/admin/ui/..%2Foutside.txt',
    '/admin/ui/..%5coutside.txt',
    '/admin/ui/..\\outside.txt',
    '/admin/ui/%252e%252e/outside.txt',
    '/admin/ui//etc/passwd',
    '/admin/ui/%2Fetc%2Fpasswd',
    '/admin/ui/assets/%00.js',
    '/admin/ui/%zz.js',
    '/admin/ui/.env',
    '/admin/ui/%2eenv',
    '/admin/ui/config.yaml',
    '/admin/ui/leak.txt',
    '/admin/ui/parent/outside.txt',
  ];

  it.each(attacks)('never serves anything outside the allow-list for %s', async (path) => {
    const { port } = await setup();
    const response = await send(port, { path });
    expect([400, 404]).toContain(response.status);
    expect(response.body).not.toContain(SECRET);
    expect(response.body).not.toContain('"total"');
    expect(response.headers['content-type']).toMatch(/^application\/json/);
  });

  it('the absolute path of a file outside the build is rejected', async () => {
    const { port } = await setup();
    const response = await send(port, { path: `/admin/ui/${encodeURIComponent(outside)}` });
    expect(response.status).toBe(400);
    expect(response.body).not.toContain(SECRET);
  });

  it('does not let a UI path reach the API without a token', async () => {
    const { port } = await setup();
    for (const path of ['/admin/ui/../api/stats', '/admin/ui/%2e%2e/api/stats']) {
      const response = await send(port, { path });
      expect(response.status).toBe(400);
    }
    expect((await send(port, { path: '/admin/api/stats' })).status).toBe(401);
  });

  it('only GET and HEAD are public; other methods on UI paths need the token', async () => {
    const { port } = await setup();
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await send(port, { method, path: '/admin/ui/' })).status).toBe(401);
    }
  });

  it('keeps the API headers on API responses', async () => {
    const { port } = await setup();
    const response = await send(port, {
      path: '/admin/api/stats',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it('is 404 when no UI directory is configured', async () => {
    const { port } = await setup({ adminUiDir: '' });
    const response = await send(port, { path: '/admin/ui/' });
    expect(response.status).toBe(404);
    expect(response.headers['content-security-policy']).toBe(STRICT_CSP);
  });
});

describe('admin UI startup checks', () => {
  async function startWith(adminUiDir: string | undefined) {
    const upstream = await startUpstream();
    cleanups.push(() => upstream.close());
    const ports = [await freePort(), await freePort(), await freePort()] as const;
    const logs = captureLogs();
    const gateway = createGateway(
      configFor(upstream.url, [{}], {
        server: { host: '127.0.0.1', port: ports[0] },
        operations: { port: ports[1] },
        admin: { port: ports[2] },
      }),
      {
        ...logs.options,
        adminToken: TOKEN,
        ...(adminUiDir === undefined ? {} : { adminUiDir }),
      },
    );
    cleanups.push(() => gateway.close());
    return { gateway, logs, adminPort: ports[2] };
  }

  it('fails startup when the configured directory has no index.html', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'pulsegate-empty-'));
    cleanups.push(() => rm(empty, { recursive: true, force: true }));
    const { gateway } = await startWith(empty);
    await expect(gateway.start()).rejects.toBeInstanceOf(GatewayStartupError);
    const missing = await startWith(join(empty, 'nope'));
    await expect(missing.gateway.start()).rejects.toBeInstanceOf(GatewayStartupError);
  });

  it('logs that the UI is not served when no directory is set, and still serves the API', async () => {
    const { gateway, logs, adminPort } = await startWith(undefined);
    await gateway.start();
    expect(logs.lines().map((line) => line['msg'])).toContain(
      'admin UI not served: PULSEGATE_ADMIN_UI_DIR is not set (ADR-0037)',
    );
    const response = await send(adminPort, {
      path: '/admin/api/stats',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
  });

  it('serves the UI after a normal start', async () => {
    const { gateway, adminPort } = await startWith(root);
    await gateway.start();
    expect((await send(adminPort, { path: '/admin/ui/' })).body).toBe(INDEX);
  });
});

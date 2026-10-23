import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockServer, type MockOptions } from './index.ts';

let server: Server | undefined;
afterEach(async () => {
  if (server === undefined) return;
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
  server = undefined;
});

async function start(options: Partial<MockOptions> = {}): Promise<string> {
  server = createMockServer({ name: 'orders', ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

describe('mock upstream', () => {
  it('echoes the raw URL, method, headers and body', async () => {
    const base = await start();
    const response = await fetch(`${base}/api/orders/1?x=1&x=2`, {
      method: 'POST',
      headers: { 'x-test': 'yes' },
      body: 'hello',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: 'orders',
      method: 'POST',
      url: '/api/orders/1?x=1&x=2',
      headers: { 'x-test': 'yes' },
      body: 'hello',
      bodyBytes: 5,
    });
  });

  it('serves a health probe', async () => {
    const base = await start();
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({
      status: 'ok',
      service: 'orders',
    });
  });

  it('responds with the requested status', async () => {
    const base = await start();
    expect((await fetch(`${base}/x?_status=503`)).status).toBe(503);
  });

  it('ignores out-of-range parameters', async () => {
    const base = await start();
    expect((await fetch(`${base}/x?_status=999&_delay=-5`)).status).toBe(200);
  });

  it('delays the response', async () => {
    const base = await start();
    const started = performance.now();
    await fetch(`${base}/x?_delay=80`);
    expect(performance.now() - started).toBeGreaterThanOrEqual(75);
  });

  it('fails at the configured rate', async () => {
    const base = await start({ random: () => 0.2 });
    expect((await fetch(`${base}/x?_failRate=0.5`)).status).toBe(503);
    expect((await fetch(`${base}/x?_failRate=0.1`)).status).toBe(200);
  });

  it('resets the connection', async () => {
    const base = await start();
    await expect(fetch(`${base}/x?_reset=1`)).rejects.toThrow();
  });

  it('streams the requested number of bytes, with or without Content-Length', async () => {
    const base = await start();
    const chunked = await fetch(`${base}/x?_bytes=40000`);
    expect(chunked.headers.get('content-length')).toBeNull();
    expect((await chunked.arrayBuffer()).byteLength).toBe(40_000);

    const sized = await fetch(`${base}/x?_bytes=100&_contentLength=1`);
    expect(sized.headers.get('content-length')).toBe('100');
    expect((await sized.text()).length).toBe(100);
  });
});

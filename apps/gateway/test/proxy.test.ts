import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureLogs,
  configFor,
  jsonBody,
  send,
  startGateway,
  startUpstream,
  type MockUpstream,
  type RunningGateway,
} from './harness.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(
  options: {
    handler?: Parameters<typeof startUpstream>[0];
    basePath?: string;
    routes?: Parameters<typeof configFor>[1];
    extra?: Record<string, unknown>;
  } = {},
): Promise<{ upstream: MockUpstream; gw: RunningGateway }> {
  const upstream = await startUpstream(options.handler);
  cleanups.push(() => upstream.close());
  const gw = await startGateway(
    configFor(`${upstream.url}${options.basePath ?? ''}`, options.routes, options.extra),
  );
  cleanups.push(() => gw.close());
  return { upstream, gw };
}

function expectGatewayError(
  response: { status: number; body: string; headers: Record<string, unknown> },
  status: number,
  code: string,
) {
  expect(response.status).toBe(status);
  const body = jsonBody(response as never) as { error: { code: string; requestId: string } };
  expect(body.error.code).toBe(code);
  expect(body.error.requestId).toBe(response.headers['x-request-id']);
}

describe('forwarding (ADR-0013, ADR-0019)', () => {
  it('forwards the raw path and query byte-for-byte and passes the response through', async () => {
    const { upstream, gw } = await setup({
      handler: (_req, res) => {
        res.statusCode = 201;
        res.setHeader('x-upstream', 'yes');
        res.setHeader('set-cookie', ['a=1', 'b=2']);
        res.end('created');
      },
    });
    const response = await send(gw.port, { path: '/api/orders//a%2Fb/?x=1&x=2&y=%20' });

    expect(response.status).toBe(201);
    expect(response.body).toBe('created');
    expect(response.headers['x-upstream']).toBe('yes');
    expect(response.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(upstream.requests[0]?.url).toBe('/api/orders//a%2Fb/?x=1&x=2&y=%20');
  });

  it('joins the upstream base path and honors stripPrefix', async () => {
    const { upstream, gw } = await setup({
      basePath: '/v1/',
      routes: [{}, { id: 'stripped', pathPrefix: '/api/items', stripPrefix: true }],
    });
    await send(gw.port, { path: '/api/orders/123' });
    await send(gw.port, { path: '/api/items/9?q=1' });
    await send(gw.port, { path: '/api/items?' });
    expect(upstream.requests.map((r) => r.url)).toEqual([
      '/v1/api/orders/123',
      '/v1/9?q=1',
      '/v1/',
    ]);
  });

  it('streams request bodies to the upstream', async () => {
    const { upstream, gw } = await setup({ routes: [{ methods: ['POST'] }] });
    function* chunks() {
      yield Buffer.from('{"items":');
      yield Buffer.from('[1,2,3]}');
    }
    const response = await send(gw.port, {
      method: 'POST',
      path: '/api/orders',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      body: chunks(),
    });
    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.body).toBe('{"items":[1,2,3]}');
    expect(upstream.requests[0]?.headers['content-type']).toBe('application/json');
  });

  it('passes upstream 4xx responses through unchanged', async () => {
    const { gw } = await setup({
      handler: (_req, res) => {
        res.statusCode = 404;
        res.end('no such order');
      },
    });
    const response = await send(gw.port, { path: '/api/orders/999' });
    expect(response.status).toBe(404);
    expect(response.body).toBe('no such order');
  });
});

describe('request logging (ADR-0028)', () => {
  it('writes exactly one info line per successful request and no warnings', async () => {
    const upstream = await startUpstream();
    cleanups.push(() => upstream.close());
    const logs = captureLogs();
    const gw = await startGateway(configFor(upstream.url), logs.options);
    cleanups.push(() => gw.close());

    await send(gw.port, {
      path: '/api/orders/1?token=secret-query',
      headers: { 'x-api-key': 'pk_secret' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const lines = logs.lines().filter((line) => line['requestId'] !== undefined);
    expect(lines.map((line) => line['msg'])).toEqual(['request completed']);
    expect(lines[0]).toMatchObject({
      level: 30,
      routeId: 'route-0',
      path: '/api/orders/1',
      statusCode: 200,
    });
    expect(lines[0]?.['errorCode']).toBeUndefined();
    const all = JSON.stringify(logs.lines());
    expect(all).not.toContain('pk_secret');
    expect(all).not.toContain('secret-query');
  });

  it('logs a mid-stream abort with its error code', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.write(Buffer.alloc(48 * 1024, 'x'));
      res.end(Buffer.alloc(48 * 1024, 'x'));
    });
    cleanups.push(() => upstream.close());
    const logs = captureLogs();
    const gw = await startGateway(
      configFor(upstream.url, [{}], { server: { limits: { maxResponseBodyBytes: 64 * 1024 } } }),
      logs.options,
    );
    cleanups.push(() => gw.close());

    await send(gw.port, { path: '/api/orders' }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(logs.lines()).toContainEqual(
      expect.objectContaining({
        msg: 'response aborted mid-stream',
        errorCode: 'UPSTREAM_RESPONSE_TOO_LARGE',
      }),
    );
  });
});

describe('request IDs (ADR-0027)', () => {
  it('generates its own ID, ignores the client value and sends it upstream and back', async () => {
    const { upstream, gw } = await setup();
    const response = await send(gw.port, {
      path: '/api/orders',
      headers: { 'x-request-id': 'client-chosen' },
    });
    const id = response.headers['x-request-id'];
    expect(id).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(upstream.requests[0]?.headers['x-request-id']).toBe(id);
  });
});

describe('gateway-decided errors never reach the upstream (ADR-0017, ADR-0018)', () => {
  it('returns 404 ROUTE_NOT_FOUND for unknown paths', async () => {
    const { upstream, gw } = await setup();
    expectGatewayError(await send(gw.port, { path: '/api/payments' }), 404, 'ROUTE_NOT_FOUND');
    expect(upstream.requests).toHaveLength(0);
  });

  it('returns 405 with an Allow header for a known path and wrong method', async () => {
    const { upstream, gw } = await setup({ routes: [{}, { id: 'create', methods: ['POST'] }] });
    const response = await send(gw.port, { method: 'DELETE', path: '/api/orders/1' });
    expectGatewayError(response, 405, 'METHOD_NOT_ALLOWED');
    expect(response.headers.allow).toBe('GET, POST');
    expect(upstream.requests).toHaveLength(0);
  });

  it.each(['/api/orders/../payments', '/api/orders/%2e%2e/payments', '/api/orders/%zz'])(
    'returns 400 BAD_REQUEST for %s',
    async (path) => {
      const { upstream, gw } = await setup({ routes: [{ pathPrefix: '/' }] });
      expectGatewayError(await send(gw.port, { path }), 400, 'BAD_REQUEST');
      expect(upstream.requests).toHaveLength(0);
    },
  );

  it('returns 413 when Content-Length exceeds the request limit', async () => {
    const { upstream, gw } = await setup({
      routes: [{ methods: ['POST'] }],
      extra: { server: { limits: { maxRequestBodyBytes: 10 } } },
    });
    const response = await send(gw.port, {
      method: 'POST',
      path: '/api/orders',
      body: 'x'.repeat(11),
    });
    expectGatewayError(response, 413, 'PAYLOAD_TOO_LARGE');
    expect(upstream.requests).toHaveLength(0);
  });

  it('returns 413 when a chunked body grows past the limit', async () => {
    const { gw } = await setup({
      routes: [{ methods: ['POST'] }],
      extra: { server: { limits: { maxRequestBodyBytes: 10 } } },
    });
    function* chunks() {
      yield Buffer.from('x'.repeat(8));
      yield Buffer.from('x'.repeat(8));
    }
    const response = await send(gw.port, {
      method: 'POST',
      path: '/api/orders',
      headers: { 'transfer-encoding': 'chunked' },
      body: chunks(),
    });
    expectGatewayError(response, 413, 'PAYLOAD_TOO_LARGE');
  });
});

describe('header forwarding (ADR-0021)', () => {
  it('strips credentials, hop-by-hop and spoofed forwarding headers by default', async () => {
    const { upstream, gw } = await setup();
    await send(gw.port, {
      path: '/api/orders',
      headers: {
        'x-api-key': 'pk_secret',
        authorization: 'Bearer token',
        connection: 'x-hop',
        'x-hop': 'secret',
        'x-forwarded-for': '6.6.6.6',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        accept: 'text/plain',
      },
    });
    const headers = upstream.requests[0]?.headers ?? {};
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-hop']).toBeUndefined();
    expect(headers['x-forwarded-host']).toBeUndefined();
    expect(headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(headers['x-forwarded-proto']).toBe('http');
    expect(headers.accept).toBe('text/plain');
    expect(headers.host).toBe(new URL(upstream.url).host);
  });

  it('enables Authorization and X-Forwarded-Host forwarding only on the opted-in route', async () => {
    const { upstream, gw } = await setup({
      routes: [
        { id: 'plain' },
        {
          id: 'opted-in',
          pathPrefix: '/api/secure',
          forwarding: { authorization: true, forwardedHost: true },
        },
      ],
    });
    const headers = { authorization: 'Bearer token', host: 'gw.example:8080' };
    await send(gw.port, { path: '/api/orders', headers });
    await send(gw.port, { path: '/api/secure', headers });
    const [plain, optedIn] = upstream.requests;
    expect(plain?.headers.authorization).toBeUndefined();
    expect(plain?.headers['x-forwarded-host']).toBeUndefined();
    expect(optedIn?.headers.authorization).toBe('Bearer token');
    expect(optedIn?.headers['x-forwarded-host']).toBe('gw.example:8080');
  });

  it('extends X-Forwarded-For from a trusted proxy', async () => {
    const { upstream, gw } = await setup({ extra: { server: { trustedProxies: ['127.0.0.1'] } } });
    await send(gw.port, { path: '/api/orders', headers: { 'x-forwarded-for': '203.0.113.7' } });
    expect(upstream.requests[0]?.headers['x-forwarded-for']).toBe('203.0.113.7, 127.0.0.1');
  });

  it('strips hop-by-hop headers from upstream responses', async () => {
    const { gw } = await setup({
      handler: (_req, res) => {
        res.setHeader('connection', 'x-internal');
        res.setHeader('x-internal', 'leak');
        res.setHeader('x-public', 'ok');
        res.end('done');
      },
    });
    const response = await send(gw.port, { path: '/api/orders' });
    expect(response.headers['x-internal']).toBeUndefined();
    expect(response.headers['x-public']).toBe('ok');
  });
});

describe('upstream failures (ADR-0011, ADR-0018)', () => {
  it('returns 504 UPSTREAM_TIMEOUT when the upstream misses the deadline', async () => {
    const { gw } = await setup({
      routes: [{ timeoutMs: 100 }],
      handler: (_req, res) => setTimeout(() => res.end('late'), 1000),
    });
    expectGatewayError(await send(gw.port, { path: '/api/orders' }), 504, 'UPSTREAM_TIMEOUT');
  });

  it('returns 502 UPSTREAM_UNAVAILABLE when the upstream refuses connections', async () => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address() as AddressInfo;
    probe.close();
    await once(probe, 'close');

    const gw = await startGateway(configFor(`http://127.0.0.1:${String(port)}`));
    cleanups.push(() => gw.close());
    expectGatewayError(await send(gw.port, { path: '/api/orders' }), 502, 'UPSTREAM_UNAVAILABLE');
  });

  it('returns 502 UPSTREAM_RESPONSE_TOO_LARGE when Content-Length exceeds the limit', async () => {
    const { gw } = await setup({
      extra: { server: { limits: { maxResponseBodyBytes: 16 } } },
      handler: (_req, res) => res.end('x'.repeat(17)),
    });
    expectGatewayError(
      await send(gw.port, { path: '/api/orders' }),
      502,
      'UPSTREAM_RESPONSE_TOO_LARGE',
    );
  });

  it('aborts the client connection when a streamed body crosses the limit', async () => {
    let upstreamWrites = 0;
    const { gw } = await setup({
      extra: { server: { limits: { maxResponseBodyBytes: 64 * 1024 } } },
      handler: (_req, res) => {
        const chunk = Buffer.alloc(16 * 1024, 'x');
        const pump = () => {
          while (upstreamWrites < 1000) {
            upstreamWrites++;
            if (!res.write(chunk)) {
              res.once('drain', pump);
              return;
            }
          }
          res.end();
        };
        res.on('error', () => undefined);
        pump();
      },
    });
    // Headers are already sent when the limit is crossed, so the client sees a 200 whose body is cut off.
    const outcome = await new Promise<{ status: number; received: number; complete: boolean }>(
      (resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1',
          port: gw.port,
          path: '/api/orders',
          agent: false,
        });
        req.on('error', reject);
        req.on('response', (res) => {
          let received = 0;
          res.on('data', (chunk: Buffer) => (received += chunk.length));
          res.on('error', () => undefined);
          res.on('close', () => {
            resolve({ status: res.statusCode ?? 0, received, complete: res.complete });
          });
        });
        req.end();
      },
    );
    expect(outcome.status).toBe(200);
    expect(outcome.complete).toBe(false);
    expect(outcome.received).toBeLessThanOrEqual(64 * 1024);
    // The upstream read was stopped well before the upstream finished writing 16 MB.
    expect(upstreamWrites).toBeLessThan(1000);
  });

  it('serves a chunked response that stays within the limit in full', async () => {
    const { gw } = await setup({
      extra: { server: { limits: { maxResponseBodyBytes: 64 * 1024 } } },
      handler: (_req, res) => {
        res.write(Buffer.alloc(32 * 1024, 'x'));
        res.end(Buffer.alloc(32 * 1024, 'x'));
      },
    });
    const response = await send(gw.port, { path: '/api/orders' });
    expect(response.status).toBe(200);
    expect(response.body.length).toBe(64 * 1024);
  });
});

describe('protocol upgrades (ADR-0023)', () => {
  it('rejects WebSocket upgrades with 400 and never switches protocols', async () => {
    const { upstream, gw } = await setup();
    const req = httpRequest({
      host: '127.0.0.1',
      port: gw.port,
      path: '/api/orders',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    req.on('upgrade', () => {
      throw new Error('connection was upgraded');
    });
    req.end();
    const [res] = (await once(req, 'response')) as [import('node:http').IncomingMessage];
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk as Buffer);
    expect(res.statusCode).toBe(400);
    expect(res.headers.connection).toBe('close');
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toMatchObject({
      error: { code: 'BAD_REQUEST', message: 'Protocol upgrade not supported' },
    });
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects CONNECT with 400', async () => {
    const { gw } = await setup();
    const socket = connect(gw.port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
    const chunks: Buffer[] = [];
    for await (const chunk of socket) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    expect(raw.startsWith('HTTP/1.1 400 Bad Request')).toBe(true);
    expect(raw).toContain('"code":"BAD_REQUEST"');
  });
});

describe('listeners (ADR-0022)', () => {
  it('serves health and readiness on the operations listener, not the public one', async () => {
    const { gw } = await setup();
    const ops = gw.gateway.operations;
    expect((await ops.inject({ url: '/health' })).json()).toEqual({ status: 'ok' });
    expect((await ops.inject({ url: '/ready' })).statusCode).toBe(503);
    expectGatewayError(await send(gw.port, { path: '/health' }), 404, 'ROUTE_NOT_FOUND');
  });
});

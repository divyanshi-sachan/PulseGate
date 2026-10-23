import { once } from 'node:events';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseConfig, type GatewayConfig } from '@pulsegate/config';
import { createGateway, type Gateway, type GatewayOptions } from '../src/index.ts';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface MockUpstream {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

type UpstreamHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

/** A real HTTP server that records every request it receives. */
export async function startUpstream(
  handler: UpstreamHandler = (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  },
): Promise<MockUpstream> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

export interface RouteDef {
  id?: string;
  pathPrefix?: string;
  methods?: string[];
  [key: string]: unknown;
}

/** Validated config with one upstream and the given routes (defaults: GET /api/orders). */
export function configFor(
  baseUrl: string,
  routes: RouteDef[] = [{}],
  extra: Record<string, unknown> = {},
) {
  return parseConfig({
    upstreams: [{ id: 'orders-service', baseUrl }],
    routes: routes.map((route, i) => ({
      id: `route-${String(i)}`,
      pathPrefix: '/api/orders',
      methods: ['GET'],
      upstreamId: 'orders-service',
      rateLimit: { capacity: 1000, refillRatePerSecond: 1000 },
      // Proxy tests focus on forwarding; auth tests opt in with auth: { required: true }.
      auth: { required: false },
      ...route,
    })),
    ...extra,
  });
}

export interface RunningGateway {
  gateway: Gateway;
  port: number;
  close(): Promise<void>;
}

/** Starts only the public listener on an ephemeral port. */
export async function startGateway(
  config: GatewayConfig,
  options: GatewayOptions = { logger: false },
): Promise<RunningGateway> {
  const gateway = createGateway(config, options);
  await gateway.public.listen({ host: '127.0.0.1', port: 0 });
  const { port } = gateway.public.server.address() as AddressInfo;
  return {
    gateway,
    port,
    close: async () => {
      await gateway.close();
    },
  };
}

/** Returns a port that was free a moment ago (for tests that must use gateway.start()). */
export async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, 'close');
  return port;
}

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface RawRequest {
  method?: string;
  /** Sent verbatim on the request line, never normalized. */
  path: string;
  headers?: OutgoingHttpHeaders;
  body?: string | Buffer | Iterable<Buffer> | AsyncIterable<Buffer>;
}

/** Sends a request with an exact request-target using node:http. */
export async function send(port: number, options: RawRequest): Promise<RawResponse> {
  const req = httpRequest({
    host: '127.0.0.1',
    port,
    method: options.method ?? 'GET',
    path: options.path,
    headers: options.headers,
    agent: false,
  });
  const responsePromise = once(req, 'response') as Promise<[IncomingMessage]>;
  const { body } = options;
  if (body === undefined) req.end();
  else if (typeof body === 'string' || Buffer.isBuffer(body)) req.end(body);
  else {
    for await (const chunk of body) {
      if (!req.write(chunk)) await once(req, 'drain');
    }
    req.end();
  }
  const [res] = await responsePromise;
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return {
    status: res.statusCode ?? 0,
    headers: res.headers,
    body: Buffer.concat(chunks).toString('utf8'),
  };
}

export function jsonBody(response: RawResponse): unknown {
  return JSON.parse(response.body);
}

/** Logger options that capture pino JSON lines in memory, for asserting on real log output. */
export function captureLogs(): { options: GatewayOptions; lines: () => Record<string, unknown>[] } {
  const raw: string[] = [];
  return {
    options: { logger: { level: 'info', stream: { write: (line: string) => raw.push(line) } } },
    lines: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

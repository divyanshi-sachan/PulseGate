import { parseConfig } from '@pulsegate/config';
import { describe, expect, it } from 'vitest';
import { resolveClientAddress, TrustedProxies } from './client-address.ts';
import { buildUpstreamHeaders, filterResponseHeaders } from './headers.ts';
import { upstreamTarget } from './proxy-service.ts';

function route(forwarding?: { authorization?: boolean; forwardedHost?: boolean }) {
  const [first] = parseConfig({
    upstreams: [{ id: 'up', baseUrl: 'http://up:1' }],
    routes: [
      {
        id: 'r',
        pathPrefix: '/r',
        methods: ['GET'],
        upstreamId: 'up',
        rateLimit: { capacity: 1, refillRatePerSecond: 1 },
        ...(forwarding === undefined ? {} : { forwarding }),
      },
    ],
  }).routes;
  if (first === undefined) throw new Error('no route');
  return first;
}

const context = {
  requestId: 'req_1',
  forwardedFor: ['203.0.113.7'],
  viaTrustedProxy: false,
  connectionProto: 'http' as const,
};

describe('upstreamTarget (ADR-0019)', () => {
  it.each([
    ['', '/api/orders/123', 'x=1&x=2', '/api/orders/123?x=1&x=2'],
    ['/v1', '/api/orders/123', '', '/v1/api/orders/123'],
    ['/v1', '/123', '', '/v1/123'],
    ['', '/', '', '/'],
    ['', '/api/orders//a%2Fb/', '', '/api/orders//a%2Fb/'],
  ])('joins %j + %j + ?%j', (basePath, path, query, expected) => {
    expect(upstreamTarget(basePath, path, query)).toBe(expected);
  });
});

describe('buildUpstreamHeaders (ADR-0021)', () => {
  const incoming = {
    host: 'gateway.example:8080',
    connection: 'keep-alive, x-hop',
    'keep-alive': 'timeout=5',
    'x-hop': 'secret',
    te: 'trailers',
    upgrade: 'h2c',
    'proxy-authorization': 'Basic x',
    'x-api-key': 'pk_live_secret',
    authorization: 'Bearer token',
    'x-request-id': 'client-chosen',
    'x-forwarded-for': '1.2.3.4',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'evil.example',
    expect: '100-continue',
    accept: 'application/json',
    'set-cookie': ['a=1', 'b=2'],
  };

  it('strips hop-by-hop, connection-listed and gateway-owned headers by default', () => {
    const headers = buildUpstreamHeaders(incoming, { route: route(), ...context });
    expect(headers).toEqual({
      accept: 'application/json',
      'set-cookie': ['a=1', 'b=2'],
      'x-request-id': 'req_1',
      'x-forwarded-for': '203.0.113.7',
      'x-forwarded-proto': 'http',
    });
  });

  it('forwards Authorization and X-Forwarded-Host only when the route opts in', () => {
    const headers = buildUpstreamHeaders(incoming, {
      route: route({ authorization: true, forwardedHost: true }),
      ...context,
    });
    expect(headers['authorization']).toBe('Bearer token');
    expect(headers['x-forwarded-host']).toBe('gateway.example:8080');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('ignores a malformed Host for X-Forwarded-Host', () => {
    const headers = buildUpstreamHeaders(
      { host: 'bad host\r\nx: y' },
      { route: route({ forwardedHost: true }), ...context },
    );
    expect(headers['x-forwarded-host']).toBeUndefined();
  });

  it('takes X-Forwarded-Proto from a trusted proxy only when it is http or https', () => {
    const trustedContext = { route: route(), ...context, viaTrustedProxy: true };
    expect(
      buildUpstreamHeaders({ 'x-forwarded-proto': 'https' }, trustedContext)['x-forwarded-proto'],
    ).toBe('https');
    expect(
      buildUpstreamHeaders({ 'x-forwarded-proto': 'gopher' }, trustedContext)['x-forwarded-proto'],
    ).toBe('http');
  });
});

describe('filterResponseHeaders (ADR-0021)', () => {
  it('drops hop-by-hop and connection-listed response headers', () => {
    expect(
      filterResponseHeaders({
        Connection: 'close, X-Internal',
        'X-Internal': '1',
        'Keep-Alive': 'timeout=5',
        'Transfer-Encoding': 'chunked',
        'Content-Type': 'text/plain',
        'Set-Cookie': ['a=1', 'b=2'],
      }),
    ).toEqual({ 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] });
  });
});

describe('resolveClientAddress (ADR-0021)', () => {
  const none = new TrustedProxies([]);
  const lb = new TrustedProxies(['10.0.0.0/8', '192.0.2.10']);

  it('ignores X-Forwarded-For from an untrusted peer', () => {
    expect(resolveClientAddress('198.51.100.9', '1.2.3.4', none)).toEqual({
      clientIp: '198.51.100.9',
      forwardedFor: ['198.51.100.9'],
      viaTrustedProxy: false,
    });
  });

  it('walks a trusted chain right to left to the first untrusted hop', () => {
    expect(resolveClientAddress('10.0.0.5', '203.0.113.7, 1.1.1.1, 192.0.2.10', lb)).toEqual({
      clientIp: '1.1.1.1',
      forwardedFor: ['203.0.113.7', '1.1.1.1', '192.0.2.10', '10.0.0.5'],
      viaTrustedProxy: true,
    });
  });

  it('stops at a malformed entry instead of trusting what is left of it', () => {
    expect(resolveClientAddress('10.0.0.5', '203.0.113.7, not-an-ip', lb).clientIp).toBe(
      'not-an-ip',
    );
  });

  it('normalizes IPv4-mapped IPv6 peers', () => {
    expect(resolveClientAddress('::ffff:10.1.2.3', '203.0.113.7', lb).clientIp).toBe('203.0.113.7');
  });
});

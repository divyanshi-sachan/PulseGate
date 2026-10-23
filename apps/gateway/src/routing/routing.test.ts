import { parseConfig, type RouteConfig } from '@pulsegate/config';
import { describe, expect, it } from 'vitest';
import { parseRequestTarget } from './request-target.ts';
import { MethodNotAllowedError, RouteRegistry } from './route-registry.ts';

function routes(
  ...defs: { id: string; pathPrefix: string; methods: string[]; stripPrefix?: boolean }[]
) {
  const config = parseConfig({
    upstreams: [{ id: 'up', baseUrl: 'http://up:1' }],
    routes: defs.map((def) => ({
      ...def,
      upstreamId: 'up',
      rateLimit: { capacity: 1, refillRatePerSecond: 1 },
    })),
  });
  return new RouteRegistry(config.routes);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('parseRequestTarget (ADR-0019)', () => {
  it('splits path and query without decoding', () => {
    expect(parseRequestTarget('/api/orders/a%2Fb?x=1&x=2')).toEqual({
      rawPath: '/api/orders/a%2Fb',
      rawQuery: 'x=1&x=2',
    });
    expect(parseRequestTarget('/api/orders?')).toEqual({ rawPath: '/api/orders', rawQuery: '' });
    expect(parseRequestTarget('/a?b?c')).toEqual({ rawPath: '/a', rawQuery: 'b?c' });
  });

  it.each([
    '/api/orders/../payments',
    '/api/orders/./x',
    '/api/orders/%2e%2e/payments',
    '/api/orders/%2E./payments',
    '/api/orders/.%2e',
    '/api/orders/%zz',
    '/api/orders?q=%G1',
    'http://evil/api/orders',
    '*',
    '/api\\orders',
  ])('rejects %s with 400', (url) => {
    expect(codeOf(() => parseRequestTarget(url))).toBe('BAD_REQUEST');
  });

  it('allows dots inside segments and preserves duplicate or trailing slashes', () => {
    expect(parseRequestTarget('/api/v1.2/..x/x..//')).toEqual({
      rawPath: '/api/v1.2/..x/x..//',
      rawQuery: '',
    });
  });
});

describe('RouteRegistry (ADR-0017)', () => {
  const registry = routes(
    { id: 'get-orders', pathPrefix: '/api/orders', methods: ['GET'] },
    { id: 'create-orders', pathPrefix: '/api/orders', methods: ['POST'] },
    { id: 'order-items', pathPrefix: '/api/orders/items', methods: ['GET'], stripPrefix: true },
    { id: 'api', pathPrefix: '/api', methods: ['GET', 'DELETE'] },
  );
  const id = (method: string, path: string): string => registry.match(method, path).route.id;

  it('matches on whole segments only', () => {
    expect(id('GET', '/api/orders')).toBe('get-orders');
    expect(id('GET', '/api/orders/123')).toBe('get-orders');
    expect(id('GET', '/api/ordersX')).toBe('api');
  });

  it('prefers the longest prefix', () => {
    expect(id('GET', '/api/orders/items/9')).toBe('order-items');
    expect(id('GET', '/api/other')).toBe('api');
  });

  it('routes the same prefix to different routes by method', () => {
    expect(id('POST', '/api/orders')).toBe('create-orders');
  });

  it('returns 405 with the allowed methods for the matched prefix', () => {
    let error: unknown;
    try {
      registry.match('DELETE', '/api/orders/1');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MethodNotAllowedError);
    expect((error as MethodNotAllowedError).status).toBe(405);
    expect((error as MethodNotAllowedError).allow).toBe('GET, POST');
  });

  it('returns 404 when no prefix matches', () => {
    expect(codeOf(() => registry.match('GET', '/health'))).toBe('ROUTE_NOT_FOUND');
  });

  it('does not match percent-encoded spellings of a prefix', () => {
    expect(id('GET', '/api/%6Frders/1')).toBe('api');
  });

  it('strips the prefix only when configured, keeping "/" for the bare prefix', () => {
    expect(registry.match('GET', '/api/orders/items/9').forwardedPath).toBe('/9');
    expect(registry.match('GET', '/api/orders/items').forwardedPath).toBe('/');
    expect(registry.match('GET', '/api/orders/1').forwardedPath).toBe('/api/orders/1');
  });

  it('treats "/" as a catch-all and never strips it', () => {
    const catchAll = routes({ id: 'all', pathPrefix: '/', methods: ['GET'], stripPrefix: true });
    const match = catchAll.match('GET', '/x/y');
    expect(match.route.id satisfies RouteConfig['id']).toBe('all');
    expect(match.forwardedPath).toBe('/x/y');
  });
});

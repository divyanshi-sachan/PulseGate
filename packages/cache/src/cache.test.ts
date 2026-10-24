import { describe, expect, it } from 'vitest';
import {
  cacheableHeaders,
  cacheKey,
  cachePartition,
  MemoryResponseCache,
  requestBypassReason,
  storability,
  type CachedResponse,
  type RouteCachePolicy,
} from './index.ts';

const policy: RouteCachePolicy = {
  ttlSeconds: 30,
  maxResponseBytes: 1024,
  scope: 'client',
  varyHeaders: [],
};

function entry(bytes: number, expiresAtMs = 10_000): CachedResponse {
  return {
    statusCode: 200,
    headers: {},
    body: Buffer.alloc(bytes, 'x'),
    storedAtMs: 0,
    expiresAtMs,
  };
}

describe('MemoryResponseCache (ADR-0036)', () => {
  it('returns stored entries until they expire', async () => {
    let now = 0;
    const cache = new MemoryResponseCache({ maxEntries: 10, maxBytes: 10_000, now: () => now });
    await cache.set('a', entry(10, 1000));
    expect((await cache.get('a'))?.body.length).toBe(10);
    now = 1000;
    expect(await cache.get('a')).toBeUndefined();
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0, evictedExpired: 1 });
  });

  it('evicts least-recently-used entries to respect maxEntries', async () => {
    const cache = new MemoryResponseCache({ maxEntries: 2, maxBytes: 10_000, now: () => 0 });
    await cache.set('a', entry(1));
    await cache.set('b', entry(1));
    await cache.get('a'); // a is now most recent
    await cache.set('c', entry(1));
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toBeDefined();
    expect(cache.stats()).toMatchObject({ entries: 2, evictedCapacity: 1 });
  });

  it('evicts until the byte budget holds, and never exceeds it', async () => {
    const cache = new MemoryResponseCache({ maxEntries: 1000, maxBytes: 1000, now: () => 0 });
    for (let i = 0; i < 50; i++) {
      await cache.set(`k${String(i)}`, entry(300));
      expect(cache.stats().bytes).toBeLessThanOrEqual(1000);
    }
    expect(cache.stats()).toMatchObject({ entries: 3, bytes: 900 });
  });

  it('refuses entries larger than the whole budget and already-expired entries', async () => {
    const cache = new MemoryResponseCache({ maxEntries: 10, maxBytes: 100, now: () => 50 });
    await cache.set('big', entry(101));
    await cache.set('stale', entry(1, 50));
    expect(cache.stats().entries).toBe(0);
  });

  it('replaces an existing key without double-counting bytes', async () => {
    const cache = new MemoryResponseCache({ maxEntries: 10, maxBytes: 1000, now: () => 0 });
    await cache.set('a', entry(100));
    await cache.set('a', entry(200));
    expect(cache.stats()).toMatchObject({ entries: 1, bytes: 200 });
  });

  it('sweeps expired entries', async () => {
    let now = 0;
    const evictions: string[] = [];
    const cache = new MemoryResponseCache({
      maxEntries: 10,
      maxBytes: 1000,
      now: () => now,
      onEvict: (reason) => evictions.push(reason),
    });
    await cache.set('a', entry(1, 100));
    await cache.set('b', entry(1, 500));
    now = 200;
    expect(cache.sweep()).toBe(1);
    expect(evictions).toEqual(['expired']);
  });
});

describe('cache rules (ADR-0035, ADR-0036)', () => {
  it('bypasses non-GET, forwarded Authorization and client no-cache', () => {
    expect(requestBypassReason('POST', {}, false)).toBe('method');
    expect(requestBypassReason('HEAD', {}, false)).toBe('method');
    expect(requestBypassReason('GET', { authorization: 'Bearer x' }, true)).toBe(
      'authorization-forwarded',
    );
    expect(requestBypassReason('GET', { authorization: 'Bearer x' }, false)).toBeUndefined();
    expect(requestBypassReason('GET', { 'cache-control': 'max-age=0, no-cache' }, false)).toBe(
      'client-no-cache',
    );
    expect(requestBypassReason('GET', { pragma: 'no-cache' }, false)).toBe('client-no-cache');
    expect(requestBypassReason('GET', {}, false)).toBeUndefined();
  });

  it('partitions by client unless the route opts into shared caching', () => {
    expect(cachePartition(policy, 'acme')).toBe('client:acme');
    expect(cachePartition({ ...policy, scope: 'shared' }, 'acme')).toBe('shared');
    expect(cachePartition(policy, undefined)).toBe('shared');
  });

  it('builds distinct keys for every distinguishing part', () => {
    const base = {
      routeId: 'r',
      method: 'GET',
      rawPath: '/a',
      rawQuery: 'x=1',
      partition: 'client:acme',
      varyHeaders: ['accept'],
      requestHeaders: { accept: 'application/json' },
    };
    const keys = new Set([
      cacheKey(base),
      cacheKey({ ...base, partition: 'client:other' }),
      cacheKey({ ...base, rawPath: '/a/' }),
      cacheKey({ ...base, rawQuery: 'x=2' }),
      cacheKey({ ...base, routeId: 'r2' }),
      cacheKey({ ...base, requestHeaders: { accept: 'text/html' } }),
      // Path/query boundary can't be faked: '/a' + 'b' vs '/ab' + ''.
      cacheKey({ ...base, rawPath: '/ab', rawQuery: '' }),
      cacheKey({ ...base, rawPath: '/a', rawQuery: 'b' }),
    ]);
    expect(keys.size).toBe(8);
    expect(cacheKey(base)).toBe(cacheKey({ ...base }));
  });

  it('stores only cacheable 200 responses', () => {
    expect(storability(200, {}, policy)).toEqual({ storable: true, ttlMs: 30_000 });
    expect(storability(404, {}, policy)).toEqual({ storable: false, reason: 'status' });
    expect(storability(200, { 'set-cookie': ['a=1'] }, policy)).toEqual({
      storable: false,
      reason: 'set-cookie',
    });
    for (const cc of ['private', 'no-store', 'no-cache', 'public, max-age=0', 's-maxage=0']) {
      expect(storability(200, { 'cache-control': cc }, policy)).toEqual({
        storable: false,
        reason: 'cache-control',
      });
    }
    expect(storability(200, { vary: '*' }, policy)).toEqual({ storable: false, reason: 'vary' });
    expect(storability(200, { vary: 'Accept-Language' }, policy)).toEqual({
      storable: false,
      reason: 'vary',
    });
    expect(storability(200, { vary: 'Accept' }, { ...policy, varyHeaders: ['accept'] })).toEqual({
      storable: true,
      ttlMs: 30_000,
    });
  });

  it('caps the TTL at s-maxage, else max-age', () => {
    expect(storability(200, { 'cache-control': 'max-age=5' }, policy)).toEqual({
      storable: true,
      ttlMs: 5000,
    });
    expect(storability(200, { 'cache-control': 'max-age=5, s-maxage=2' }, policy)).toEqual({
      storable: true,
      ttlMs: 2000,
    });
    expect(storability(200, { 'cache-control': 'max-age=3600' }, policy)).toEqual({
      storable: true,
      ttlMs: 30_000,
    });
  });

  it('never replays cookies or per-request ids', () => {
    expect(
      cacheableHeaders({
        'Content-Type': 'application/json',
        'Set-Cookie': ['a=1'],
        'X-Request-ID': 'req_old',
        Age: '3',
        'Content-Length': 12,
      }),
    ).toEqual({ 'content-type': 'application/json', 'content-length': '12' });
  });
});

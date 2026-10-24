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

  it('accounts bytes exactly across sets, replacements, deletes, evictions and expiry', async () => {
    let now = 0;
    const cache = new MemoryResponseCache({ maxEntries: 3, maxBytes: 10_000, now: () => now });
    const withHeaders: CachedResponse = {
      ...entry(100),
      headers: { 'content-type': 'text/plain' },
    };
    const headerBytes = 'content-type'.length + 'text/plain'.length;
    await cache.set('a', withHeaders);
    expect(cache.stats().bytes).toBe(100 + headerBytes);
    await cache.set('a', entry(40));
    expect(cache.stats().bytes).toBe(40);
    await cache.set('b', entry(10));
    await cache.set('c', entry(20, 500));
    await cache.set('d', entry(30)); // evicts a (LRU)
    expect(cache.stats()).toMatchObject({ entries: 3, bytes: 60 });
    await cache.delete('b');
    expect(cache.stats().bytes).toBe(50);
    now = 500;
    cache.sweep(); // c expires
    expect(cache.stats()).toMatchObject({ entries: 1, bytes: 30 });
    await cache.delete('d');
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it('keeps both bounds under many interleaved concurrent operations', async () => {
    const cache = new MemoryResponseCache({ maxEntries: 50, maxBytes: 5000, now: () => 0 });
    await Promise.all(
      Array.from({ length: 2000 }, async (_, i) => {
        const key = `k${String(i % 300)}`;
        if (i % 3 === 0) await cache.get(key);
        else await cache.set(key, entry(1 + (i % 200)));
        const { entries, bytes } = cache.stats();
        expect(entries).toBeLessThanOrEqual(50);
        expect(bytes).toBeLessThanOrEqual(5000);
      }),
    );
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
    for (const cc of ['private', 'no-store', 'no-cache', 'Private', 'no-cache="Set-Cookie"']) {
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

  it('treats zero or malformed freshness as stale', () => {
    for (const cc of ['public, max-age=0', 's-maxage=0', 'max-age=abc', 'max-age=-5']) {
      expect(storability(200, { 'cache-control': cc }, policy, 0)).toEqual({
        storable: false,
        reason: 'stale',
      });
    }
  });

  it('never stores Vary: *, alone or combined with configured headers', () => {
    const withAccept = { ...policy, varyHeaders: ['accept'] };
    expect(storability(200, { vary: '*' }, withAccept)).toEqual({
      storable: false,
      reason: 'vary',
    });
    expect(storability(200, { vary: 'Accept, *' }, withAccept)).toEqual({
      storable: false,
      reason: 'vary',
    });
  });

  it('honors Pragma: no-cache only when Cache-Control is absent', () => {
    expect(storability(200, { pragma: 'no-cache' }, policy)).toEqual({
      storable: false,
      reason: 'cache-control',
    });
    expect(
      storability(200, { pragma: 'no-cache', 'cache-control': 'max-age=10' }, policy, 0),
    ).toEqual({
      storable: true,
      ttlMs: 10_000,
    });
  });

  it('uses Expires minus Date when no max-age is given, and treats invalid Expires as expired', () => {
    const date = 'Sat, 24 Oct 2026 10:00:00 GMT';
    expect(
      storability(
        200,
        { date, expires: 'Sat, 24 Oct 2026 10:00:20 GMT' },
        policy,
        Date.parse(date),
      ),
    ).toEqual({ storable: true, ttlMs: 20_000 });
    expect(storability(200, { date, expires: 'Sat, 24 Oct 2026 09:00:00 GMT' }, policy)).toEqual({
      storable: false,
      reason: 'stale',
    });
    expect(storability(200, { expires: '0' }, policy)).toEqual({
      storable: false,
      reason: 'stale',
    });
    // max-age wins over Expires.
    expect(storability(200, { 'cache-control': 'max-age=5', expires: '0' }, policy, 0)).toEqual({
      storable: true,
      ttlMs: 5000,
    });
  });

  it('subtracts the upstream Age so entries never outlive their freshness', () => {
    expect(storability(200, { 'cache-control': 'max-age=30', age: '25' }, policy, 0)).toEqual({
      storable: true,
      ttlMs: 5000,
    });
    expect(storability(200, { 'cache-control': 'max-age=30', age: '30' }, policy, 0)).toEqual({
      storable: false,
      reason: 'stale',
    });
    // Age without explicit freshness shortens the route TTL; a malformed Age counts as stale.
    expect(storability(200, { age: '10' }, policy, 0)).toEqual({ storable: true, ttlMs: 20_000 });
    expect(storability(200, { age: 'soon' }, policy, 0)).toEqual({
      storable: false,
      reason: 'stale',
    });
  });

  it('never puts credentials into keys, even when the request carries them', () => {
    const key = cacheKey({
      routeId: 'r',
      method: 'GET',
      rawPath: '/a',
      rawQuery: '',
      partition: 'client:acme',
      varyHeaders: ['accept'],
      requestHeaders: {
        accept: 'text/plain',
        'x-api-key': 'pg_secret',
        authorization: 'Bearer tok',
        cookie: 's=1',
      },
    });
    expect(key).not.toMatch(/pg_secret|Bearer|tok|s=1/);
    expect(key).toContain('text/plain');
  });

  it('includes every configured vary header value in the key', () => {
    const base = {
      routeId: 'r',
      method: 'GET',
      rawPath: '/a',
      rawQuery: '',
      partition: 'shared',
      varyHeaders: ['accept', 'accept-language'],
    };
    const keys = new Set(
      [
        { accept: 'a', 'accept-language': 'en' },
        { accept: 'a', 'accept-language': 'fr' },
        { accept: 'b', 'accept-language': 'en' },
        { accept: 'a' },
      ].map((requestHeaders) => cacheKey({ ...base, requestHeaders })),
    );
    expect(keys.size).toBe(4);
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

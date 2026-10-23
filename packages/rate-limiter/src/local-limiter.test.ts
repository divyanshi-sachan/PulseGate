import { describe, expect, it } from 'vitest';
import { LocalTokenBucketLimiter } from './index.ts';

function fakeClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const policy = { capacity: 3, refillRatePerSecond: 1 };

describe('LocalTokenBucketLimiter (ADR-0004, ADR-0032)', () => {
  it('starts full, consumes one token per request and rejects when empty', () => {
    const clock = fakeClock();
    const limiter = new LocalTokenBucketLimiter({ now: clock.now });
    const results = [1, 2, 3, 4].map(() => limiter.consumeSync('k', policy));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]).toEqual({
      allowed: false,
      limit: 3,
      remaining: 0,
      retryAfterMs: 1000,
      resetAfterMs: 3000,
    });
  });

  it('refills over elapsed time, including fractional tokens', () => {
    const clock = fakeClock();
    const limiter = new LocalTokenBucketLimiter({ now: clock.now });
    for (let i = 0; i < 3; i++) limiter.consumeSync('k', policy);

    clock.advance(500);
    const half = limiter.consumeSync('k', policy);
    expect(half).toMatchObject({ allowed: false, retryAfterMs: 500 });

    clock.advance(500);
    expect(limiter.consumeSync('k', policy).allowed).toBe(true);
  });

  it('never refills beyond capacity', () => {
    const clock = fakeClock();
    const limiter = new LocalTokenBucketLimiter({ now: clock.now });
    limiter.consumeSync('k', policy);
    clock.advance(60_000);
    expect(limiter.consumeSync('k', policy)).toMatchObject({ remaining: 2, resetAfterMs: 1000 });
  });

  it('ignores a clock that goes backwards', () => {
    const clock = fakeClock();
    const limiter = new LocalTokenBucketLimiter({ now: clock.now });
    for (let i = 0; i < 3; i++) limiter.consumeSync('k', policy);
    clock.advance(-10_000);
    expect(limiter.consumeSync('k', policy).allowed).toBe(false);
  });

  it('keeps keys isolated', () => {
    const limiter = new LocalTokenBucketLimiter({ now: fakeClock().now });
    for (let i = 0; i < 3; i++) limiter.consumeSync('a', policy);
    expect(limiter.consumeSync('a', policy).allowed).toBe(false);
    expect(limiter.consumeSync('b', policy).allowed).toBe(true);
  });

  it('allows exactly `capacity` of 1,000 concurrent consumes', async () => {
    const limiter = new LocalTokenBucketLimiter({ now: fakeClock().now });
    const decisions = await Promise.all(
      Array.from({ length: 1000 }, () =>
        limiter.consume('hot', { capacity: 100, refillRatePerSecond: 1 }),
      ),
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(100);
  });

  it('sweeps only buckets that have refilled to capacity', () => {
    const clock = fakeClock();
    const limiter = new LocalTokenBucketLimiter({ now: clock.now });
    limiter.consumeSync('used', policy);
    for (let i = 0; i < 3; i++) limiter.consumeSync('drained', policy);
    clock.advance(1000);
    expect(limiter.sweep()).toBe(1);
    expect(limiter.stats()).toEqual({
      buckets: 1,
      maxBuckets: 100_000,
      sweptFull: 1,
      evictedLru: 0,
    });
    // The drained bucket kept its state: 1 token refilled, not reset to full.
    expect(limiter.consumeSync('drained', policy)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('evicts the least-recently-used bucket at the cap', () => {
    const limiter = new LocalTokenBucketLimiter({ now: fakeClock().now, maxBuckets: 2 });
    limiter.consumeSync('a', policy);
    limiter.consumeSync('b', policy);
    limiter.consumeSync('a', policy); // a is now most recent
    limiter.consumeSync('c', policy); // evicts b
    expect(limiter.stats()).toEqual({ buckets: 2, maxBuckets: 2, sweptFull: 0, evictedLru: 1 });
    // a kept its state (two tokens used); b starts over as a new, full bucket.
    expect(limiter.consumeSync('a', policy).remaining).toBe(0);
    expect(limiter.consumeSync('b', policy).remaining).toBe(2);
  });
});

describe('LocalTokenBucketLimiter under key pressure (ADR-0032)', () => {
  it('never holds more than maxBuckets while 100,000 distinct keys arrive', () => {
    const limiter = new LocalTokenBucketLimiter({ now: fakeClock().now, maxBuckets: 1000 });
    let peak = 0;
    for (let i = 0; i < 100_000; i++) {
      limiter.consumeSync(`ip:${String(i)}`, policy);
      peak = Math.max(peak, limiter.stats().buckets);
    }
    expect(peak).toBe(1000);
    expect(limiter.stats()).toEqual({
      buckets: 1000,
      maxBuckets: 1000,
      sweptFull: 0,
      evictedLru: 99_000,
    });
  });

  it('keeps recently active callers and evicts the idle ones', () => {
    const limiter = new LocalTokenBucketLimiter({ now: fakeClock().now, maxBuckets: 3 });
    for (let i = 0; i < 3; i++) limiter.consumeSync('active', policy); // drains "active"
    for (let i = 0; i < 10; i++) {
      limiter.consumeSync(`spray:${String(i)}`, policy);
      limiter.consumeSync('active', policy); // stays most recent, so never evicted
    }
    expect(limiter.consumeSync('active', policy).allowed).toBe(false);
  });

  it('frees space losslessly once sprayed buckets refill', () => {
    const clock = fakeClock();
    const limiter = new LocalTokenBucketLimiter({ now: clock.now, maxBuckets: 100 });
    for (let i = 0; i < 100; i++) limiter.consumeSync(`ip:${String(i)}`, policy);
    clock.advance(1000); // one token back: every bucket is full again
    expect(limiter.sweep()).toBe(100);
    expect(limiter.stats()).toMatchObject({ buckets: 0, sweptFull: 100, evictedLru: 0 });
  });
});

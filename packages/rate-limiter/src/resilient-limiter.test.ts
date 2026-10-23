import { describe, expect, it } from 'vitest';
import {
  LocalTokenBucketLimiter,
  RateLimiterUnavailableError,
  ResilientRateLimiter,
  type RateLimitDecision,
  type RateLimiter,
} from './index.ts';

const policy = { capacity: 2, refillRatePerSecond: 0.001 };

/** A shared limiter that can be switched between healthy and failing. */
function switchable() {
  let failing = false;
  const healthy = new LocalTokenBucketLimiter({ now: () => 0 });
  const primary: RateLimiter = {
    consume(key, p): Promise<RateLimitDecision> {
      if (failing) return Promise.reject(new Error('Command timed out'));
      return healthy.consume(`shared:${key}`, p);
    },
  };
  return {
    primary,
    fail: () => {
      failing = true;
    },
    recover: () => {
      failing = false;
    },
  };
}

describe('ResilientRateLimiter (ADR-0034)', () => {
  it('passes decisions through while the shared limiter is healthy', async () => {
    const shared = switchable();
    const limiter = new ResilientRateLimiter({ primary: shared.primary, policy: 'closed' });
    const decision = await limiter.consume('k', policy);
    expect(decision).toMatchObject({ allowed: true, remaining: 1 });
    expect(decision.degraded).toBeUndefined();
  });

  it('fail-closed: rejects with RateLimiterUnavailableError', async () => {
    const shared = switchable();
    const limiter = new ResilientRateLimiter({ primary: shared.primary, policy: 'closed' });
    shared.fail();
    await expect(limiter.consume('k', policy)).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });

  it('fail-open: falls back to bounded per-instance buckets marked degraded', async () => {
    const shared = switchable();
    const limiter = new ResilientRateLimiter({
      primary: shared.primary,
      policy: 'open',
      fallback: new LocalTokenBucketLimiter({ now: () => 0 }),
    });
    shared.fail();
    const decisions = [
      await limiter.consume('k', policy),
      await limiter.consume('k', policy),
      await limiter.consume('k', policy),
    ];
    expect(decisions.map((d) => [d.allowed, d.degraded])).toEqual([
      [true, true],
      [true, true],
      [false, true],
    ]);
  });

  it('reports health changes once each, not per request, and recovers automatically', async () => {
    const shared = switchable();
    const changes: boolean[] = [];
    const limiter = new ResilientRateLimiter({
      primary: shared.primary,
      policy: 'open',
      onHealthChange: (healthy) => changes.push(healthy),
    });
    await limiter.consume('k', policy);
    shared.fail();
    for (let i = 0; i < 5; i++) await limiter.consume('k', policy);
    shared.recover();
    const back = await limiter.consume('k', policy);
    expect(changes).toEqual([false, true]);
    expect(limiter.healthy).toBe(true);
    expect(back.degraded).toBeUndefined();
  });
});

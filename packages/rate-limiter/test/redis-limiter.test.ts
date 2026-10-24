import { startTestRedis } from '@pulsegate/testing';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalTokenBucketLimiter, redisBucketKey, RedisTokenBucketLimiter } from '../src/index.ts';

/**
 * Real-Redis tests for the Lua token bucket (ADR-0005, ADR-0034). They use the Redis server clock, so
 * they rely on short real waits and high refill rates instead of fake time (documented exception).
 */
const redis = await startTestRedis();
const clients: Redis[] = [];
afterAll(async () => {
  for (const client of clients) client.disconnect();
  await redis?.stop();
}, 30_000);

function client(): Redis {
  if (redis === undefined) throw new Error('unreachable: suite is skipped without Redis');
  const c = new Redis(redis.url);
  clients.push(c);
  return c;
}

let keySeq = 0;
const freshKey = () => `test-route:client:c${String(++keySeq)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(redis === undefined)(
  'RedisTokenBucketLimiter against real Redis (ADR-0034)',
  () => {
    it('matches the local limiter decision for decision on a full drain', async () => {
      const key = freshKey();
      const remote = new RedisTokenBucketLimiter(client());
      const local = new LocalTokenBucketLimiter({ now: () => 0 });
      const policy = { capacity: 3, refillRatePerSecond: 0.001 };
      for (let i = 0; i < 4; i++) {
        const [r, l] = [await remote.consume(key, policy), local.consumeSync(key, policy)];
        expect({ allowed: r.allowed, remaining: r.remaining, limit: r.limit }).toEqual({
          allowed: l.allowed,
          remaining: l.remaining,
          limit: l.limit,
        });
      }
    });

    it('refills fractional tokens using the server clock and caps at capacity', async () => {
      const key = freshKey();
      const limiter = new RedisTokenBucketLimiter(client());
      const policy = { capacity: 3, refillRatePerSecond: 20 };
      for (let i = 0; i < 3; i++) await limiter.consume(key, policy);
      expect((await limiter.consume(key, policy)).allowed).toBe(false);
      await sleep(80); // 20/s × 0.08 s ≈ 1.6 tokens
      expect((await limiter.consume(key, policy)).allowed).toBe(true);
      await sleep(400); // far more than capacity
      expect((await limiter.consume(key, policy)).remaining).toBe(2);
    });

    it('allows exactly `capacity` of 1,000 concurrent calls across 5 connections', async () => {
      const key = freshKey();
      const limiters = Array.from({ length: 5 }, () => new RedisTokenBucketLimiter(client()));
      const policy = { capacity: 100, refillRatePerSecond: 0.001 };
      const decisions = await Promise.all(
        Array.from({ length: 1000 }, (_, i) => {
          const limiter = limiters[i % 5];
          if (limiter === undefined) throw new Error('unreachable');
          return limiter.consume(key, policy);
        }),
      );
      expect(decisions.filter((d) => d.allowed)).toHaveLength(100);
    });

    it('stores one hash-tagged key with a TTL bounded by the refill time', async () => {
      const key = freshKey();
      const c = client();
      await new RedisTokenBucketLimiter(c).consume(key, { capacity: 5, refillRatePerSecond: 10 });
      const redisKey = redisBucketKey(key);
      expect(redisKey).toBe(`pulsegate:rl:v1:{${key}}`);
      expect(await c.hgetall(redisKey)).toMatchObject({ tokens: '4' });
      const ttl = await c.pttl(redisKey);
      // One token missing at 10/s = 100 ms to refill, plus the 1 s margin.
      expect(ttl).toBeGreaterThan(1000);
      expect(ttl).toBeLessThanOrEqual(1100);
    });

    it('never expires a bucket before it would have refilled to capacity', async () => {
      const key = freshKey();
      const c = client();
      const limiter = new RedisTokenBucketLimiter(c);
      const policy = { capacity: 5, refillRatePerSecond: 10 };
      for (let i = 0; i < 5; i++) await limiter.consume(key, policy); // drained: full again after 500 ms
      const ttl = await c.pttl(redisBucketKey(key));
      // Time to full (500 ms) + 1 s margin, minus at most a few ms of test latency.
      expect(ttl).toBeGreaterThan(1450);
      expect(ttl).toBeLessThanOrEqual(1500);
      // Still drained inside the refill window: expiry can't hand out a fresh, full bucket early.
      expect((await limiter.consume(key, policy)).allowed).toBe(false);
    });

    it('reloads the script after SCRIPT FLUSH (NOSCRIPT fallback)', async () => {
      const c = client();
      const limiter = new RedisTokenBucketLimiter(c);
      const policy = { capacity: 2, refillRatePerSecond: 1 };
      await limiter.consume(freshKey(), policy);
      await c.script('FLUSH');
      expect((await limiter.consume(freshKey(), policy)).allowed).toBe(true);
    });
  },
);

import type { Redis } from 'ioredis';
import { TOKEN_BUCKET_SCRIPT, TOKEN_BUCKET_SHA1 } from './redis-script.ts';
import type { RateLimitDecision, RateLimiter, RateLimitPolicy } from './types.ts';

/** Bucket key: the whole id is a Redis Cluster hash tag, so one bucket stays on one slot (ADR-0034). */
export function redisBucketKey(key: string): string {
  return `pulsegate:rl:v1:{${key}}`;
}

/** Derives the decision fields from the post-consume token balance, exactly like the local limiter. */
export function decisionFromTokens(
  allowed: boolean,
  tokens: number,
  policy: RateLimitPolicy,
): RateLimitDecision {
  const rate = policy.refillRatePerSecond;
  return {
    allowed,
    limit: policy.capacity,
    remaining: Math.floor(tokens),
    retryAfterMs: allowed ? 0 : Math.ceil(((1 - tokens) / rate) * 1000),
    resetAfterMs: Math.ceil(((policy.capacity - tokens) / rate) * 1000),
  };
}

/** Shared token buckets in Redis (ADR-0005, ADR-0034). Every decision is one atomic script call. */
export class RedisTokenBucketLimiter implements RateLimiter {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    const args = [redisBucketKey(key), String(policy.capacity), String(policy.refillRatePerSecond)];
    let reply: unknown;
    try {
      reply = await this.#redis.evalsha(TOKEN_BUCKET_SHA1, 1, ...args);
    } catch (error) {
      // First use on this server (or after SCRIPT FLUSH): EVAL loads and caches the script.
      if (!(error instanceof Error) || !error.message.startsWith('NOSCRIPT')) throw error;
      reply = await this.#redis.eval(TOKEN_BUCKET_SCRIPT, 1, ...args);
    }
    if (!Array.isArray(reply) || reply.length !== 2) {
      throw new Error('Unexpected reply from the token-bucket script');
    }
    const [allowed, tokens] = reply as [unknown, unknown];
    return decisionFromTokens(allowed === 1, Number(tokens), policy);
  }
}

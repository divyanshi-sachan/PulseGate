import { consumeToken, refill, type TokenBucketState } from './token-bucket.ts';
import type { RateLimitDecision, RateLimiter, RateLimitPolicy } from './types.ts';

export interface LocalLimiterOptions {
  /** Monotonic milliseconds; injectable for tests (default `performance.now`). */
  now?: () => number;
  /** Bucket cap before least-recently-used eviction (default 100,000). */
  maxBuckets?: number;
}

export interface LocalLimiterStats {
  buckets: number;
  /** The configured cap; `buckets` never exceeds it. */
  maxBuckets: number;
  /** Full buckets removed by sweep(); lossless. */
  sweptFull: number;
  /** Buckets evicted at the cap; each briefly resets one caller's budget. */
  evictedLru: number;
}

interface Bucket extends TokenBucketState {
  policy: RateLimitPolicy;
}

/**
 * In-memory token buckets (ADR-0004, ADR-0032). Per-instance only, never a global limit.
 * The Map is kept in recency order (delete + set on access), so the LRU entry is always first.
 */
export class LocalTokenBucketLimiter implements RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;
  readonly #maxBuckets: number;
  #sweptFull = 0;
  #evictedLru = 0;

  constructor(options: LocalLimiterOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#maxBuckets = options.maxBuckets ?? 100_000;
  }

  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    return Promise.resolve(this.consumeSync(key, policy));
  }

  /** Synchronous core: refill and consume can't interleave with another request in this process. */
  consumeSync(key: string, policy: RateLimitPolicy): RateLimitDecision {
    const now = this.#now();
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      if (this.#buckets.size >= this.#maxBuckets) this.#evictLeastRecentlyUsed();
      bucket = { tokens: policy.capacity, lastRefillMs: now, policy };
    } else {
      this.#buckets.delete(key);
    }
    this.#buckets.set(key, bucket);
    return consumeToken(bucket, policy, now);
  }

  /** Removes buckets that have refilled to capacity; they behave exactly like new ones. */
  sweep(): number {
    const now = this.#now();
    let removed = 0;
    for (const [key, bucket] of this.#buckets) {
      if (refill(bucket, bucket.policy, now) >= bucket.policy.capacity) {
        this.#buckets.delete(key);
        removed++;
      }
    }
    this.#sweptFull += removed;
    return removed;
  }

  stats(): LocalLimiterStats {
    return {
      buckets: this.#buckets.size,
      maxBuckets: this.#maxBuckets,
      sweptFull: this.#sweptFull,
      evictedLru: this.#evictedLru,
    };
  }

  #evictLeastRecentlyUsed(): void {
    const oldest = this.#buckets.keys().next();
    if (oldest.done === true) return;
    this.#buckets.delete(oldest.value);
    this.#evictedLru++;
  }
}

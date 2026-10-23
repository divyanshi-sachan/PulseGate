import { LocalTokenBucketLimiter } from './local-limiter.ts';
import type { RateLimitDecision, RateLimiter, RateLimitPolicy } from './types.ts';

export type RedisFailurePolicy = 'open' | 'closed';

/** Thrown in fail-closed mode when the shared limiter can't decide (mapped to 503 by the gateway). */
export class RateLimiterUnavailableError extends Error {
  override readonly name = 'RateLimiterUnavailableError';
}

export interface ResilientLimiterOptions {
  primary: RateLimiter;
  policy: RedisFailurePolicy;
  /** Per-instance fallback used in fail-open mode (ADR-0034); default: a new local limiter. */
  fallback?: LocalTokenBucketLimiter;
  /** Called once per health change, never per request. */
  onHealthChange?: (healthy: boolean, error?: unknown) => void;
}

/**
 * Applies the explicit Redis failure policy (ADR-0005, ADR-0034): fail-closed rejects; fail-open falls
 * back to per-instance local buckets and marks decisions as degraded.
 */
export class ResilientRateLimiter implements RateLimiter {
  readonly #primary: RateLimiter;
  readonly #policy: RedisFailurePolicy;
  readonly #fallback: LocalTokenBucketLimiter;
  readonly #onHealthChange: ((healthy: boolean, error?: unknown) => void) | undefined;
  #healthy = true;

  constructor(options: ResilientLimiterOptions) {
    this.#primary = options.primary;
    this.#policy = options.policy;
    this.#fallback = options.fallback ?? new LocalTokenBucketLimiter();
    this.#onHealthChange = options.onHealthChange;
  }

  get healthy(): boolean {
    return this.#healthy;
  }

  /** The local buckets used while degraded (swept by the gateway like the local limiter). */
  get fallback(): LocalTokenBucketLimiter {
    return this.#fallback;
  }

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    try {
      const decision = await this.#primary.consume(key, policy);
      this.#setHealthy(true);
      return decision;
    } catch (error) {
      this.#setHealthy(false, error);
      if (this.#policy === 'closed') {
        throw new RateLimiterUnavailableError('Shared rate limiter unavailable', { cause: error });
      }
      return { ...this.#fallback.consumeSync(key, policy), degraded: true };
    }
  }

  #setHealthy(healthy: boolean, error?: unknown): void {
    if (healthy === this.#healthy) return;
    this.#healthy = healthy;
    this.#onHealthChange?.(healthy, error);
  }
}

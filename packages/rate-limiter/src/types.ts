export interface RateLimitPolicy {
  /** Maximum tokens; a new bucket starts full. */
  capacity: number;
  /** Tokens added per second. */
  refillRatePerSecond: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** The policy capacity (for X-RateLimit-Limit). */
  limit: number;
  /** Whole tokens left after this request. */
  remaining: number;
  /** Time until the next token, 0 when allowed (for Retry-After). */
  retryAfterMs: number;
  /** Time until the bucket is full again (for X-RateLimit-Reset). */
  resetAfterMs: number;
}

/** Strategy interface: local and Redis implementations are interchangeable (ADR-0004, ADR-0005). */
export interface RateLimiter {
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision>;
}

import type { RateLimitDecision, RateLimitPolicy } from './types.ts';

export interface TokenBucketState {
  tokens: number;
  lastRefillMs: number;
}

/** Tokens available at `nowMs`: T' = min(C, T + r·Δt). A clock that goes backwards adds nothing. */
export function refill(state: TokenBucketState, policy: RateLimitPolicy, nowMs: number): number {
  const elapsedSeconds = Math.max(0, nowMs - state.lastRefillMs) / 1000;
  return Math.min(policy.capacity, state.tokens + elapsedSeconds * policy.refillRatePerSecond);
}

/** Refills, then consumes one token if available; mutates `state` (ADR-0032). */
export function consumeToken(
  state: TokenBucketState,
  policy: RateLimitPolicy,
  nowMs: number,
): RateLimitDecision {
  let tokens = refill(state, policy, nowMs);
  const allowed = tokens >= 1;
  if (allowed) tokens -= 1;
  state.tokens = tokens;
  state.lastRefillMs = nowMs;

  const rate = policy.refillRatePerSecond;
  return {
    allowed,
    limit: policy.capacity,
    remaining: Math.floor(tokens),
    retryAfterMs: allowed ? 0 : Math.ceil(((1 - tokens) / rate) * 1000),
    resetAfterMs: Math.ceil(((policy.capacity - tokens) / rate) * 1000),
  };
}

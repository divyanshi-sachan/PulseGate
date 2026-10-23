# ADR-0004: In-memory token bucket as the baseline limiter

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** system_design §7.2, tech_impl §5.2

## Decision
LocalTokenBucketLimiter implements the RateLimiter strategy: T' = min(C, T + rΔt), consume 1 if T' ≥ 1. Monotonic injected clock, bounded key count, idle-bucket eviction.

## Consequences
Fast, dependency-free baseline for benchmarks. Limits are per instance — never described as global.

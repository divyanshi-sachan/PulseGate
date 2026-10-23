# ADR-0005: Redis Lua script for distributed rate limiting

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** system_design §7.3, tech_impl §5.3–5.4

## Decision
RedisTokenBucketLimiter runs read→refill→decide→decrement→expire in one Lua script using Redis server TIME. Key: pulsegate:rl:v1:{clientId:routeId} with unambiguous encoding. Redis outage behavior is an explicit config value: fail-open or fail-closed, observable in metrics.

## Consequences
Shared budget across instances without races or clock skew. Must be tested with real Redis, two gateway instances, and Redis outages under each policy.

# ADR-0050: Request deduplication (single-flight) for cache misses

- **Status:** Accepted (design; implemented in steps per `docs/plans/request-dedup.md`)
- **Date:** 2026-10-26
- **Source:** ADR-0049 (Q13: the measured stampede meets the rule). Plan `docs/plans/request-dedup.md` was approved
  with the user's decisions D1–D3.
- **Amends:** ADR-0036 (a new cache result and a fallback metric, step 2), ADR-0026 (new config defaults).

## Decision
- **Concurrent cache misses on the same cache key make one upstream call.**
  - The first miss is the **leader**: it fetches and stores as today.
  - Concurrent misses on the key are **waiters**: they wait for the leader's stored entry and are served from it.
  - The key is the existing cache key (route, method, raw path and query, partition, vary headers). Coalescing
    therefore never crosses clients on `scope: client` routes.
- **D1 (user):** a waiter served from the leader's entry is a new result, **`COALESCED`**:
  - `X-Cache: COALESCED` and `pulsegate_cache_requests_total{result="coalesced"}`;
  - a stats counter and a dashboard column;
  - the hit ratio stays hits ÷ (hits + misses) and is not inflated.
- **D2 (user), hand-off:** if the leader's fetch ends without storing because its client aborted or the upstream call
  failed, the waiters join again and one becomes the new leader. Each hand-off is still one upstream call. Waits are
  bounded by each waiter's own deadline.
- **Non-storable outcomes are never shared:** if the leader's response is not storable (e.g. `Set-Cookie`, `private`,
  a status outside the rules) or too large, every waiter fetches for itself, exactly as today.
- **Waiter deadline:** a waiter waits at most its request's remaining route deadline, and stops if its own client
  leaves. If the deadline passes, it gets a normalized 504 `UPSTREAM_TIMEOUT` and makes no upstream call.
- **D3 (user):** on by default for every cache-enabled route; `cache.coalesce: false` opts a route out.
- **Bounds (Claude-chosen defaults, configurable under `responseCache.coalesce`):**
  - `maxWaitersPerKey` 1,000;
  - `maxPendingKeys` 10,000 (keys being filled at once).
  - Beyond either, requests behave as today (an upstream call each), and the fallback is counted.
- **Unchanged:** the pipeline order (auth → rate limit → cache), storability and size rules, streaming to the leader's
  client, and retries and breakers (they apply to the leader's upstream call only).

## Implementation shape
- `InflightFills` in `packages/cache` (step 1). `join(key)` returns one of:
  - `leader` with an idempotent `settle(outcome)`;
  - `waiter` with `wait(signal)`;
  - `none` with a reason (`waiter_limit` | `key_limit`).
- Settling removes the key before the waiters are resolved, so a hand-off `join` finds it free. The leader settles in a
  `finally`, so no fill can outlive its request. Settling is idempotent, and a key is freed only by its own fill's
  settle, so an old leader can never remove a newer fill. (A mutation found an earlier extra guard for that case to
  be unreachable; it was removed.)
- A waiter's `wait` resolves with the leader's outcome, or with `cancelled` when its signal aborts. A cancelled waiter
  frees its slot.

## Alternatives considered
- **Count coalesced responses as hits (D1b):** simpler, but it inflates the hit ratio with responses that were never
  stored before the request arrived.
- **Detach the leader's upstream call from its client (D2b):** fewer calls on aborts, but a deeper change to the
  streaming path.
- **Opt-in per route (D3b):** more conservative, but stampede protection would exist only where someone remembered to
  configure it. Sharing is limited to what the cache would store and serve anyway.
- **Stale-while-revalidate:** changes freshness semantics; deferred (ADR-0049 option 2).

## Consequences
- **Waiters receive the body only once the leader's download has finished** (no streaming to waiters). That is bounded
  by `maxResponseBytes`.
- **Expected effect (measured in step 4):** the Q13 herd goes from 151 upstream calls per refill to 1, and a burst of N
  from N to 1 when the response is storable.

# ADR-0050: Request deduplication (single-flight) for cache misses

- **Status:** Accepted (design; steps 1–2 implemented per `docs/plans/request-dedup.md`)
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

## Gateway integration (step 2, 2026-10-27)
- **Where:** the cache-miss path in `apps/gateway/src/app.ts`, after auth and rate limiting. A request loops: a hit is
  served as before; otherwise `fills.join(key, request.id)` makes it the leader, a waiter, or neither (limits).
- **Leader settlement:** the capture settles the fill (`stored` with the very entry it stored, `not_storable` at
  `begin`, `too_large`); a thrown error or `onBodyError` settles `aborted` or `failed`. A safety net on the response's
  `close` (deferred one turn so a body that finished cleanly settles as stored first) settles `aborted`/`failed` for
  every other path, such as the client leaving mid-body, which has no callback of its own.
- **Waiters** are served exactly like a hit (status, cached headers, `Age`) with `X-Cache: COALESCED`. The log line
  has `cacheStatus: "coalesced"` and `coalescedWith` (the leader's request ID). They make no attempts.
- **Deadline:** a waiter waits at most its remaining route deadline. A request that waited (a hand-off leader, or a
  waiter that falls back) passes its start time to the proxy (`ForwardRequest.startedAtMs`), so its upstream deadline
  counts from the request start: waiting plus fetching never exceeds one `timeoutMs`. Requests that never waited keep
  the previous behaviour (the deadline starts at the forward call).
- **Metrics:** `pulsegate_cache_requests_total{result="coalesced"}` and
  `pulsegate_cache_coalesce_fallbacks_total{reason}` (ADR-0036's table). `Gateway.coalescing.stats()` exposes
  pending keys and waiters for tests and gauges.
- **Not yet:** the stats window, admin contract and dashboard do not know `coalesced` (step 3); they see these requests
  as completed requests with no cache lookup.

## Verified
- 12 socket tests (`apps/gateway/test/coalesce.test.ts`): 8 concurrent misses → 1 upstream call, 7 `COALESCED` + 1
  `MISS`, identical bodies, metrics and log agree; then a plain `HIT`. No sharing across clients; rate limiting still
  applies to waiters; `Set-Cookie`, oversized and upstream-error responses are never shared; hand-off after the
  leader's client leaves (before and after headers); no extension of the route deadline; per-route opt-out; the waiter
  and key bounds count their fallbacks. They wait on the gateway's own waiter count, not on sleeps, except the deadline
  test, which uses real time with a margin.
- 5 gateway mutations, all caught (82 in total): the key ignoring the client, coalesced counted as a hit, a
  non-storable response not announced, waiting extending the deadline, and the leader safety net removed.
- A bug the tests caught on the first run: `AbortSignal.timeout` needs an integer, and the new deadline arithmetic
  produced fractions for every request. Fixed with `Math.ceil`.

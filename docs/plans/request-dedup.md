# Plan: request deduplication (single-flight) for cache misses

_Status: **approved** (2026-10-26); **steps 1–2 done** (ADR-0050: `InflightFills`, config bounds, gateway integration, metrics, mutations). Follows ADR-0049 (Q13: the measured stampede meets the rule). Nothing is
implemented. **D1–D3 are decided by the user (2026-10-26): all as proposed** (`COALESCED` label, hand-off, on by
default with opt-out). _

## 1. Goal and non-goals
- **Goal:** concurrent cache misses for the **same cache key** make **one** upstream call. The others wait for its
  stored entry and are served from it.
  - Measured target: Q13-B goes from a median of 151 upstream calls per refill to **1**; a cold burst of N goes from N
    to **1**. Both are gated in the existing Q13 scenarios.
- **Non-goals (v1):**
  - **Stale-while-revalidate** changes freshness semantics; it is a separate decision later if wanted (ADR-0049 option 2).
  - **Coalescing across gateway instances** would need shared state; each instance coalesces its own misses.
  - **Coalescing non-cacheable requests** (bypass, POST, non-storable responses): sharing those could leak
    personalized data.

## 2. Decisions (settled 2026-10-26: D1 a, D2 a, D3 a)
| # | Topic | Options | Proposed |
|---|---|---|---|
| D1 | How a coalesced response is labelled and counted | (a) new result **`COALESCED`**: `X-Cache: COALESCED`, metric label `result="coalesced"`, a stats counter, a dashboard column. Hit ratio stays hits ÷ (hits + misses), with a separate coalesced share. (b) Count it as `HIT`. | **(a)**: it is neither a stored hit nor an upstream call, so counting it as a hit would inflate the hit ratio |
| D2 | When the leader's client disconnects | (a) **Hand-off**: the fill ends without storing, and waiting requests elect a new leader among themselves (bounded by their deadlines). (b) Keep the leader's upstream call running for the waiters after its client leaves (detach it from the client; a bigger change to the streaming path). | **(a)**: small, no change to how responses stream, and each hand-off still makes only one upstream call |
| D3 | Default | (a) **On** for every cache-enabled route, with a per-route `cache.coalesce: false` to opt out. (b) Opt-in per route. | **(a)**: it only ever shares what the cache would store and serve anyway, under the same key |

## 3. Design (assuming the proposals)
- **`InflightFills`** (a new class in `packages/cache`): `key → Fill { promise, waiters }`. It is bounded in two ways:
  - `maxWaitersPerKey` (default 1,000; beyond it, requests behave as today and go upstream themselves);
  - `maxPendingKeys` (default 10,000 keys being filled at once; beyond it, no coalescing).
  - Both are Claude-chosen defaults, configurable under `responseCache`, and documented in ADR-0026.
- **On a miss** (after auth and rate limiting, as now; the pipeline order is unchanged):
  - **No fill for the key: become the leader.** Register the fill and fetch as today, with the existing capture.
    - The capture's `complete` stores the entry **and resolves the fill with it**.
    - `not_storable`, `too_large`, an upstream error, a timeout or a client abort **resolve it with "not stored"**, plus
      the reason.
    - The fill is removed from the map in a `finally`, so it can never leak.
  - **A fill exists and there is room: become a waiter.**
    - Wait for the promise, bounded by **this request's remaining deadline** (`route.timeoutMs` minus time already
      spent) and by its own client signal.
    - **Entry stored:** serve it like a hit (status, cached headers, `Age`), labelled per D1.
    - **Not stored because of an abort or error:** hand off (D2) by running the lookup again; one waiter becomes the new
      leader and the rest wait on it.
    - **Not stored because the response is not storable or too large:** every waiter **fetches for itself**, as today.
      Such responses must never be shared (personalized or oversized), and re-coalescing would only serialize them.
    - **Waiter deadline reached:** a normalized 504 `UPSTREAM_TIMEOUT`. No extra upstream call, since the leader's
      deadline came earlier and its result is already known.
  - **The key is full (`maxWaitersPerKey`) or too many keys are pending:** go upstream as today and count the event
    (below).
- **What stays exactly as today:**
  - Cache keys, partitions and vary headers: coalescing within a key can't cross clients on `scope: client` routes.
  - Storability rules, size limits, streaming to the leader's client, retries and breakers (they apply to the leader's
    upstream call only; waiters make no attempts).
  - Rate limiting: every waiter has already passed its limiter check.
- **Observability** (new metric labels and series need rows in ADR-0036's metrics table):
  - `pulsegate_cache_requests_total{result="coalesced"}` (D1a), plus
    `pulsegate_cache_coalesce_fallbacks_total{reason="not_storable|too_large|handoff|waiter_limit|key_limit|deadline"}`.
    All label values are bounded.
  - **Stats window and admin contract:** `cache.coalesced` and a `cacheCoalescedRate`, which is coalesced ÷
    (hit + miss + coalesced). The dashboard's Cache screen shows it next to the hit ratio. The `@pulsegate/admin-contract`
    schema, fixtures and the screen test change together.
  - **Request log:** `cacheStatus: "coalesced"`, and `coalescedWith` set to the leader's request ID, for tracing.

## 4. Tests (written first, against a deterministic mock and fake clocks where possible)
- **Unit (`InflightFills`):**
  - the leader registers and waiters attach;
  - the stored entry is delivered to every waiter;
  - each "not stored" reason;
  - the waiter bound and the key bound;
  - removal on success, failure and exception (no leak);
  - a waiter's deadline and abort.
- **Socket tests (gateway + local upstream):**
  - N concurrent requests on a cold key → **1 upstream call**; N−1 `COALESCED` and 1 `MISS`; identical bodies.
  - `scope: client` route: two clients → **2** upstream calls (no cross-client sharing).
  - Upstream sends `Set-Cookie` or `private` → no sharing; every request goes upstream.
  - Oversized response → everyone fetches for themselves.
  - The leader's client aborts mid-fetch → hand-off: exactly one more upstream call, and the waiters are served.
  - Upstream 503 for the leader → no sharing of the error; the waiters fetch for themselves, still subject to the
    breaker.
  - A slow upstream beyond a waiter's deadline → that waiter gets 504; no extra upstream call.
  - `cache.coalesce: false` → today's behaviour.
  - Limits reached → today's behaviour, with fallbacks counted.
  - Metrics, stats window, admin API and request log agree with the traffic sent.
- **Mutations:**
  - waiters share a non-storable response;
  - the key ignores the partition (cross-client sharing);
  - the fill is never removed;
  - the waiter ignores its deadline;
  - a coalesced response counted as a hit.
- **Benchmarks:** the Q13 scenarios re-run with new gates: herd ≤ 1 upstream call per refill plus hand-offs, burst = 1.
  The report compares against ADR-0049's numbers.

## 5. Risks
- **Waiter latency:** a waiter gets the full response only once the leader's body has finished (no streaming to
  waiters). Bodies are capped at `maxResponseBytes` (256 KiB default), so the added delay is the leader's download
  time.
- **A slow leader holds everyone up to their deadline.** That is acceptable: without coalescing they would each make
  the same slow call. The deadline bound keeps it finite.
- **Hand-off storms:** each hand-off is still a single upstream call, bounded by deadlines; counted in the fallback
  metric.

## 6. Order of work (each a commit point)
1. ADR (the design and your D1–D3) + `InflightFills` + unit tests + config bounds (schema, ADR-0026, example YAML,
   defaults test).
2. Gateway integration + socket tests + metrics (ADR-0036 rows) + request log + mutations.
3. Stats window, admin contract, dashboard Cache screen + tests (and the e2e expectation if counts change).
4. Q13 re-run with the new gates; report and results ADR.

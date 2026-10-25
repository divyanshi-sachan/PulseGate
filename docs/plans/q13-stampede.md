# Plan: Q13, cache stampede measurement and decision rule

_Status: **done** (2026-10-25). Approved as written, measured, and decided in ADR-0049: the rule says implement
request deduplication. Report: `benchmarks/reports/20261025T055806Z-apple-m5-full.md`._

## 1. What we already know from the design (so the measurement can't "discover" it)
- The cache has **no coalescing**. Each miss forwards to the upstream; the response is stored only when its body
  completes (`apps/gateway/src/app.ts`, capture `complete`).
- So for one key, **every request that arrives while the first miss is in flight is also a miss**. With fill time W
  (upstream latency + transfer):
  - **Simultaneous burst of N** requests on a cold key, all arriving within W: **N upstream calls**.
  - **Hot key at rate r, on each TTL expiry:** about **1 + r·W upstream calls per refill**. For example, 500 rps with a
    300 ms upstream gives about 150 calls where 1 would do.
- **Two costs follow:**
  - **Origin load:** amplified calls and peak concurrency at the upstream.
  - **Gateway memory, often overlooked:** each concurrent miss tees its body into a capture buffer (up to
    `maxResponseBytes`, default 256 KiB). For example, 150 concurrent misses × 64 KiB is about 9.4 MiB held at once,
    against a 512 MiB container limit in the bench.
- **The measurement's job**, then, is to (1) confirm the model, i.e. that nothing else amplifies or accidentally
  coalesces; (2) quantify both costs at stated parameters; (3) show where it doesn't matter (a fast upstream).

## 2. Scenarios (mocks only; k6 on the Compose network; the fixed limits of ADR-0046)
A new route `bench-stampede`: `cache: { enabled, ttlSeconds: 2, scope: shared }`, `retries: { maxAttempts: 1 }` (so
retries can't add calls), `timeoutMs: 3000`. Response body via `_bytes=65536&_contentLength=1`, so it is storable, as in
K4.

| ID | Shape | Why |
|---|---|---|
| **Q13-A** burst | N ∈ {50, 200} simultaneous requests on a **cold** key (a unique path per repetition), upstream `_delay=300`; 3 repetitions per N | the textbook stampede, with an exact expected count (N) |
| **Q13-B** expiry herd | one hot key at **r = 500 rps** for 60 s, TTL 2 s (about 30 refills), upstream `_delay=300` | the realistic case: a popular key expiring under load. Per-refill amplification doesn't depend on TTL; TTL only sets how often it happens |
| **Q13-C** control | as Q13-B, but upstream `_delay=1` | shows amplification ≈ 1 when fills are fast, i.e. when not to bother |

- **Executors:** Q13-A uses `per-vu-iterations` (N VUs × 1 iteration, started together). The report records the
  **arrival spread** (last start − first start), and the run is valid only if the spread is below the upstream delay.
  Q13-B and Q13-C use `constant-arrival-rate`.

## 3. What is measured (all from raw data, gated where exact)
- **Upstream calls per fill:**
  - from the mock's per-path counter (`/_stats`);
  - plus a new mock field, **peak in-flight requests per path** (`maxInFlight`), for origin concurrency.
  - Fills in Q13-B/C are the contiguous clusters of `MISS` in k6's timeline; per cluster: misses = upstream calls.
- **Gates (correctness, exact):**
  - k6 MISS count = `/metrics` miss delta = mock calls for the path(s);
  - Q13-A: upstream calls = N for each repetition (the model is exact there);
  - all responses 200 with the 64 KiB body;
  - no retries recorded.
- **Informational:**
  - amplification per fill (median, max);
  - origin peak concurrency;
  - **gateway memory peak** (`docker stats`, about 1 s sampling, plus `pulsegate_nodejs_heap_size_used_bytes` before and
    after);
  - client latency of MISS vs HIT responses (p50/p99);
  - gateway CPU.
- Reports follow ADR-0046 (pinned config hashes, environment metadata, raw files kept, missing values refused). One
  full local run is committed; CI only checks that the scripts are valid.

## 4. Decision rule (fixed before measuring)
- **Implement request deduplication** (its own design plan and ADR first) **if, in Q13-B**, the median amplification is
  **≥ 10 upstream calls per refill**, **and at least one** of:
  - origin peak in-flight for the key ≥ 10;
  - the gateway's memory peak during refills exceeds its steady Q13-C level by ≥ 10 % of the container limit (51 MiB).
- **Otherwise:** document the measured behaviour and when it matters (rate × upstream latency), and keep Q13 deferred.
- **Why these thresholds:**
  - 10× is an order of magnitude more origin work than needed.
  - In-flight ≥ 10 is where an origin with modest concurrency limits starts queuing.
  - 10 % of the limit is a memory cost an operator would notice.
  - They are proposals for your review, not derived constants.
- **Honest expectation:** from §1, Q13-B at 500 rps × 300 ms predicts about 150× amplification, so the rule will very
  likely say "implement". The measurement adds the confirmation (no hidden amplification or coalescing) and the cost
  numbers. If you'd rather decide on product grounds instead (e.g. "origin protection is in scope for v1" or "not
  needed"), we can skip the run.

## 5. If the rule says "implement": options for the follow-up design (not decided here)
1. **Single-flight per cache key:**
   - the first miss leads; concurrent misses for the same key wait for its stored entry;
   - waiters are bounded (beyond that, they go upstream as today);
   - waiting never exceeds the route deadline;
   - if the leader fails or the response isn't storable, waiters fall back to their own upstream call, so no shared
     errors;
   - per partition, so per-client keys never share.
2. **Serve stale while revalidating** on expiry: one background refresh while hits still get the old entry for a
   bounded period. This changes freshness semantics and needs an ADR on HTTP `stale-while-revalidate` and its limits.
3. **Both.** Option 1 helps cold bursts and expiry; option 2 helps only expiry, but removes the refill latency for
   clients.

Each needs tests for the leader's client aborting, the leader failing or timing out, non-storable responses, waiter
bounds, and memory bounds, plus mutations.

## 6. Work if approved (each a commit point)
1. Mock `maxInFlight` per path, with tests; the `bench-stampede` route and its config loader test; k6 scripts
   `stampede-burst.js` / `stampede-herd.js`; runner hooks (`BENCH_ONLY=Q13`); report section and gates, with tests;
   `k6-inspect` coverage.
2. A full local run, the committed report, and a decision ADR per §4.

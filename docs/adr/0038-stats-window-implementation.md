# ADR-0038: Stats window and admin contracts (dashboard step 1)

- **Status:** Accepted (implements the approved plan `docs/plans/dashboard.md` §2 and §5.1; details below to review)
- **Date:** 2026-10-24
- **Implements:** `packages/admin-contract`, `StatsWindow` + `stats-math` in `packages/observability`, `scripts/bench-stats-window.ts`

## Decisions made while implementing *(Claude-chosen within the plan)*
- **Quantile definition:** nearest rank. The q-quantile is the smallest value with at least ⌈q·n⌉ values at or below
  it, so it is always an observed latency, never interpolated. The window uses the **weighted** nearest rank (the
  smallest value whose cumulative weight reaches q of the total). Brute-force tests check it against an expanded list
  for integer weights.
- **Effective sample size:** Kish, (Σw)² / Σw². When every bucket is exact (all weights 1) it equals the sample count.
- **Window `method`:** `exact` only if every bucket in it is exact; otherwise `sampled`.
- **Buckets follow a monotonic clock anchored to the wall clock at startup** *(changed by the review below; first version used `Date.now`)*.
  - The bucket list comes from the clock: quiet intervals are explicit empty buckets, and intervals before startup
    are omitted.
  - A bucket's `durationMs` is the real covered time (the first bucket after startup is shorter), and `partial` marks
    the bucket still filling.
  - The window's `partial` is true until it covers the full 300 s.
- **Counter layout:** 36 `Uint32` slots per route bucket (2 + 5 status classes + 15 codes, i.e. the 13 registry codes
  + `CLIENT_ABORTED` + `other`, + 4 limiter + 3 cache + 3 store + 3 attempts + 1 retries) and 4 per upstream bucket.
  Unknown codes count as `other`; unknown routes go to the `unmatched` series.
- **Contracts:** the counters include every code, with zeros, so dashboard tables have a fixed shape. Rates are `null`
  without a denominator. `packages/admin-contract` depends only on `zod` and `@pulsegate/shared` (pure TypeScript), so
  it is browser-safe.

## Verified (2026-10-24)
- **Tests:** 30 unit tests.
  - Brute-force weighted quantile (200 random trials) and ESS.
  - Every confidence threshold at n − 1 and n for p50, p95, p99.
  - Exact → sampled at 512; no first-512 bias; unbiased p50 under 100,000 observations.
  - A weighted window p50 that differs from the unweighted one; an ESS of 613 for the mixed case.
  - Every rate formula, including null denominators and bypasses excluded from the hit ratio.
  - Rotation without leaking counts; explicit empty buckets; real covered durations; contract validation of real snapshots.
- **Mutations:** 10 new ones, all caught (first-512 reservoir, unweighted merge, raw count instead of ESS, zero-fill
  before start, slot reuse leak, rps ignoring real duration, bypass in hit ratio, 0 instead of null, aborted attempts
  as failures, weakened confidence threshold).
- **Memory benchmark** (`pnpm bench:stats`, in CI):

  | Routes / upstreams | Formula | Measured (heapUsed + arrayBuffers) | After +1M requests |
  |---|---|---|---|
  | 10 / 5 | 1.05 MiB | 1.18 MiB (112 %) | no growth |
  | 50 / 20 | 4.47 MiB | 4.65 MiB (104 %) | no growth |
  | 200 / 100 | 18.69 MiB | 19.12 MiB (102 %) | no growth |

  The ~130 KB above the formula is fixed object overhead. The first version measured all configurations in one process
  and **undercounted by ~20 %**, because ArrayBuffer memory from the previous window was released lazily after GC. Each
  configuration now runs in its own child process.

## Review (2026-10-24, user): four checks and what changed
1. **Weighted percentile correctness:**
   - Weights are float64: bucket observations ÷ retained samples, e.g. 600/512 = 1.171875.
   - The boundary rule is nearest rank: the **lower** value wins when the cumulative weight lands exactly on q·total.
     A relative 1e-12 epsilon absorbs summation rounding only (0.1 + 0.2 must not move the 0.3 boundary).
   - New tests: 200 random trials with fractional weights (multiples of 1/8, many ties) against exact integer
     expansion, exact boundaries, ties at the boundary, and order independence.
2. **Confidence thresholds: replaced, not just tested.** The plan's rule (≥ 5 samples beyond the estimate) was a
   heuristic, and a simulation shows it fails for p99: at n = 500, fewer than 90 % of p99 estimates land within ±0.5 points.
   - **New rule:** "ok" when, with 95 % probability, the reported value lies between the true (q − δ)- and
     (q + δ)-quantiles. δ is **±5 pts for p50, ±2 pts for p95, ±0.5 pts for p99** *(Claude-chosen tolerances; review)*.
   - That requires n ≥ z²·q(1 − q)/δ² samples (effective samples for the window): **385, 457, 1,522**. It is
     distribution-free, because it is a statement about ranks.
   - **Monte Carlo test:** coverage ≥ 93 % at the threshold (600 trials each) and < 90 % at a sixth of it.
   - **Consequence:** a single 10 s bucket (≤ 512 samples) can never reach "ok" for p99, so per-bucket p99 is always
     marked low confidence. The window p99 becomes "ok" from ~1,522 requests per 5 minutes.
   - Exact buckets use the same rule: exact describes those requests, but confidence is about the latency the dashboard
     is trying to show.
3. **Counter overflow:**
   - Per-bucket `Uint32` counters reset every 10 s, so wrapping would need ~429 M events per second. They now
     **saturate** at 2³² − 1 anyway (tested), so an impossible overflow can never read as a tiny count.
   - Window sums use float64 (exact to 2⁵³), and lifetime totals live in Prometheus counters.
4. **Wall-clock changes:**
   - Buckets now follow `performance.now()`, anchored to `Date.now()` once at startup, so NTP steps or manual clock
     changes can't move, reuse or reorder buckets. Bucket timestamps may then drift from the wall clock by however
     far it was stepped, which is acceptable for a 5-minute view and recorded here.
   - Window time is clamped to never run backwards, even if the monotonic source misbehaves, so a slot only ever moves
     forward and stale counts can't be reused.
   - Tests: a wall clock stepped −1 h and then +1 d; a monotonic source going back 60 s; a 1-hour suspension (fresh
     zero buckets); rates finite or null at zero elapsed time, never Infinity.
- **Mutations:** 3 new ones, all caught (the old tail rule, time running backwards, wrapping counters). The ESS
  mutation was re-pointed after the refactor; the suite reported its stale pattern instead of passing silently.

## Consequences
- Step 2 wires the window into the gateway hooks (only when `ADMIN_TOKEN` is set) and assembles the five endpoints from
  `envelope()`, `routeSeries()`, `totalSeries()`, `unmatchedSeries()` and `upstreamSeries()`.

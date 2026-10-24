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
- **Buckets are aligned to wall-clock time** (`Date.now`), so chart timestamps are real.
  - A wall-clock jump can shift buckets; that is acceptable for a 5-minute operational view.
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

## Consequences
- Step 2 wires the window into the gateway hooks (only when `ADMIN_TOKEN` is set) and assembles the five endpoints from
  `envelope()`, `routeSeries()`, `totalSeries()`, `unmatchedSeries()` and `upstreamSeries()`.

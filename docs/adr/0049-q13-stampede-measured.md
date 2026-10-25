# ADR-0049: Cache stampede measured; request deduplication will be implemented (Q13)

- **Status:** Accepted (decision to implement; the design gets its own plan and ADR before any code)
- **Date:** 2026-10-25
- **Source:** OPEN_QUESTIONS Q13. Plan `docs/plans/q13-stampede.md` (approved as written), with its decision rule fixed
  before measuring.
- **Report:** `benchmarks/reports/20261025T055806Z-apple-m5-full.md` (68/68 correctness gates passed; raw files kept and
  checksummed as for all reports). Apple M5 via Docker Desktop, gateway limited to 2 CPUs / 512 MiB; local, not a
  production claim.

## What was measured (numbers copied from the report)
- **Q13-A, cold-key bursts** (300 ms upstream, 3 repetitions each): **50 → 50 upstream calls** and **200 → 200 upstream
  calls** in every repetition. That is the exact gate: no coalescing, as the design predicts.
  - Every burst started within the upstream delay (a gate).
  - For N = 200 the upstream never saw more than **128 concurrent requests**: the gateway's connection pool per upstream
    (`connectionsPerUpstream`, default 128) caps origin concurrency. The other 72 misses queued in the gateway and took
    a second round trip (MISS p99 about 618–674 ms vs about 318–369 ms for N = 50). They still reached the upstream.
- **Q13-B, expiry herd** (500 rps on one hot key, TTL 2 s, 300 ms upstream, 60 s): 29 refills, **median 151 upstream
  calls per refill** (max 154). The model 1 + r·W = 1 + 500 × 0.3 = 151 matches. Origin peak in-flight: **128** (the pool
  cap).
- **Q13-C, control** (same but a 1 ms upstream): median **2** calls per refill (max 4). With fast fills the stampede is
  negligible.
- **Reconciliation gates passed in every run:** k6 MISS = `/metrics` miss delta = upstream calls counted by the mock;
  0 retries.

## Decision (the rule from plan §4, applied as fixed)
| criterion | threshold | measured | met |
|---|---|---|---|
| median upstream calls per refill (Q13-B) | ≥ 10 | 151 | yes |
| origin peak in-flight for the key (Q13-B) | ≥ 10 | 128 | yes |
| gateway memory peak, Q13-B minus Q13-C | ≥ 51.2 MiB | −1.1 MiB | no |

**Outcome: implement request deduplication.** Amplification is met, and so is one of the two costs. As stated in the
plan, this outcome was predictable from the design; the run confirmed the mechanism exactly and measured its cost.

## Findings beyond the rule
- **The existing pool cap is partial protection already:** origin concurrency per upstream never exceeds 128, but the
  origin still receives every call, and the extra misses wait in the gateway. Deduplication would cut the calls
  themselves (151 → 1 per refill here).
- **The memory cost was not measurable at these sizes:** about 150 concurrent 64 KiB captures (≈ 9.4 MiB) are within the
  noise of ~1 s `docker stats` sampling. It would matter with larger bodies (up to `maxResponseBytes`, 256 KiB by
  default) or more concurrency; the plan's memory criterion simply wasn't met here.

## Consequences
- **Next:** a design plan for deduplication, to be reviewed before implementation. The options are recorded in plan §5:
  - single-flight per cache key, with bounded waiters, a deadline-bounded wait, fallback to an own upstream call if the
    leader fails or the response isn't storable, and per-partition keys;
  - serve stale while revalidating;
  - both.

  It needs tests for the leader's client aborting, the leader failing or timing out, non-storable responses, the waiter
  bound and memory, plus mutations. The Q13 scenarios re-measure the result (expected: about 1 upstream call per
  refill).
- Q13 moves to Resolved: the decision is made. The implementation is tracked by the design plan.

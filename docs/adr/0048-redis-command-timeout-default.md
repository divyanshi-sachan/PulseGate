# ADR-0048: Raise the Redis command timeout default to 350 ms (Q15)

- **Status:** Accepted
- **Date:** 2026-10-24
- **Supersedes:** the `rateLimit.redis.commandTimeoutMs` default of 50 ms (ADR-0026, ADR-0034)
- **Source:** OPEN_QUESTIONS Q15. The user chose "measure on native Linux first", with a decision rule fixed before
  measuring (recorded in Q15).

## Context
ADR-0047 found intermittent fail-closed 503s (`RATE_LIMITER_UNAVAILABLE`) under steady 500 rps on the Mac. They
coincided with event-loop stalls of about 100 ms, while Redis and the gateways had spare CPU. A stall longer than
`commandTimeoutMs` makes ioredis time the command out (timers run before I/O when the loop resumes), and
`redisFailurePolicy: closed` then rejects the request.

## Evidence
Each run: 10 Redis throughput windows (5 × 1 instance, 5 × 2 instances, about 37,500 requests each, full profile).
The per-window table "event-loop stalls vs fail-closed 503s" is in each report.

| run | environment | timeout | windows with limiter 503s | windows with a stall ≥ 50 ms | largest stall |
|---|---|---|---|---|---|
| `20261024T115515Z-apple-m5-full` | Mac, Docker Desktop | 50 ms | **2** (5 responses) | 7 | 163.7 ms |
| CI run [40100183226](https://github.com/divyanshi-sachan/PulseGate/actions/runs/40100183226) (`20261024T135514Z-gha-ubuntu-full`) | GitHub `ubuntu-latest`, AMD EPYC 7763, 4 vCPUs, Docker 29.4.2 on Ubuntu 26.04.1 | 50 ms | 0 | **7** | 84.5 ms |
| `20261024T142422Z-apple-m5-full` (verification) | Mac, Docker Desktop | **350 ms** | **0** | 7 | 154.0 ms |

- Earlier Mac runs at 50 ms (ADR-0047): 503s in 2 of 6 windows (1 and 12 responses), with stalls of 101.9 and 94.1 ms.
- **The CI numbers** are diagnostic counts used for this decision, not performance claims. The report itself stays
  outside git, as with all CI runs (ADR-0046), in the run's artifact (30-day retention).
- **On Linux, only the loaded instance stalled** (the idle one stayed at 13–29 ms). On the Mac, idle instances stalled
  too. So the Linux stalls look load-related: the bench limits add up to 9 CPUs on a 4-vCPU runner, plus GC. The Mac
  ones look like VM pauses. **Either way, stalls ≥ 50 ms occur on native Linux as well.**

## Decision
- **The rule fixed before measuring:** "if Linux shows any limiter 503, or any window with a stall ≥ 50 ms → raise the
  default to the smallest round value ≥ 2 × the largest stall observed in either environment, then verify on the Mac."
  - Linux showed 7 windows with stalls ≥ 50 ms.
  - The largest stall seen anywhere was 163.7 ms; 2 × 163.7 = 327.4 ms.
  - In steps of 50 ms, the new default is **350 ms**.
- **Verified:** with 350 ms the Mac run had **0 limiter 503s in 10 windows** (all 44 gates passed), with stalls as large
  as before (up to 154.0 ms). The new default absorbs the stalls rather than the stalls going away.
- **Changed:** the default in `packages/config/src/schema.ts` (with the reason in a comment), the two schema tests,
  `config/routes.distributed.example.yaml`, and ADR-0026's defaults table plus a note in ADR-0034.
- **Benchmark reports now record the limiter settings in force** (`meta.redisLimiter`). Reports whose metadata
  predates this say "not recorded" instead of assuming a value. The table above is the record for those runs.

## Trade-offs
- **Slower detection of a genuinely hung Redis:** each request waits up to 350 ms (was 50 ms) before its fail-closed
  503, or before falling back to local limits under fail-open. Connection failures are unaffected: with
  `enableOfflineQueue: false`, commands fail at once while the connection is down (ADR-0034).
- **Readiness probes:** the active Redis `PING` is bounded by the same timeout. 350 ms is well within the Compose
  healthcheck's 3 s timeout.
- **Still configurable:** deployments that prefer fast detection over tolerance to pauses (dedicated hosts with
  measured short pauses) can set a lower value; fail-open deployments lose less by keeping it low.

## Consequences
- Q15 is resolved. Run-to-run spread of stall sizes is still unknown beyond these runs. If production metrics
  (`pulsegate_nodejs_eventloop_lag_max_seconds`) show longer stalls, revisit with the same rule.

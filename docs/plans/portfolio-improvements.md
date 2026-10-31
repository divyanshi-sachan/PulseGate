# Plan: five portfolio improvements (from the 2026-10-31 audit)

_Status: **approved with decisions** (2026-10-31). Nothing is implemented yet. **D2 = GitHub runner with 3 repeats, D3 =
OpenTelemetry spans, order = plan order (dedup steps 3–4 around item 5)** are the user's answers; D1, D4 and D5 stand as
proposed (not objected to). Implementation starts with item 1 once the pending dedup step 2 is committed._

**Source:** the audit's "Top 5 improvements" (load balancing and health checks; Linux capacity and soak; Toxiproxy
fault recovery; distributed tracing; Redis token leasing). Same working rules as before: tests first, a mutation per new
guarantee, an ADR per decision, **every number measured and reported by the harness, pass/fail criteria fixed before
measuring**, you commit and push at each commit point.

## 0. Prerequisites and ordering
- **Pending work first:** the request-deduplication steps 2 (uncommitted) and 3–4 (stats window / dashboard / Q13
  re-run) belong to `docs/plans/request-dedup.md`. Commit step 2 before any of this starts. Steps 3–4 can interleave;
  the Q13 re-run should use the final hot path, so I'd do it last, together with item 5's capacity run.
- **Docker must be running** (it is stopped now): items 1, 3 and 5 are validated in Compose.
- **Order (and why):**
  1. **Load balancing and health checks:** the largest functional gap, and it creates the multi-replica stack that
     items 3 and 5 reuse.
  2. **Toxiproxy fault-recovery suite:** uses item 1's replicas for failover; validates the Redis failure policies.
  3. **Redis token leasing:** self-contained; measured with the existing K8 harness.
  4. **Distributed tracing:** touches every stage of the request path, so it comes after the structural changes.
  5. **Capacity and soak on Linux:** measured last, on the final system, with tracing overhead as an A/B.
- **ADR numbers:** 0051 (targets and load balancing), 0052 (fault suite), 0053 (token leasing), 0054 (tracing),
  0055 (capacity and soak). Config changes always update the schema, ADR-0026, the example YAML and the defaults test
  together (CLAUDE.md).

## 1. Decisions (D2, D3 and the order settled by the user on 2026-10-31)
| # | Question | Proposed default | Why |
|---|---|---|---|
| D1 | Where does the circuit breaker live once an upstream has several targets? | **Stays per upstream** (ADR-0024 unchanged), with a separate **per-target passive ejection** | One bad replica among healthy ones keeps resetting the consecutive-failure count, so a service-level breaker would never open; ejection handles exactly that case, and the breaker still protects against a whole service failing |
| D2 | Linux evidence for item 5 | **GitHub `ubuntu-latest` runs, 3 repeats, committed as labelled reports with their variance** (an exception to ADR-0046's "CI numbers are never committed", recorded in ADR-0055) | There is no Linux machine here; a single noisy run proves little, three repeats show the spread. If you can provide a Linux box, use that instead |
| D3 | Tracing depth | **OpenTelemetry API + SDK + OTLP/HTTP exporter, off unless configured**, spans for the server request, rate-limit, cache and each upstream attempt, W3C `traceparent` in and out, Jaeger demo in Compose | Real spans are the demo-able claim; the cost is more pinned dependencies (≥ 2 weeks old, install scripts denied). Alternative: propagate `traceparent` and log trace IDs only, with no spans and no new dependencies |
| D4 | Inbound request IDs | **Opt-in `server.acceptRequestId` (default off)**, accepted only when it matches `^[A-Za-z0-9._-]{8,64}$`; otherwise the gateway keeps generating `req_…` (ADR-0027) and logs the client's value as `clientRequestId` | Never trusting client IDs was a security decision; the opt-in serves deployments behind a trusted edge |
| D5 | Token leasing default | **Off; opt-in per route** (`rateLimit.lease`), exact per-request Redis decisions stay the default | It trades exactness (bounded under-admission) for fewer Redis calls and some outage tolerance |

## 2. Item 1: upstream targets, load balancing, health checks (ADR-0051)
**Config (backward compatible):** an upstream has either `baseUrl` (as today) or `targets: [baseUrl, …]` (2–32), plus:
- `loadBalancing: round-robin | least-connections` (default `round-robin`);
- `outlierEjection: { consecutiveFailures: 5, ejectionMs: 30000, maxEjectedPercent: 50 }` (never eject below one target);
- `healthCheck: { path, intervalMs: 5000, timeoutMs: 1000, unhealthyThreshold: 2, healthyThreshold: 2 }`, off unless
  `path` is set; it requests only the configured path of a configured target, never anything request-derived (SSRF).

**Design:**
- `TargetSet` per upstream: one undici `Pool` per target (128 connections each, unchanged), per-target in-flight
  counters, state `healthy | ejected | probing`. The selector skips ejected targets; with all ejected it **fails open
  to the least recently ejected** rather than refusing (the service breaker then decides).
- **Retries pick a different target** than the one that just failed, when one exists.
- A target's failure is counted by the same classification as the breaker (ADR-0024: connection errors, timeouts,
  configured 5xx; never 4xx, client aborts or `CIRCUIT_OPEN`).
- Active checks run on a timer with `unref()`, are bounded (one in flight per target), and stop at shutdown.
- **Metrics (rows in ADR-0036's table):** `pulsegate_upstream_target_state{upstream,target}` (the `target` label is
  the **configured index** `t0, t1, …`, bounded by config, never a hostname or URL), `…_ejections_total`, plus the
  existing attempt counters keep their `upstream` label.
- **Admin contract and dashboard:** `upstreams[].targets[]` (`id`, `url`, `state`, `inFlight`, `ejectedUntil`); the
  Upstreams screen lists them (contract, fixtures and screen change together).

**Tests:**
- Unit (fake clocks): rotation order, least-connections under skewed in-flight, ejection and re-admission after
  `ejectionMs`, `maxEjectedPercent`, all-ejected fallback, health-check hysteresis.
- Socket: 3 mock targets get traffic evenly (±1 request over 300); one target 503s → ejected after 5 failures and gets
  no traffic until re-admitted; a retry goes to a different target; a hung target is cut by the per-attempt timeout; a
  target removed by health check returns after `healthyThreshold` successes.
- **Docker failover test** (new `docker-compose.replicas.yml`, 3 replicas of the mock): steady 200 rps of GETs with
  retries; kill one replica mid-run; the harness reports client-visible errors, the time to ejection, and the time until
  100 % of traffic is on survivors.
  - **Pre-registered gates (correctness only):** after the kill, no request is sent to the dead replica for longer than
    `consecutiveFailures` attempts plus one health-check interval; the dead replica's traffic share reaches 0; the
    total error count is reported, not gated, until there is a repeatable baseline.
- **Mutations:** selector ignores ejection; ejection ignores the 4xx exclusion; retry reuses the failed target; no
  re-admission; `maxEjectedPercent` ignored; health check runs a request-derived path.

**Commit points:** (a) config schema, `TargetSet`/selector with unit tests, ADR **(done, ADR-0051)**; (b) proxy integration, metrics, socket
tests **(done)**; (c) active health checks; (d) admin contract and dashboard; (e) Docker failover test and report.

## 3. Item 2: Toxiproxy fault-recovery suite (ADR-0052)
- **Stack:** `docker-compose.faults.yml` adds a pinned Toxiproxy image with proxies gateway → upstream replicas and
  gateway → Redis. `pnpm test:faults` runs a Node driver (Vitest, files named `*.faults.ts`, never matched by the
  default globs, like `*.real.ts`), writes raw results, and **tears the stack down on every exit path**.
- **Toxics available:** `latency`, `timeout` (a blackhole), `reset_peer`, `bandwidth`, `limit_data`; `down` by disabling
  a proxy. Toxiproxy cannot model IP-level packet loss, so the suite says "connection resets and blackholes" and
  never "packet loss".
- **Scenarios and pre-registered gates** (each gate is on correctness or on a stated recovery bound; the recovery times
  themselves are reported as measured):

| ID | Fault | What must hold |
|---|---|---|
| T1 | `latency` 800 ms on one of 3 replicas, route timeout 500 ms | the slow replica is ejected; after removing the toxic it is re-admitted; the measured time to each is reported |
| T2 | `reset_peer` on one replica | errors stop after ejection; the other replicas keep serving |
| T3 | Blackhole (`timeout`) on all targets of one upstream | the breaker opens; `CIRCUIT_OPEN` responses carry `Retry-After`; other upstreams' routes keep 200; after the fault clears, the breaker returns to closed (time reported) |
| T4 | Redis blackhole, `redisFailurePolicy: closed` | limited routes answer 503 `RATE_LIMITER_UNAVAILABLE` within the command timeout; `/ready` reflects it; recovery time to the first 200 is reported |
| T5 | Redis blackhole, `redisFailurePolicy: open` | requests keep being served under local limits with `X-RateLimit-Mode: degraded`; recovery time to non-degraded decisions is reported |
| T6 | Redis down while token leasing is on (after item 3) | requests are served from held leases until they run out; then the policy applies |

- **Recovery measurement:** the driver polls with a fixed 50 ms cadence and records timestamps from its own monotonic
  clock; no assertions on wall-clock duration except generous correctness bounds (e.g. "recovers within 10 × the
  configured open duration").
- **Commit points:** (a) Compose stack, driver, T1–T3 (needs item 1); (b) T4–T5; (c) report generator section and CI
  `workflow_dispatch` job; (T6 lands with item 3).

## 4. Item 3: Redis token leasing (ADR-0053)
**Design:** per route, opt-in `rateLimit.lease: { size, ttlMs }` (for example size 20, ttl 200 ms).
- A new Lua script `lease(key, capacity, rate, want)` returns `min(want, floor(tokens))` tokens, deducted from the
  shared bucket atomically (same server-time refill as now), or 0.
- An instance keeps `{remaining, expiresAt}` per key (bounded map, LRU, swept). A request consumes a held token locally
  (no Redis call). When the lease is empty or expired, it requests a new one. When a lease **expires with tokens left**,
  they are **returned** by a `release(key, n, capacity)` script on the next Redis contact for that key (and on
  shutdown), so unused tokens are not stranded for long.
- **Why this is safe:** tokens are deducted from Redis before use, so **the gateway never admits more than the exact
  token bucket would**. The error is one-sided: **under-admission**, because tokens held by one instance can't be used
  by another meanwhile.
- **Derived bound (stated before measuring):** at any instant at most `instances × size` tokens are outside Redis, so
  over a window the accepted count lies in `[A_exact − instances × size, A_exact]`, where `A_exact` comes from the
  existing derivation (`C + ⌊ρ·span⌋`, with its timing tolerance).
- Headers: `X-RateLimit-Remaining` is the **shared** estimate at the last Redis contact plus the local lease, and
  documented as approximate on leased routes. 429s still carry `Retry-After` from the last Redis answer.
- Fail-open/closed are unchanged; with leases, a Redis outage is invisible until the held tokens run out.

**Tests:** unit (fake clock; expiry returns tokens; bounded map; never admits above the bucket across 3 simulated
instances against a model); socket + real Redis (Testcontainers: 2 gateways, concurrent burst, accepted count within the
derived interval); outage with leases (T6).
**Measurements (k6 K8 shapes, same machine, leases off vs on, 1 and 2 instances at 500 rps):**
- Redis commands per second (from `INFO commandstats` snapshots, a new before/after pair like the other counters);
- accepted count vs the derived interval (**gate**: inside it);
- p50/p99 latency (informational);
- the reduction factor is whatever is measured; no target is promised.

**Mutations:** a lease taken without deduction; expired tokens not returned; the held count unbounded; leasing on for
routes that didn't opt in.
**Commit points:** (a) scripts, `LeasingLimiter`, unit tests, ADR; (b) config, gateway wiring, socket and Redis tests;
(c) benchmark scenario, report section, results.

## 5. Item 4: distributed tracing (ADR-0054), per D3 and D4
- **Propagation:**
  - Parse an inbound `traceparent` (W3C: version 00, 32-hex trace ID, 16-hex parent ID, flags; invalid or all-zero → ignored).
  - Create the gateway's server span as its child. Each upstream attempt gets its own span; the forwarded `traceparent`
    carries that attempt's span ID; `tracestate` passes through untouched (bounded to 512 bytes).
  - Return `traceparent` on the response only when tracing is enabled.
  - Logs gain `traceId` and `spanId`.
  - **Request IDs:** per D4.
- **Spans** (OpenTelemetry API, SDK and OTLP/HTTP exporter, enabled by `OTEL_EXPORTER_OTLP_ENDPOINT` or
  `tracing.enabled`; a no-op when disabled so the hot path costs nothing):
  `gateway.request` (server), `gateway.rate_limit`, `gateway.cache` (attribute `cache.result`:
  hit/miss/bypass/coalesced), `gateway.upstream.attempt` (client; attributes `pulsegate.upstream`, attempt number,
  status; retries are sibling spans). Attributes are bounded: route ID, status class, outcome; **never** URLs, API keys
  or header values (ADR-0031's rules apply to traces too).
- **Sampling:** parent-based with a configurable ratio (default 1.0 only when enabled).
- **Demo:** `docker-compose.tracing.yml` with a pinned Jaeger all-in-one; the mock upstream echoes the `traceparent` it
  received.
- **Tests:** unit (header parse/format edge cases, invalid input); socket with an in-memory span exporter (the span tree
  for hit, miss, retry-then-success and a rate-limit rejection; the upstream received the same trace ID and the attempt
  span as parent); log fields; tracing off means no `traceparent` added and no exporter work.
- **Measurement:** K1 at 500 rps with tracing off vs on (ratio 1.0) vs on (ratio 0.01), same stack; the overhead is
  reported as measured and judged informationally.
- **Mutations:** the upstream gets the inbound span ID instead of the attempt's; invalid headers accepted; URLs or keys
  in attributes; tracing on without being enabled.
- **Commit points:** (a) `traceparent` parse/format, log fields, request-ID option, tests; (b) OTel spans and exporter
  config; (c) Compose Jaeger demo, benchmark A/B, results.

## 6. Item 5: capacity and soak on Linux (ADR-0055), per D2
- **Isolation:** `docker-compose.capacity.yml` pins CPUs with `cpuset` (gateway on 1 core, k6 on 2 others, mocks and
  Redis on the remainder) so the load generator doesn't take the gateway's CPU. A 4-vCPU runner can run it, with the
  noise that implies; the report records the runner's CPU model and the cpuset.
- **Capacity (knee) scenario:** stepped constant-arrival rates (each step 30 s measured after a 10 s warm-up) from
  500 rps upward in 500 rps steps until the first step with a **sustained breach** (3 consecutive seconds of p99 > 100
  ms or server errors > 1 %, the same definition K9 uses). **Reported:** the highest passing step ("sustained X rps
  per core"), gateway CPU at that step, and k6's own CPU (so a load-generator ceiling is visible). Capacity is
  reported as "passed step N, breached at step N+1", never as a guaranteed limit.
- **Soak:** 60 minutes at 50 % of the highest passing step, mixed workload (K3 shape), with `/metrics`
  (`heapUsed`, RSS, event-loop lag) scraped every 30 s and `docker stats` every second.
  - **Pre-registered pass criteria:** (a) the median heapUsed of the last 10 minutes ≤ 110 % of the median of minutes
    10–20; (b) the same for RSS; (c) zero server errors other than those the workload injects; (d) the stats-window and cache
    gauges stay inside their configured bounds. Failing (a) or (b) means "investigate a leak", not a pass.
- **Repeats:** 3 runs, reporting the spread. Only after that is a "sustained X rps per core" claim allowed.
- **Tracing A/B** (item 4) and **leases on/off** (item 3) are run at the step below the knee, as informational rows.
- **Where:** a `workflow_dispatch` workflow with inputs (steps, soak minutes, repeats); GitHub's 6-hour job limit fits
  3 × (knee + 60 min). Raw files go to artifacts and, per D2, the labelled summary and report to
  `benchmarks/reports/linux/`.
- **Generator changes (with tests):** periodic `/metrics` snapshots, the heap/RSS slope and median comparison, step-wise
  knee detection, a variance table across repeats, and the same refusal to write a report with a missing value.
- **Commit points:** (a) compose override, step scenario, knee detection in the generator; (b) soak scenario and
  criteria; (c) workflow; (d) results ADR.

## 7. What "done" means, and what the resume gets
Each result is added to the README or the resume **only** after its report exists:
- **Item 1:** "failover with N replicas: X client errors, ejected in Y ms" (measured in the Docker test).
- **Item 2:** the measured recovery times for T1–T5, with the stated bounds.
- **Item 3:** "Redis calls reduced N× at admission within the derived bound" (measured).
- **Item 4:** a Jaeger screenshot of a real trace, and the measured overhead of tracing.
- **Item 5:** "passed step N rps per core at p99 < 100 ms; no heap growth over 60 min" (3 repeats).
If a measurement doesn't meet its pre-registered criterion, the report says so, the finding becomes an ADR, and the
resume doesn't claim it.

## 8. Out of scope
HTTP/2 or gRPC; TLS termination and mTLS; a persistent control plane; dynamic target discovery (DNS or service
registry); sharing breaker state across instances; auto-scaling.

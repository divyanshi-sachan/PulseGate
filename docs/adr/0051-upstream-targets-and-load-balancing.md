# ADR-0051: Upstream targets, load balancing and passive outlier ejection

- **Status:** Accepted (design; step (a) of item 1 implemented: configuration and the `TargetSet` logic. Proxy
  integration, active health checks, admin contract/dashboard and the Docker failover test follow, per
  `docs/plans/portfolio-improvements.md` §2)
- **Date:** 2026-10-31
- **Source:** the 2026-10-31 audit (no load balancing across replicas) and the approved plan. D1 of the plan: the
  circuit breaker stays per upstream.
- **Amends:** ADR-0013 (an upstream can list several targets), ADR-0026 (new defaults), ADR-0036 (new metrics, step b).

## Context
An upstream had exactly one `baseUrl`. A service with several replicas could only be reached through an external load
balancer, and one bad replica could not be routed around. The service-level breaker (ADR-0024) can't help with a single
bad replica among healthy ones: the healthy replicas' successes keep resetting its consecutive-failure count.

## Decision
- **Config.** An upstream defines **exactly one** of `baseUrl` (as before) or `targets: [baseUrl, …]` (1–32, no
  duplicates). Every target follows the `baseUrl` rules of ADR-0013/0019 (http/https, no credentials, query or
  fragment). New per-upstream settings, all optional:
  - `loadBalancing: round-robin | least-connections` (default `round-robin`);
  - `outlierEjection: { consecutiveFailures: 5, ejectionMs: 30000, maxEjectedPercent: 50 }`;
  - `healthCheck: { path, intervalMs: 5000, timeoutMs: 1000, unhealthyThreshold: 2, healthyThreshold: 2 }`, off unless
    `path` is set. `path` must be an absolute path with no query, fragment, empty or `.`/`..` segments, and
    `timeoutMs < intervalMs`. It is a **fixed, configured path on a configured target**, never anything derived from a
    request (SSRF).
- **Target ids are `t0, t1, …` (configuration order).** They are bounded by the configuration, so they are safe metric
  labels, unlike hostnames or URLs (ADR-0036's cardinality rule).
- **Selection (`TargetSet` in `packages/reliability`).** Round-robin walks a rotating cursor over the targets that may
  take traffic. Least-connections picks the fewest in-flight attempts, with ties in rotation order. A retry **avoids the
  target that just failed** when another can serve.
- **Passive ejection.** `consecutiveFailures` failed attempts in a row eject a target for `ejectionMs`. Failures are
  counted by the breaker's rules (ADR-0024): connection errors, timeouts and configured 5xx; **never** 4xx, client
  aborts or `CIRCUIT_OPEN`, which settle as `neutral` (they neither count nor reset). A success resets the count.
  Never more than `maxEjectedPercent` of the targets, and **never the last one that is not ejected** (so a single target
  is never ejected).
- **Re-admission.** When `ejectionMs` is over, a target is `probing`: exactly one request at a time may use it. A
  success makes it healthy; a failure ejects it again for a full period. This avoids sending a full share of traffic to
  a replica that is still down. It is checked lazily, so ejection needs no timers.
- **Nothing can serve normally** (every target ejected, or probing with the probe busy): the target ejected longest ago
  is used anyway (a **forced probe**), instead of refusing every request. Whether the whole upstream is unusable is the
  breaker's job.
- **The circuit breaker stays per upstream (D1).** Passive ejection handles one bad replica; the breaker handles the
  service failing as a whole. Both use the same failure classification.
- **Backward compatibility.** The resolved config keeps `baseUrl`, `origin` and `basePath` as aliases of `targets[0]`
  until the proxy uses targets (step b removes them). Existing configs and tests are unchanged.

## Alternatives considered
- **One breaker per target:** simpler to reason about locally, but it multiplies breaker state, metrics and the admin
  surface, and the service-level protection (stop hammering a failing service) would still be needed.
- **Re-admit with full traffic after the ejection time (Envoy-style counters):** simpler, but a replica that is still
  down would take a full share of requests (and fail them) every `ejectionMs`; a single probe limits that to one request.
- **Refuse requests when every target is ejected:** turns a possibly transient replica problem into guaranteed errors.

## Verified so far (step a)
- **Config:** 6 new tests plus all 75 existing ones: defaults, ids, normalization, exactly-one-of, empty/duplicate/
  too-many targets, invalid target URLs, ejection bounds, health-check path rules (9 unsafe paths) and timeout < interval.
  *Found by a test:* the first path pattern accepted `//evil`, which is ambiguous as a request path; empty segments are
  now rejected.
- **`TargetSet`:** 20 deterministic tests on a fake clock: rotation, least-connections ties and skew, exclusion,
  single-settle, ejection thresholds, neutral outcomes, `maxEjectedPercent`, the last-target rule, probe-at-a-time,
  probe success/failure/neutral, the forced pick and reporting.
- **6 mutations**, all caught: ejected target still picked, unbounded probes, neutral counted as failure, no
  `maxEjectedPercent` limit, a retry reusing the failed target, and non-consecutive failures ejecting.

## Consequences
- Metrics and the admin contract gain targets in later steps (ADR-0036 table rows, `upstreams[].targets[]`).
- The Docker failover test (kill one of three replicas under load) reports errors and time to ejection; its
  correctness gates are fixed in the plan, its numbers are reported as measured.

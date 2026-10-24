# Open Questions

Gaps and conflicts in the specs that need a decision. Each has a **proposed default** so work can
continue if the user agrees. When resolved: record an ADR via `/adr`, then move the item to *Resolved*
with the ADR link. `[blocks: X]` marks the phase or component that can't be finalized without it.

## Open

- **Q14 — Version reference mismatch.** system_design_specification.md says "Addendum to PRD v1.1"; prd.md is v1.0.
  *Proposed:* treat prd.md as current; fix the header when convenient.

- **Q15 — Redis command timeout under fail-closed (from ADR-0047).** With `rateLimit.redis.commandTimeoutMs` at its 50 ms
  default and `redisFailurePolicy: closed`, a ~100 ms stall of the gateway's event loop (observed with Docker Desktop VM
  pauses) turns into a few 503 `RATE_LIMITER_UNAVAILABLE` (1 and 12 of about 37,500 requests in 2 of 6 windows).
  *Options:* (a) keep 50 ms and document the trade-off, (b) raise the default (e.g. 200 ms) so short pauses don't reject
  requests, (c) leave the default and recommend a higher value for fail-closed deployments. *Proposed:* measure on native
  Linux first; if stalls of this size don't occur there, choose (c), else (b). `[blocks: nothing; production guidance]`
- **Q13 (reopened as an evidence requirement) — request deduplication.** ADR-0035 deferred it until benchmarks justify
  it. The first full run could not show a stampede (ADR-0047). *Proposed:* add a stampede scenario (cold key, 300 ms
  upstream, about 200 concurrent requests) and decide from its upstream call count.

## Resolved

- **Q1 → [ADR-0013](../adr/0013-routes-reference-upstream-id.md):** routes must use `upstreamId`; URLs live only in top-level `upstreams[]`; inline route URLs unsupported.
- **Q2 → [ADR-0014](../adr/0014-auth-config-shape.md):** nested `auth: { required }`; flat `authRequired` not supported.
- **Q4 → [ADR-0015](../adr/0015-breaker-config-location.md):** top-level `circuitBreaker` defaults, field-by-field override per upstream; none on routes.
- **Q5 → [ADR-0016](../adr/0016-retry-config-semantics.md):** `maxAttempts` = total attempts incl. first; optional `baseDelayMs` 50, `maxDelayMs` 1000, `retryableStatuses` [502,503,504]; connection errors always retryable.
- **Q7 → [ADR-0017](../adr/0017-route-matching-and-forwarding.md):** segment-aware longest-prefix match then method; 405 `METHOD_NOT_ALLOWED` + `Allow`; prefix preserved unless `stripPrefix: true`; query forwarded verbatim.
- **Q10 → [ADR-0018](../adr/0018-client-error-codes.md), [ADR-0020](../adr/0020-admin-authentication.md):** 413 `PAYLOAD_TOO_LARGE`, 400 `BAD_REQUEST` (gateway-decided client errors, never upstream failures); admin uses a separate port + `ADMIN_TOKEN` bearer, 401 `ADMIN_AUTHENTICATION_FAILED`.
- **ADR-0017 follow-up → [ADR-0019](../adr/0019-upstream-url-joining.md):** raw-path joining `basePath + path`, dot segments → 400, `baseUrl` path-only, query forwarded byte-for-byte (bare `?` dropped).
- **Q16 → [ADR-0021](../adr/0021-header-forwarding.md):** strip hop-by-hop (both directions) and `X-API-Key`; `Authorization` only via `forwarding.authorization`; rebuild `X-Forwarded-*` from `server.trustedProxies`.
- **Q15 → [ADR-0022](../adr/0022-operations-listener.md):** operations listener on 9091 bound to 127.0.0.1 serves `/health`, `/ready`, `/metrics`, independent of admin.
- **Q12 → [ADR-0024](../adr/0024-breaker-failure-classification.md):** consecutive failures per upstream attempt; `failureStatuses` default [500,502,503,504]; `UPSTREAM_RESPONSE_TOO_LARGE` counts once, never retried; gateway 4xx, upstream 4xx, client aborts and `CIRCUIT_OPEN` never count.
- **Q17 → [ADR-0027](../adr/0027-request-ids.md):** always generate `req_<uuid>`; incoming `X-Request-ID` discarded; sent upstream and returned.
- **Q8 → [ADR-0032](../adr/0032-local-rate-limiting.md):** unauthenticated routes are limited per route + client IP (IP from ADR-0021).
- **Q9 → [ADR-0032](../adr/0032-local-rate-limiting.md):** `X-RateLimit-Limit/Remaining/Reset` on rate-limited routes; `Retry-After` on 429.
- **Q3 → [ADR-0033](../adr/0033-retries-and-breakers.md):** breaker states are `"closed" | "open" | "half-open"`.
- **Q11 → [ADR-0033](../adr/0033-retries-and-breakers.md):** `halfOpenSuccessThreshold` (default 1, ≤ `halfOpenMaxRequests`).
- **Q6 → [ADR-0035](../adr/0035-phase5-scope.md):** per-client cache keys on auth routes by default; `cache.scope: "shared"` opt-in; forwarded Authorization bypasses.
- **Q13 → [ADR-0035](../adr/0035-phase5-scope.md):** request deduplication deferred until benchmarks justify it.

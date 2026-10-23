# Open Questions

Gaps and conflicts in the specs that need a decision. Each has a **proposed default** so work can
continue if the user agrees. When resolved: record an ADR via `/adr`, then move the item to *Resolved*
with the ADR link. `[blocks: X]` marks the phase or component that can't be finalized without it.

## Open

- **Q3 — Breaker state naming.** system_design §10 uses `CLOSED/OPEN/HALF_OPEN`; tech_impl §10.4 uses
  `"closed" | "open" | "half-open"`. *Proposed:* lowercase string union in code and metrics labels.

- **Q6 — Caching on authenticated routes.** `[blocks: Phase 5 cache]`
  "Don't cache requests with authorization headers by default" — but auth-required routes always carry `X-API-Key`.
  Does the API key count, and is the cache partitioned per client?
  *Proposed:* API key does not by itself disable caching; cache key includes `clientId` by default
  (`scope: "client"`), with an explicit opt-in `scope: "shared"` for public data. `Authorization` header still bypasses.

- **Q8 — Rate-limit key on routes with `auth.required: false`.** No client identity exists.
  *Proposed:* key by client IP, only honoring `X-Forwarded-For` when a `trustedProxies` list is configured.

- **Q9 — Rate-limit headers.** `X-RateLimit-Limit/Remaining` vs IETF draft `RateLimit-*`; `Retry-After` on 429?
  *Proposed:* `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` + `Retry-After` (seconds) on 429.

- **Q11 — Half-open → closed threshold.** "After the required successful probes" but only `halfOpenMaxRequests` is configurable.
  *Proposed:* add `halfOpenSuccessThreshold` (default 1, ≤ `halfOpenMaxRequests`).

- **Q12 — Breaker failure counting.** Consecutive failures or failures within a window? Per upstream attempt or per client request?
  *Proposed:* consecutive failures, counted **per upstream attempt** (retries count), reset on success.

- **Q13 — Request deduplication (P1) has no design.** *Proposed:* defer; singleflight on the cache key for
  cache-eligible GETs only, designed in its own ADR before implementation.

- **Q14 — Version reference mismatch.** system_design_specification.md says "Addendum to PRD v1.1"; prd.md is v1.0.
  *Proposed:* treat prd.md as current; fix the header when convenient.

- **Q15 — Which port serves `/health`, `/ready` and `/metrics`?** ADR-0020 moves `/admin/*` to its own port,
  but the specs list health and metrics separately from admin.
  *Proposed:* `/health` and `/ready` on both listeners (load balancers probe the public port); `/metrics` on the admin
  port only, so Prometheus data isn't public. Note: this means `/metrics` would be off whenever `ADMIN_TOKEN` is unset.

- **Q16 — Header forwarding rules.** `[blocks: proxy, Phase 1]` FR-01 needs headers "forwarded according to documented rules",
  but none are documented. Open points: `Host`, hop-by-hop headers, `X-Forwarded-*`, whether the client's `X-API-Key` reaches the upstream.
  *Proposed:* strip hop-by-hop headers (`Connection` and the headers it lists, `Keep-Alive`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`,
  `Proxy-*`) in both directions; **strip the API-key header** before forwarding; set `Host` to the upstream host; add `X-Request-ID`
  and `X-Forwarded-For/Proto/Host` (appending to an incoming `X-Forwarded-For` only from `trustedProxies`, see Q8); pass all other
  headers through.

## Resolved

- **Q1 → [ADR-0013](../adr/0013-routes-reference-upstream-id.md):** routes must use `upstreamId`; URLs live only in top-level `upstreams[]`; inline route URLs unsupported.
- **Q2 → [ADR-0014](../adr/0014-auth-config-shape.md):** nested `auth: { required }`; flat `authRequired` not supported.
- **Q4 → [ADR-0015](../adr/0015-breaker-config-location.md):** top-level `circuitBreaker` defaults, field-by-field override per upstream; none on routes.
- **Q5 → [ADR-0016](../adr/0016-retry-config-semantics.md):** `maxAttempts` = total attempts incl. first; optional `baseDelayMs` 50, `maxDelayMs` 1000, `retryableStatuses` [502,503,504]; connection errors always retryable.
- **Q7 → [ADR-0017](../adr/0017-route-matching-and-forwarding.md):** segment-aware longest-prefix match then method; 405 `METHOD_NOT_ALLOWED` + `Allow`; prefix preserved unless `stripPrefix: true`; query forwarded verbatim.
- **Q10 → [ADR-0018](../adr/0018-client-error-codes.md), [ADR-0020](../adr/0020-admin-authentication.md):** 413 `PAYLOAD_TOO_LARGE`, 400 `BAD_REQUEST` (gateway-decided client errors, never upstream failures); admin uses a separate port + `ADMIN_TOKEN` bearer, 401 `ADMIN_AUTHENTICATION_FAILED`.
- **ADR-0017 follow-up → [ADR-0019](../adr/0019-upstream-url-joining.md):** raw-path joining `basePath + path`, dot segments → 400, `baseUrl` path-only, query forwarded byte-for-byte (bare `?` dropped).

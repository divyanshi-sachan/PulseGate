# Open Questions

Gaps and conflicts in the specs that need a decision. Each has a **proposed default** so work can
continue if the user agrees. When resolved: record an ADR via `/adr`, then move the item to *Resolved*
with the ADR link. `[blocks: X]` marks the phase or component that can't be finalized without it.

## Open

- **Q2 — Auth field shape.** `[blocks: config schema]`
  system_design §8 has `authRequired: boolean`; tech_impl §10.1 has `auth: { required: boolean }`.
  *Proposed:* nested `auth: { required }` (room for header name / scopes later).

- **Q3 — Breaker state naming.** system_design §10 uses `CLOSED/OPEN/HALF_OPEN`; tech_impl §10.4 uses
  `"closed" | "open" | "half-open"`. *Proposed:* lowercase string union in code and metrics labels.

- **Q4 — Where does circuit-breaker config live?** `[blocks: config schema, Phase 3]`
  `circuitBreaker` YAML appears in tech_impl §6 but in no `RouteConfig`/upstream schema.
  *Proposed:* on the upstream entry (breakers are per upstream), with global defaults.
  *Note:* ADR-0013 makes `upstreams[]` the natural home and fixes that routes sharing an upstream share its breaker.

- **Q5 — Retry policy fields and `maxAttempts` semantics.** `[blocks: config schema, Phase 3]`
  Config only has `retries.maxAttempts`; `RetryPolicy` adds `baseDelayMs`, `maxDelayMs`, `retryableStatuses`.
  Is `maxAttempts: 2` two total attempts or one original + two retries?
  *Proposed:* `maxAttempts` = **total attempts including the first**; other fields optional with documented defaults
  (base 50 ms, max 1000 ms, retryable 502/503/504 + connection errors).

- **Q6 — Caching on authenticated routes.** `[blocks: Phase 5 cache]`
  "Don't cache requests with authorization headers by default" — but auth-required routes always carry `X-API-Key`.
  Does the API key count, and is the cache partitioned per client?
  *Proposed:* API key does not by itself disable caching; cache key includes `clientId` by default
  (`scope: "client"`), with an explicit opt-in `scope: "shared"` for public data. `Authorization` header still bypasses.

- **Q7 — Path prefix stripping, query forwarding, method matching.** `[blocks: route registry, Phase 1]`
  tech_impl §8 says "the final schema must define" these. *Proposed:* preserve prefix by default
  (`stripPrefix: false` option), forward query string verbatim, longest-prefix match, 405 when path matches but method doesn't.

- **Q8 — Rate-limit key on routes with `auth.required: false`.** No client identity exists.
  *Proposed:* key by client IP, only honoring `X-Forwarded-For` when a `trustedProxies` list is configured.

- **Q9 — Rate-limit headers.** `X-RateLimit-Limit/Remaining` vs IETF draft `RateLimit-*`; `Retry-After` on 429?
  *Proposed:* `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` + `Retry-After` (seconds) on 429.

- **Q10 — Missing error codes & admin auth.** `GatewayErrorCode` lacks method-not-allowed (405),
  payload-too-large (413), bad-request (400). Admin auth mechanism is unspecified.
  *Proposed:* add `METHOD_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`, `BAD_REQUEST`; admin uses a separate
  `ADMIN_TOKEN` bearer from env, on a separate port or prefix.

- **Q11 — Half-open → closed threshold.** "After the required successful probes" but only `halfOpenMaxRequests` is configurable.
  *Proposed:* add `halfOpenSuccessThreshold` (default 1, ≤ `halfOpenMaxRequests`).

- **Q12 — Breaker failure counting.** Consecutive failures or failures within a window? Per upstream attempt or per client request?
  *Proposed:* consecutive failures, counted **per upstream attempt** (retries count), reset on success.

- **Q13 — Request deduplication (P1) has no design.** *Proposed:* defer; singleflight on the cache key for
  cache-eligible GETs only, designed in its own ADR before implementation.

- **Q14 — Version reference mismatch.** system_design_specification.md says "Addendum to PRD v1.1"; prd.md is v1.0.
  *Proposed:* treat prd.md as current; fix the header when convenient.

## Resolved

- **Q1 → [ADR-0013](../adr/0013-routes-reference-upstream-id.md):** routes must use `upstreamId`; URLs live only in top-level `upstreams[]`; inline route URLs unsupported.

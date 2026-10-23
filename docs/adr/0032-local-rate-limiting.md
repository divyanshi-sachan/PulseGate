# ADR-0032: Local token-bucket rate limiting

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** Phase 2 design questions (user chose all recommended options); OPEN_QUESTIONS Q8, Q9; ADR-0004; tech_impl §5
- **Builds on:** ADR-0004 (local token bucket), ADR-0010 (pipeline order), ADR-0021 (client IP)

## Decision

### Interface (`packages/rate-limiter`)
`RateLimiter.consume(key, { capacity, refillRatePerSecond }) → Promise<{ allowed, limit, remaining, retryAfterMs, resetAfterMs }>`.
`LocalTokenBucketLimiter` implements it; a Redis implementation follows in Phase 4 (ADR-0005).

### Algorithm
A new bucket starts **full**. For each request, with an injected monotonic clock:
`tokens = min(C, tokens + r·Δt)`. If `tokens ≥ 1`, consume one token and allow; otherwise reject.
`remaining = ⌊tokens⌋`, `retryAfterMs = ⌈(1 − tokens)/r⌉` (0 when allowed), `resetAfterMs = ⌈(C − tokens)/r⌉`.
Each refill-and-consume runs synchronously, so concurrent requests can't double-spend a token within one process.

### Keys (resolves Q8)
- Authenticated route: `<routeId>:client:<clientId>`. Unauthenticated route: `<routeId>:ip:<clientIp>`, where the IP comes from
  ADR-0021, so `X-Forwarded-For` only counts from trusted proxies and can't be spoofed.
- These keys are unambiguous: ids can't contain `:`, and the IP is the last component.
- Budgets are **per route and per caller**. Requests that don't match a route (404/405/400) are not rate-limited.

### Headers (resolves Q9)
- On every response from a rate-limited route, including gateway errors after the limit check:
  - `X-RateLimit-Limit`: the bucket capacity.
  - `X-RateLimit-Remaining`: whole tokens left.
  - `X-RateLimit-Reset`: seconds until the bucket is full again, rounded up.
- On **429 `RATE_LIMIT_EXCEEDED`**, also `Retry-After`: seconds until the next token, rounded up, at least 1.
- The gateway's values overwrite any upstream `X-RateLimit-*` headers.
- **Headers are present exactly when a bucket was consulted.** Auth runs before the limiter (ADR-0010), so a rejected
  caller has no trusted identity, and therefore no bucket to report:

  | Response | Rate-limit headers |
  |---|---|
  | 2xx/3xx/4xx/5xx from the upstream | yes |
  | 413 `PAYLOAD_TOO_LARGE`, 502 `UPSTREAM_UNAVAILABLE` / `UPSTREAM_RESPONSE_TOO_LARGE`, 504 `UPSTREAM_TIMEOUT` | yes (decided after the limit check) |
  | 429 `RATE_LIMIT_EXCEEDED` | yes, plus `Retry-After` |
  | 503 `CIRCUIT_OPEN` | yes, plus `Retry-After` (ADR-0033) |
  | 401 `AUTHENTICATION_FAILED` | **no** (before the limit check) |
  | 400 / 404 / 405 | **no** (before route resolution or the limit check) |

  Reporting a budget on a 401 would mean using some *other* bucket (e.g. per IP), which is the deferred
  failed-auth throttling below.

### Bounded state
- At most **`rateLimit.maxBuckets`** buckets (default 100,000).
- A periodic sweep (every 60 s, timer unref'd) removes buckets that have refilled to capacity. Such a bucket behaves
  exactly like a new one, so removing it loses nothing.
- If the map is still full when a new key arrives, the **least-recently-used** bucket is evicted in O(1), because the `Map`
  is kept in recency order. That briefly resets one caller's budget, a documented weakening; it is counted, and the sweep
  logs a summary when LRU evictions happened.

### Not in Phase 2
- Failed-auth throttling: 256-bit keys can't be guessed, and a rejected request costs one hash. This is a known limitation,
  for later abuse protection.
- Global or shared budgets, and multi-instance consistency (Phase 4).

## Consequences
- **Review checks (2026-10-23), in `apps/gateway/test/phase2-hardening.test.ts` and the unit suites:**
  - **Spoofing:** five different `X-Forwarded-For` values from an untrusted peer all hit one bucket. Behind a trusted
    proxy, real clients get separate buckets, but client-prepended fake hops can't move a bucket.
  - **Pressure:** 100,000 distinct keys never push a 1,000-bucket store past its cap (99,000 LRU evictions).
    Active callers survive spraying. Refilled buckets are swept losslessly. Through the gateway, 20 IPs on a
    5-bucket store peak at 5, and the warning log reports `maxBuckets: 5`.
  - **Headers:** the table above is checked response by response.
  - **Mutation checks:** trusting XFF from any peer, removing the cap, or setting headers on success only each fail the suite.
- The pipeline is now validate → match → **auth → rate limit** → proxy, as ADR-0010 requires.
- Tests: refill and consume math with a fake clock (no sleeps); exact allowance under 1,000 concurrent `consume` calls;
  capacity caps refill; lossless sweep; LRU eviction at the cap; header values; 429 with `Retry-After`; client and IP keys
  isolated per route; exactly `capacity` of N concurrent HTTP requests succeed.

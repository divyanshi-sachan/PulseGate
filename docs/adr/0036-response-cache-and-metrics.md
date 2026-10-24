# ADR-0036: Response cache and Prometheus metrics (Phase 5)

- **Status:** Accepted (ADR-0035 decisions by the user; every rule below is Claude-chosen within them; to review)
- **Date:** 2026-10-24
- **Source:** ADR-0009, ADR-0035; tech_impl §7, §11; system_design §12
- **Implements:** `packages/cache`, `packages/observability`, gateway wiring

## Response cache (per instance, bounded, ADR-0012)

### Where it sits
After auth and rate limiting, before the circuit breaker (ADR-0010). A hit never calls the upstream or touches the
breaker. The rate-limit token is still consumed and the limit headers are still sent.

### Request eligibility (otherwise `BYPASS`)
- The route has `cache.enabled: true` and the method is **GET**. HEAD and the other methods are not cached.
- The `Authorization` header is not being forwarded. A route with `forwarding.authorization: true` bypasses whenever the
  request has one (ADR-0035).
- The client didn't send `Cache-Control: no-cache` or `no-store`, nor `Pragma: no-cache`.

### Cache key
The **route id**, **method**, **raw path**, **raw query** and the values of `cache.varyHeaders` (lowercased names), plus a
**partition**:
- `client:<clientId>` on routes with `auth.required: true` and `cache.scope: "client"` (the default, ADR-0035).
- `shared` when `cache.scope: "shared"` or the route doesn't require auth.

The parts are joined unambiguously (JSON array) and never include credentials. Raw path and query are kept
byte-for-byte (ADR-0019), so different encodings or parameter orders are separate entries. That is conservative:
nothing is shared that a stricter reading would separate.

### Response storability (otherwise forwarded but not stored)
- Status **200** only.
- No `Set-Cookie`. A response that sets a cookie is personalized.
- `Cache-Control` has none of `no-store`, `no-cache`, `private`. `max-age=0` / `s-maxage=0` means don't store.
- `Vary`: absent, or every listed header is in `cache.varyHeaders`. `Vary: *` is never stored.
- Body ≤ `cache.maxResponseBytes`, known from `Content-Length` or counted while streaming. The body is **teed**: the
  client receives it as it streams, and a copy is collected up to the limit. If the copy overflows or the stream fails,
  nothing is stored.

### TTL and bounds
- TTL = `min(cache.ttlSeconds, s-maxage ?? max-age)`.
- Global `responseCache.maxEntries` (default **10,000**) and `responseCache.maxBytes` (default **64 MiB**) bound the whole
  cache. A per-entry size limit alone would allow 10,000 × 256 KiB = 2.5 GB.
- Eviction is least-recently-used until both bounds hold. Expired entries are dropped on access and by a periodic sweep.
- The clock is injected.

### Hits
- Stored headers are replayed without `Set-Cookie`, hop-by-hop headers or the upstream's `X-Request-ID`; the gateway's
  own request ID and rate-limit headers are added.
- `Age: <seconds>` is set.
- Every response from a cache-enabled route carries **`X-Cache: HIT | MISS | BYPASS`**, and the request log gets
  `cacheStatus`.

## Metrics (`GET /metrics` on the operations listener, ADR-0022)

### Collection
`prom-client` with a **per-gateway registry** (not the global default), so several instances can coexist in one process
in tests. Default process metrics (CPU, memory, event loop) are prefixed `pulsegate_`.

### Metric families
| Metric | Type | Labels |
|---|---|---|
| `pulsegate_requests_total` | counter | `route`, `status_class`, `code` |
| `pulsegate_request_duration_seconds` | histogram | `route` |
| `pulsegate_active_requests` | gauge | — |
| `pulsegate_upstream_requests_total` | counter | `upstream`, `outcome` (`success \| failure \| aborted`) |
| `pulsegate_upstream_duration_seconds` | histogram | `upstream` |
| `pulsegate_retries_total` | counter | `route` |
| `pulsegate_rate_limit_decisions_total` | counter | `route`, `decision` (`allowed \| rejected`), `mode` (`local \| redis \| degraded`) |
| `pulsegate_rate_limiter_unavailable_total` | counter | `route` |
| `pulsegate_cache_requests_total` | counter | `route`, `result` (`hit \| miss \| bypass`) |
| `pulsegate_cache_stores_total` | counter | `route`, `result` (`stored \| not_storable \| too_large`) |
| `pulsegate_cache_evictions_total` | counter | `reason` (`capacity \| expired`) |
| `pulsegate_cache_entries`, `pulsegate_cache_bytes` | gauge | — |
| `pulsegate_circuit_breaker_transitions_total` | counter | `upstream`, `from`, `to` |
| `pulsegate_circuit_breaker_state` | gauge | `upstream`, `state` (1 for the current state, else 0) |

### Label values
Every label value comes from a **bounded set**:
- `route`: configured route ids, or `unmatched`.
- `upstream`: configured upstream ids.
- `code`: the error registry, or `none`.
- `status_class`: `1xx`–`5xx`.
- Enum labels: fixed lists.

Never paths, request ids, client ids, IPs or keys (tech_impl §11). A test sprays random paths and clients and asserts
that the label sets don't grow.

## Implementation notes
- The tee reports `too_large` **as soon as** the copy overflows, so the request log line can include it.
  `stored` is only known when the body ends, which can happen after the log line is written, so the request log may
  omit `cacheStore: "stored"`. `pulsegate_cache_stores_total` always counts it.
- Upstream attempt metrics hook into the breaker permit, which settles exactly once per attempt. Attempt duration
  therefore includes streaming the body.
- The in-flight gauge decrements on the socket's `close`, which fires even when the client aborts (`onResponse`
  doesn't). An aborted request is counted once, with `code="CLIENT_ABORTED"`.
- Socket-level rejections (upgrade, CONNECT, parser errors) count as `route="unmatched", code="BAD_REQUEST"`.

## Consequences
- **Verified (2026-10-24):**
  - 294 tests with Redis required, stable over 3 runs for the new suites.
  - 21/21 mutations caught. The 5 new ones: cache ignoring the client partition, storing `private`, storing `Set-Cookie`,
    caching with a forwarded `Authorization`, and an unbounded route label.
  - The label test sprays 300 random paths, client IPs and keys; no label set grows.
  - Docker: MISS → HIT → HIT, no-cache → BYPASS. `/metrics` inside the container: 4 requests, 2 upstream calls,
    1 miss / 2 hits / 1 bypass, 1 stored. The port isn't reachable from the host.
  - First GitHub Actions run (55428b1): both jobs green.
- Tests:
  - Unit: LRU by entries and bytes, TTL with a fake clock, the key and partition rules, every storability rule.
  - Integration over sockets: client isolation on auth routes, sharing only with `scope: "shared"`, bypass on forwarded
    `Authorization`, the rate limit still applied on hits, TTL expiry, the tee.
  - Metrics: counts match the real traffic, the bounded-label test, breaker and cache metrics.
- New mutation entries guard client partitioning, the `private` / `Set-Cookie` rules and label cardinality.

# Architecture Decision Records

Accepted ADRs **override** the spec documents where they conflict. Create new ones with `/adr <title>`
(copy [0000-template.md](0000-template.md), next number, add a row below).

| ADR | Title | Status |
|---|---|---|
| [0001](0001-modular-monolith.md) | Modular monolith in a pnpm monorepo | Accepted |
| [0002](0002-fastify-undici.md) | Node.js + TypeScript, Fastify server, Undici forwarding | Accepted |
| [0003](0003-zod-static-config.md) | Zod-validated static configuration | Accepted |
| [0004](0004-local-token-bucket.md) | In-memory token bucket as the baseline limiter | Accepted |
| [0005](0005-redis-lua-limiter.md) | Redis Lua script for distributed rate limiting | Accepted |
| [0006](0006-postgres-off-hot-path.md) | PostgreSQL is not on the request path | Accepted |
| [0007](0007-bounded-safe-retries.md) | Retries are bounded and restricted by request semantics | Accepted |
| [0008](0008-per-upstream-breaker.md) | Circuit breakers scoped per upstream, in-memory | Accepted |
| [0009](0009-conservative-cache.md) | Conservative caching defaults with a bounded memory cache | Accepted |
| [0010](0010-pipeline-order.md) | Fixed request pipeline order | Accepted |
| [0011](0011-normalized-errors.md) | Typed, normalized gateway errors | Accepted |
| [0012](0012-defer-shared-state.md) | Defer shared caching and distributed breaker state | Accepted (deferral) |
| [0013](0013-routes-reference-upstream-id.md) | Routes reference upstreams by `upstreamId` | Accepted |
| [0014](0014-auth-config-shape.md) | Route auth is a nested `auth: { required }` object | Accepted |
| [0015](0015-breaker-config-location.md) | Circuit-breaker settings: global default, per-upstream override | Accepted |
| [0016](0016-retry-config-semantics.md) | `maxAttempts` counts total attempts; optional backoff fields | Accepted |
| [0017](0017-route-matching-and-forwarding.md) | Route matching and path forwarding rules | Accepted |
| [0018](0018-client-error-codes.md) | Error codes for oversized and malformed requests and responses | Accepted |
| [0019](0019-upstream-url-joining.md) | Upstream URL joining and query forwarding | Accepted |
| [0020](0020-admin-authentication.md) | Admin API on a separate port with a bearer token | Accepted |
| [0021](0021-header-forwarding.md) | Header forwarding and trusted-proxy rules | Accepted |
| [0022](0022-operations-listener.md) | Separate operations listener for health, readiness and metrics | Accepted |
| [0023](0023-no-websockets-v1.md) | No WebSocket or protocol-upgrade support in v1 | Accepted |
| [0024](0024-breaker-failure-classification.md) | Circuit-breaker failure classification and counting | Accepted |
| [0025](0025-monorepo-tooling.md) | Monorepo tooling and TypeScript module setup | Accepted |
| [0026](0026-config-schema-defaults.md) | Config schema defaults, bounds and validation behavior | Accepted (review) |
| [0027](0027-request-ids.md) | The gateway always generates its own request IDs | Accepted |
| [0028](0028-gateway-implementation-notes.md) | Phase 1 gateway implementation choices | Accepted (review) |
| [0029](0029-dev-environment.md) | Mock upstreams and Docker Compose dev environment | Accepted |
| [0030](0030-shutdown-and-readiness.md) | Bounded graceful shutdown and readiness scope | Accepted |
| [0031](0031-api-clients-and-keys.md) | API clients and keys | Accepted |
| [0032](0032-local-rate-limiting.md) | Local token-bucket rate limiting | Accepted |
| [0033](0033-retries-and-breakers.md) | Retry executor and circuit breakers (Phase 3) | Accepted (review details) |
| [0034](0034-redis-rate-limiting.md) | Redis-backed distributed rate limiting (Phase 4) | Accepted (reviewed) |
| [0035](0035-phase5-scope.md) | Phase 5 scope: cache partitioning, deduplication, observability | Accepted |
| [0036](0036-response-cache-and-metrics.md) | Response cache and Prometheus metrics (Phase 5) | Accepted (reviewed) |
| [0037](0037-dashboard.md) | Dashboard: admin API, rolling window, static hosting | Accepted |

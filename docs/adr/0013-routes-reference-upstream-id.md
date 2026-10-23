# ADR-0013: Routes reference upstreams by `upstreamId`

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** OPEN_QUESTIONS Q1; tech_impl §8, §10.1; system_design §8
- **Supersedes:** the route-level `upstream: "<url>"` field in the tech_impl §8 example config

## Context
The tech_impl §8 example put a URL directly on each route (`upstream: "http://orders-mock:4001"`) while
also defining a separate `upstreams` list, and both `RouteConfig` interfaces use `upstreamId`. The schema
needs a single way to bind a route to its destination before Phase 1 can start.

## Decision
`upstreamId` is **mandatory** on every route. Upstream URLs live only in a top-level `upstreams`
section. Inline URLs on routes are **not supported** in the Phase 1 schema.

```yaml
server:
  host: "0.0.0.0"
  port: 8080

upstreams:
  - id: orders-service
    baseUrl: "http://orders-mock:4001"
  - id: payments-service
    baseUrl: "http://payments-mock:4002"

routes:            # other route fields (auth, rateLimit, timeoutMs, retries, cache) omitted here
  - id: get-orders
    pathPrefix: "/api/orders"
    methods: ["GET"]
    upstreamId: orders-service
  - id: create-orders
    pathPrefix: "/api/orders"
    methods: ["POST"]
    upstreamId: orders-service
  - id: get-payments
    pathPrefix: "/api/payments"
    methods: ["GET"]
    upstreamId: payments-service
```

Validation rules (enforced by the Zod schema / loader at startup; any failure aborts startup with an actionable error):
1. Every `routes[].upstreamId` references an existing `upstreams[].id`.
2. Upstream ids are unique.
3. `baseUrl` is a valid URL with an allowed protocol — initially `http:` or `https:` only.
4. Upstream destinations come only from trusted configuration, never from an incoming request (SSRF guard).
5. Routes that share an upstream share that upstream's circuit-breaker state (consistent with ADR-0008).
6. Prefix stripping vs. preservation must be explicitly defined before the proxy is implemented (still open — Q7).

Component design:
- **HLD:** Route Registry → Upstream Registry → Reverse Proxy.
- **LLD:** `RouteConfig.upstreamId`; `UpstreamRegistry.getById(id)` resolves the destination;
  `ProxyService` forwards using the resolved upstream config.

## Alternatives considered
- **Inline URL on each route** — URL duplicated across routes, changes touch every route, no natural
  grouping for per-upstream breakers or health checks, and more places for unsafe destinations to slip in.
- **Allow both forms** — two code paths and ambiguous precedence for no Phase 1 benefit.

## Consequences
- One place to change a service URL; one allowlist of destinations to validate.
- Natural home for upstream-level settings: circuit breaker (Q4), health checks, future load balancing.
- Route ids and route matching are separate from upstream ids. The example has two routes with the same
  `pathPrefix` and different methods, so the route registry must match on **prefix + method** (feeds Q7).
- Required tests: valid resolution; unknown `upstreamId` rejected at startup; duplicate upstream ids rejected;
  disallowed protocol / malformed `baseUrl` rejected; multiple routes sharing one upstream (and one breaker).
- Interview angle: a central upstream registry makes the destination allowlist explicit and is a precondition
  for per-service reliability policies.

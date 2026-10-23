# ADR-0017: Route matching and path forwarding rules

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** OPEN_QUESTIONS Q7; tech_impl §8 ("the final schema must define…"); ADR-0013 rule 6
- **Extends:** ADR-0011 (adds `METHOD_NOT_ALLOWED`)

## Context
tech_impl §8 left prefix stripping, query forwarding and method matching undefined. ADR-0013 needs these
settled before the proxy is built, and its example has two routes on one prefix with different methods.

## Decision
1. **Prefix match on path segments.** `pathPrefix: /api/orders` matches `/api/orders` and `/api/orders/123`,
   but not `/api/ordersX`. The **longest** matching prefix wins.
2. **Then match the method** among the routes with that prefix. If the path matches but no route allows the
   method, respond **405** with error code `METHOD_NOT_ALLOWED` and an `Allow` header listing the allowed methods.
   No path match → 404 `ROUTE_NOT_FOUND`.
3. **Startup validation:** two routes with the same `pathPrefix` and an overlapping method fail startup.
4. **Prefix is preserved by default.** Optional per-route `stripPrefix: true` removes the matched prefix
   (`/api/orders/123` → `/123`, `/api/orders` → `/`). The forwarded path is appended to the upstream
   `baseUrl` path.
5. **Query strings are forwarded verbatim.**

## Alternatives considered
- **Strip the prefix by default** — surprising when upstreams already serve `/api/...` paths, and it hides
  the public path from upstream logs.
- **404 on method mismatch** — avoids a new error code but misleads clients ("route doesn't exist" when it does).

## Consequences
- `GatewayErrorCode` gains `METHOD_NOT_ALLOWED` (405); the rest of Q10 (413, 400, admin auth) stays open.
- Route registry index: prefix → set of methods → route.
- Tests: segment boundaries; longest-prefix wins; same prefix with GET/POST goes to different routes; 405
  with `Allow`; 404 when no prefix matches; overlapping prefix+method rejected at startup; `stripPrefix` on and off,
  including the bare prefix; query string forwarded unchanged; joining with a `baseUrl` that has a path.

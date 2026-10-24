# ADR-0039: Admin listener and API (dashboard step 2)

- **Status:** Accepted (implements the approved plan `docs/plans/dashboard.md` §5 and ADR-0020; details below to review)
- **Date:** 2026-10-24
- **Implements:** `apps/gateway/src/admin/{admin-server,admin-token}.ts`, StatsWindow wiring in `apps/gateway/src/app.ts`,
  `apps/gateway/test/admin.test.ts`

## Decisions made while implementing *(Claude-chosen within the plan)*
- **Enablement:** `createGateway({ adminToken })`, read from `ADMIN_TOKEN` in `main.ts`.
  - Unset **or empty**: no admin listener, no `StatsWindow` allocated, and one startup log line says so.
  - Shorter than 32 characters: `ConfigError` before any Redis connection is opened. The message names the variable and
    the length, never the token.
- **Token check:** `Authorization: Bearer <token>`, scheme case-insensitive, exactly one token with no inner whitespace.
  SHA-256 of both sides, then `timingSafeEqual`, so the length doesn't leak either. Only the digest is kept in memory.
- **One hook guards everything:** an app-level `onRequest` hook registered before any route, so it also covers unknown
  paths.
  - Without a valid token **every** request gets 401, including paths that don't exist. With one, unknown paths get
    404 `ROUTE_NOT_FOUND`.
  - `onRoute` records every registered route (`gateway.adminRoutes`) for the bypass test.
  - Step 3 adds the `/admin/ui/*` exemption here, explicitly.
- **Headers on every admin response:** `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (JSON only; step 3 sets the UI's CSP).
- **Logging:** one `admin request completed` line per request (method, path without query, status, duration, and
  `errorCode` on 401). Headers are never logged.
- **Recording:**
  - Each existing metrics call site also feeds the stats window (`stats?.…`), so both see the same events.
  - Completion and abort go through one `recordCompletion()` and are recorded exactly once.
  - A client abort is counted as `aborted`, with no status or latency sample (plan §2.3).
  - The proxy's attempt callback now also carries the route id.
- **`pulsegate_retries_total` now also counts retries of requests the client aborted.** It previously missed them on the
  abort path. The attempts happened, so counting them is more accurate, and it matches the stats window.
- **Endpoint shapes** follow `@pulsegate/admin-contract` exactly.
  - `/admin/api/cache` lists only cache-enabled routes.
  - `/admin/api/routes` is configuration only: no clients, keys or digests.
  - `backend.target` is the Redis host:port only; `degraded` is true when Redis is unhealthy under the fail-open policy.

## Contract fix found by the socket tests
- `retryRate` = retries ÷ requests that reached the upstream (plan §2.3), which can exceed 1. A route with
  `maxAttempts: 3` where every attempt fails has a rate of 2.
- The schema had it as a [0, 1] ratio. It is now `number ≥ 0 | null`, documented on the field.
- The dashboard must show it as "retries per request", not as a percentage.

## Verified (2026-10-24)
- **24 socket tests** (`admin.test.ts`):
  - **Enablement:** off without a token or with an empty one. A 31-character token fails startup and 32 is accepted.
    `start()` listens on the configured admin port.
  - **Every route is guarded:** the listener registers exactly the five GET routes (plus HEAD). Each of 7 bad
    credentials (none, wrong, prefix, `Basic`, no scheme, empty bearer, a valid client API key) gets 401 +
    `WWW-Authenticate: Bearer` on **every** registered route. Unknown paths get 401 without a token and 404 with one.
  - **Headers and logs:** security headers are set; one log line per request; the token and `Bearer` never appear in logs.
  - **Isolation:** `/admin/*` is 404 on the public and operations listeners.
  - **Contracts:** every endpoint's response validates against its shared schema after real traffic.
  - **Numbers match a known traffic mix sent over sockets:**
    - cache hit / miss / bypass / store, with the hit ratio excluding bypasses;
    - a 401 that never reaches the limiter;
    - a 429 rejection rate of 1/3;
    - 3 failed attempts with 2 retries (failure rate 1, retry rate 2);
    - an upstream failure rate of 3/8;
    - totals including an unmatched 404, and window = sum of buckets.
  - **Aborts and clocks:** a client abort is counted as aborted only; injected clocks place requests in the right 10 s
    buckets.
- **Mutations:** 6 new (47 in total), all caught: auth skipped for one route, short token accepted, any scheme accepted,
  stats allocated without a token, attempts not recorded, abort counted as a request.

## Consequences
- Step 3 serves `/admin/ui/*` without a token (static files only) and adds the UI CSP. The auth hook's exemption is
  limited to that prefix and is covered by the route-enumeration test.
- Docker/Compose wiring of `ADMIN_TOKEN` and the cross-container 401 check belong to step 6.

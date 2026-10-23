# ADR-0028: Phase 1 gateway implementation choices

- **Status:** Accepted (chosen by Claude during implementation; user to review)
- **Date:** 2026-10-23
- **Source:** Phase 1 `apps/gateway`; implements ADRs 0013, 0017–0024, 0027
- **Refines:** ADR-0019 step 3 (raw backslash), ADR-0016 (deadline scope)

## Decision

### Structure
`RouteRegistry` (ADR-0017) → `UpstreamRegistry` (one undici `Pool` per upstream, 128 connections) → `ProxyService`
(a single attempt; retries and breakers come in Phase 3), composed in `createGateway()` (`app.ts`). Pure helpers
(`parseRequestTarget`, `buildUpstreamHeaders`, `filterResponseHeaders`, `resolveClientAddress`, `upstreamTarget`)
are exported and unit-tested on their own.

### Request handling
- A Fastify catch-all (`all('/')`, `all('/*')` and the not-found handler) runs the same handler, so routing is entirely
  PulseGate's. Fastify's own URL errors (`frameworkErrors`) map to 400 `BAD_REQUEST`.
- All content-type parsers are removed: bodies are **streamed** to the upstream unparsed, and 413 is enforced while streaming.
- **Raw `\` in the path → 400** (in addition to ADR-0019): some upstreams treat it as `/`, which would reopen the
  dot-segment bypass. A request target that isn't origin-form (`*`, `http://…`) → 400.
- `Expect` is stripped before forwarding: undici rejects it, and Node has already answered `100-continue`.
- `Host` is set by undici from the upstream origin.
- **`timeoutMs` covers the whole exchange**, including streaming the response body. Past the deadline before
  headers → 504; after headers → the connection is aborted and logged as `UPSTREAM_TIMEOUT`.
- A client disconnect aborts the upstream call (`ClientAbortedError`); nothing is sent, and it's logged as `CLIENT_ABORTED`.

### Listeners and process
- Public and operations listeners as in ADR-0022. `/ready` returns 503 until `start()` finishes and again once
  `close()` begins. Shutdown is bounded by `server.shutdownTimeoutMs` (ADR-0030). **Not built yet:** `/metrics` (Phase 5) and the admin listener (needs admin endpoints; ADR-0020).
- `main.ts`: config path from **`PULSEGATE_CONFIG`** (default `config/routes.yaml`), log level from **`LOG_LEVEL`**
  (default `info`). A `ConfigError` prints its message and exits 1. SIGTERM/SIGINT drain the public listener,
  close the upstream pools, then the operations listener.
- Logging: Fastify's default request logs are off. Exactly one line per request (`request completed`) with
  `requestId`, `routeId`, `method`, path **without the query**, `statusCode`, `durationMs`, `errorCode`.
  No headers or bodies are logged.

## Consequences
- Every exit path (route errors, gateway 4xx, upstream failures, client aborts) produces one log line, so metrics in
  Phase 5 can hook into the same place.
- Bug found while testing: destroying an undici response body without an `error` listener throws an uncaught
  `AbortError`, which would crash the process. It is now guarded, and a test covers it.
- Second bug, found while verifying ADR-0029: Node's `stream.pipeline` callback gets `undefined` on success, but
  `@types/node` types it `Error | null`. An `!== null` check made **every successful response** log a false
  `response aborted mid-stream` warning. The fix is an `instanceof Error` check, and a log-capture test fails if a
  successful request logs anything other than one `request completed` line. Lesson: integration tests that run with
  the logger off can't see logging bugs.

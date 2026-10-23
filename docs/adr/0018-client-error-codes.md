# ADR-0018: Error codes for oversized and malformed requests and responses

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** OPEN_QUESTIONS Q10; tech_impl §12 (size limits); PRD FR-01
- **Extends:** ADR-0011 (and ADR-0017's `METHOD_NOT_ALLOWED`)

## Context
`GatewayErrorCode` had no codes for requests the gateway refuses before routing because of their own content.

## Decision
Add two codes to the normalized error registry:

| Code | HTTP | When |
|---|---|---|
| `PAYLOAD_TOO_LARGE` | 413 | The request body exceeds the configured request-size limit. |
| `BAD_REQUEST` | 400 | The request itself is malformed, e.g. dot segments or invalid percent-encoding in the path (ADR-0019), or unparseable headers or request line. |

Rules:
- Both are **client errors decided by the gateway** before contacting any upstream. They are never counted as
  upstream failures, never trip a circuit breaker and are never retried.
- An upstream's own 4xx response is passed through unchanged; it is not turned into a gateway error.
- An upstream response that is too large is **not** a 413 (413 describes the client's request). See
  *Oversized upstream responses* below.
- The config key and default for the request-size limit are chosen when `packages/config` is written, and
  recorded in an ADR at that point.

### Oversized upstream responses (amendment, 2026-10-23)
If an upstream response exceeds the gateway's configured **maximum response size**, the gateway returns
**502 with code `UPSTREAM_RESPONSE_TOO_LARGE`**. This is separate from cache `maxResponseBytes`: a response
too big for the cache is simply not cached (cache bypass), not an error.
- If `Content-Length` shows the limit is exceeded, return the 502 before sending any body.
- If a streamed body crosses the limit after the response has started, the status can no longer change:
  abort the client connection, and log and count the event under the same code.
- It counts as an upstream failure for metrics and as **exactly one circuit-breaker failure**, and is **not retried**
  by default (ADR-0024).
- The limit is enforced **while streaming** (bytes counted as they flow, never by buffering the full body); on a
  mid-stream violation the upstream read is terminated as well as the client response (ADR-0024).
- The config key and default for the response limit are chosen with the request limit.

Full registry after this ADR: `ROUTE_NOT_FOUND` 404, `METHOD_NOT_ALLOWED` 405, `BAD_REQUEST` 400,
`PAYLOAD_TOO_LARGE` 413, `AUTHENTICATION_FAILED` 401, `ADMIN_AUTHENTICATION_FAILED` 401 (ADR-0020),
`RATE_LIMIT_EXCEEDED` 429, `CIRCUIT_OPEN` 503, `UPSTREAM_TIMEOUT` 504, `UPSTREAM_UNAVAILABLE` 502, `UPSTREAM_RESPONSE_TOO_LARGE` 502, `INTERNAL_ERROR` 500.

## Consequences
- Metrics record these under a client-error outcome, separate from upstream errors.
- Tests: an oversized body gets 413 without an upstream call; a malformed path gets 400 without an upstream call;
  neither changes breaker state; an upstream 400 is passed through as-is; an upstream response over the limit
  gets 502 `UPSTREAM_RESPONSE_TOO_LARGE` (via Content-Length) or an aborted connection (mid-stream); a response over
  the cache limit only is served but not cached.
- Acceptance tests (added 2026-10-23): oversized response gets the 502 when nothing has been sent yet; the violation
  increments the breaker failure count exactly once and triggers no retry; a streamed oversized response is terminated
  safely without buffering the full body.

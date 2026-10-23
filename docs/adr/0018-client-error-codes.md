# ADR-0018: Error codes for oversized and malformed requests

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
- An upstream response that is too large is **not** a 413. It is handled by the response-size rules (cache
  `maxResponseBytes` and response limits), which are separate.
- The config key and default for the request-size limit are chosen when `packages/config` is written, and
  recorded in an ADR at that point.

Full registry after this ADR: `ROUTE_NOT_FOUND` 404, `METHOD_NOT_ALLOWED` 405, `BAD_REQUEST` 400,
`PAYLOAD_TOO_LARGE` 413, `AUTHENTICATION_FAILED` 401, `ADMIN_AUTHENTICATION_FAILED` 401 (ADR-0020),
`RATE_LIMIT_EXCEEDED` 429, `CIRCUIT_OPEN` 503, `UPSTREAM_TIMEOUT` 504, `UPSTREAM_UNAVAILABLE` 502, `INTERNAL_ERROR` 500.

## Consequences
- Metrics record these under a client-error outcome, separate from upstream errors.
- Tests: an oversized body gets 413 without an upstream call; a malformed path gets 400 without an upstream call;
  neither changes breaker state; an upstream 400 is passed through as-is.

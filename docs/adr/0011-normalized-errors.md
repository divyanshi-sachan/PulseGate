# ADR-0011: Typed, normalized gateway errors

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** system_design §14, tech_impl §4.2

## Decision
All gateway-generated errors are a GatewayError with a stable code, HTTP status and requestId, serialized as {error:{code,message,requestId}}. Codes: ROUTE_NOT_FOUND 404, AUTHENTICATION_FAILED 401, RATE_LIMIT_EXCEEDED 429, CIRCUIT_OPEN 503, UPSTREAM_TIMEOUT 504, UPSTREAM_UNAVAILABLE 502, INTERNAL_ERROR 500. No stack traces to clients.

## Consequences
Predictable client contract; diagnostics go to structured logs. Additional codes pending OPEN_QUESTIONS Q10.

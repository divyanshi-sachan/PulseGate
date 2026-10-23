# ADR-0015: Circuit-breaker settings: global default, per-upstream override

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** OPEN_QUESTIONS Q4; tech_impl §6; builds on ADR-0008 and ADR-0013

## Context
tech_impl §6 shows `circuitBreaker` settings but no schema placed them. Breakers are per upstream
(ADR-0008) and routes sharing an upstream share its breaker (ADR-0013).

## Decision
A top-level `circuitBreaker` block sets defaults; any `upstreams[]` entry may override individual fields.
Routes cannot set breaker settings.

```yaml
circuitBreaker:            # global defaults
  failureThreshold: 5
  openDurationMs: 10000
  halfOpenMaxRequests: 1

upstreams:
  - id: payments-service
    baseUrl: "http://payments-mock:4002"
    circuitBreaker:        # optional, field-by-field override
      failureThreshold: 3
```

If the top-level block is omitted, the values above are the built-in defaults. The effective settings are
resolved once at startup (default ⊕ override) and validated (positive integers).

## Alternatives considered
- **Upstream entry only** — repetitive; every upstream must restate the same numbers.
- **Global only** — no way to tune a known-flaky or slow upstream.
- **Per route** — contradicts shared per-upstream breaker state.

## Consequences
- `CircuitBreakerRegistry` is built from the resolved per-upstream settings.
- Tests: defaults applied when omitted; partial override merges field by field; invalid values fail startup.
- The half-open success threshold (Q11) and failure-counting rule (Q12) are still open.

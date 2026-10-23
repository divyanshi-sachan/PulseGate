# ADR-0007: Retries are bounded and restricted by request semantics

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** system_design §7.5, §11; tech_impl §4.3

## Decision
Retry only transient failures (connection errors, configured statuses), within maxAttempts and the remaining request deadline, using exponential backoff with full jitter and cancellation. Non-idempotent methods are not retried unless an explicit idempotency mechanism is configured. Client-visible request counted once; upstream attempts counted separately.

## Consequences
Prevents retry storms amplifying outages. Tests: attempt budget, backoff bounds, deadline, POST not retried, cleanup on cancel.

# ADR-0008: Circuit breakers scoped per upstream, in-memory

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** system_design §7.6, §10; tech_impl §6

## Decision
CircuitBreakerRegistry holds one breaker per upstream (State pattern: closed/open/half-open). Bounded half-open probes, centralized transitions, every transition logged and metered. Ordinary 4xx are not availability failures. State is per instance in MVP.

## Consequences
One bad upstream can't affect other routes. Distributed breaker state is explicitly not claimed (see ADR-0012).

# ADR-0010: Fixed request pipeline order

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** system_design §13, tech_impl §4.1

## Decision
validate → route match → auth → rate limit → cache lookup → breaker check → upstream (timeout+retry inside) → cache write → observe. Auth precedes client-keyed limiting; limiting precedes cache so hits can't bypass policy; breaker is only consulted when an upstream call is needed.

## Consequences
Ordering is part of the contract and gets its own tests (early exits, cleanup, metrics on every exit).

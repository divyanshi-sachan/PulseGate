# ADR-0012: Defer shared caching and distributed breaker state

- **Status:** Accepted (deferral)
- **Date:** 2026-10-23
- **Source:** system_design §6, §7.8; tech_impl §7.3

## Decision
MVP keeps cache entries and circuit-breaker state local to each instance. Redis-backed caching or
breaker coordination is introduced only when (a) the local version has tests and benchmark evidence and
(b) a measured problem — e.g. low hit ratio across instances, or inconsistent isolation of a failing upstream —
justifies it. Each would get its own ADR with consistency and invalidation semantics.

## Consequences
Simpler MVP with honest guarantees; docs and interviews must state these boundaries explicitly.

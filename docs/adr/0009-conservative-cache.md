# ADR-0009: Conservative caching defaults with a bounded memory cache

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** system_design §7.7, §12; tech_impl §7

## Decision
MemoryResponseCache behind a ResponseCache strategy: GET + successful responses only, TTL, max entries, max response bytes; respect private/no-store; Authorization-bearing requests bypass by default; keys = route + method + normalized path + relevant query + configured vary headers, never credentials.

## Consequences
Correctness and privacy over hit ratio. Client partitioning on authenticated routes is still open (OPEN_QUESTIONS Q6).

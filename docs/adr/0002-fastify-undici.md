# ADR-0002: Node.js + TypeScript, Fastify server, Undici forwarding

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** tech_impl §1

## Decision
Gateway runs on Node.js/TypeScript with Fastify (typed hooks, inject-based tests) and Undici for upstream calls (explicit timeouts, pooling, AbortSignal).

## Consequences
Pipeline is expressed as typed Fastify hooks plus explicit service calls rather than a mutable middleware array (system_design §13).

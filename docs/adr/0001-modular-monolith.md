# ADR-0001: Modular monolith in a pnpm monorepo

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** system_design §7.1, tech_impl §3

## Decision
One deployable gateway process composed from small workspace packages (config, rate-limiter, cache, reliability, observability, shared). No microservices.

## Consequences
Low latency (no internal network hops), simple deploy, clean seams for testing. Packages must expose narrow interfaces so they could be extracted later.

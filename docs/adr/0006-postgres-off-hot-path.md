# ADR-0006: PostgreSQL is not on the request path

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** system_design §7.4, tech_impl §1

## Decision
No PostgreSQL in MVP. When introduced, it holds only durable control-plane data (api_clients, routes, policies, audit_events) — never token-bucket state or raw request history.

## Consequences
Request latency is independent of DB health; MVP runs with config files only.

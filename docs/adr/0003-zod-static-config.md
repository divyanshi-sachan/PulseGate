# ADR-0003: Zod-validated static configuration

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** tech_impl §1, §8; PRD FR-08

## Decision
Routes, upstreams and policies come from YAML/JSON validated by Zod at startup; TS types are inferred from the schema. Invalid config fails startup with actionable errors. Config is read-only at runtime (no hot reload in MVP). Secrets only via env.

## Consequences
Deterministic, reproducible setups. Dynamic config / DB-backed management is a later control-plane phase.

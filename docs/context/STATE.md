# Project State

_Last updated: 2026-10-23 (gateway proxy)_

## Current phase
**Phase 1 — Gateway foundation, in progress.** pnpm monorepo scaffolded (ADR-0025); `packages/shared` holds
the normalized error registry; `packages/config` validates and loads config (ADR-0026); `apps/gateway` proxies
configured routes with health/ready (ADR-0028). `pnpm check` passes (113 tests).

## Done
- Product, system-design and implementation specs written.
- ADRs 0001–0012 seeded from decisions already stated in the specs.
- Config schema decisions settled: ADR-0013 (upstreamId, Q1), 0014 (auth shape, Q2), 0015 (breaker config, Q4),
  0016 (retry semantics, Q5), 0017 (route matching/forwarding, Q7).
- Error registry + admin auth (ADR-0018, 0020; Q10) and exact upstream URL joining (ADR-0019) settled.
- Header forwarding (ADR-0021, Q16) and operations listener (ADR-0022, Q15) settled; ADR-0018 amended with
  `UPSTREAM_RESPONSE_TOO_LARGE`. **Phase 1 is fully unblocked.**
- No WebSockets in v1 (ADR-0023) and breaker failure rules (ADR-0024, Q12) settled; Phase 3 needs only Q11 now.
- Spec gaps/conflicts catalogued in OPEN_QUESTIONS.md.
- Monorepo scaffold: TS 6.0.3 strict, ESLint 10 + typescript-eslint, Prettier, Vitest 5; `packages/shared` with
  `GatewayError` + registry and 5 tests (ADR-0025).
- `packages/config`: schema for ADRs 0013–0024, loader (YAML/JSON), actionable `ConfigError`, example config, 51 tests (ADR-0026).
- `apps/gateway`: routing, header forwarding, streaming size limits, timeouts, upgrade rejection, ops listener; 57 tests (ADR-0027, 0028).

## Next up (Phase 1 — Gateway foundation, technical_implementation.md §14)
0. Review ADR-0026 defaults and ADR-0028 implementation choices (backslash → 400, deadline covers body streaming).
1. `examples/mock-upstreams` (delay/reset/5xx/oversized modes) + Docker Compose dev environment; then Phase 1 is done.
2. Phase 2: API-key auth (needs a design for client/key config) + local token-bucket limiter.

Exit criteria: a client can call a configured route and receive the correct upstream response.

## Blockers / risks
- Later phases still need Q3, Q6, Q8, Q9, Q11 (see OPEN_QUESTIONS.md).
- Repo: `main` tracks `origin` (github.com/divyanshi-sachan/PulseGate). The user commits and pushes (see CLAUDE.md › Git workflow).

# Project State

_Last updated: 2026-10-23 (Phase 1 complete)_

## Current phase
**Phase 1 — Gateway foundation: complete** (exit criterion verified in Docker). Next is **Phase 2 — API-key auth and
local rate limiting** (technical_implementation.md §14).

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
- `examples/mock-upstreams` (8 tests), Dockerfile, docker-compose.yml, README quickstart (ADR-0029, accepted after review).
- Bounded graceful shutdown + readiness scope (ADR-0030); false mid-stream warning fixed. `pnpm check`: 129 tests.

## Next up (Phase 2 — Local rate limiting and authentication, technical_implementation.md §14)
0. Review the Claude-chosen ADRs: 0026 (config defaults), 0028 (gateway choices).
1. Design API clients and key config (open: how keys are supplied via env/secrets file, hashing, rotation; PRD FR-02) → ADR.
2. Auth middleware: `X-API-Key` → client identity, 401 `AUTHENTICATION_FAILED`, never log keys.
3. Token-bucket `RateLimiter` interface + `LocalTokenBucketLimiter` (injected clock, bounded keys, idle eviction; ADR-0004),
   rate-limit headers (Q9) and the unauthenticated-route key (Q8).
4. Wire into the pipeline after auth, before the proxy (ADR-0010).

Exit criteria: concurrent tests demonstrate correct local bucket behavior.

## Blockers / risks
- Later phases still need Q3, Q6, Q8, Q9, Q11 (see OPEN_QUESTIONS.md).
- Repo: `main` tracks `origin` (github.com/divyanshi-sachan/PulseGate). The user commits and pushes (see CLAUDE.md › Git workflow).

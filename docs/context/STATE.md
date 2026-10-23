# Project State

_Last updated: 2026-10-23 (Phase 2 complete)_

## Current phase
**Phase 2 — Auth and local rate limiting: complete** (verified in Docker). Next is **Phase 3 — Reliability
middleware** (timeouts already exist; add bounded retries, per-upstream circuit breakers and fault-injection tests).

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
- Phase 2: clients file + `pnpm keygen` (ADR-0031), `ApiKeyAuthenticator`, `packages/rate-limiter` with
  `LocalTokenBucketLimiter`, rate-limit headers and 429 (ADR-0032); review hardening tests added. `pnpm check`: 183 tests.

## Next up (Phase 3 — Reliability middleware, technical_implementation.md §14)
0. Review the Claude-chosen ADRs: 0026 (config defaults), 0028 (gateway choices).
1. Decide Q11 (half-open → closed success threshold) and Q3 (breaker state naming).
2. Retry executor (ADR-0007, 0016): attempts within the deadline, full-jitter backoff (injected random), idempotent methods only,
   upstream-returned statuses only (ADR-0024).
3. `CircuitBreaker` + `CircuitBreakerRegistry` (State pattern, ADR-0008/0015/0024): checked before every attempt, 503 `CIRCUIT_OPEN`,
   transitions logged.
4. Fault-injection integration tests using `_failRate`/`_reset`/`_delay` upstream modes.

Exit criteria: an unhealthy upstream can be isolated without crashing the gateway.

## Blockers / risks
- Later phases still need Q3, Q6, Q8, Q9, Q11 (see OPEN_QUESTIONS.md).
- Repo: `main` tracks `origin` (github.com/divyanshi-sachan/PulseGate). The user commits and pushes (see CLAUDE.md › Git workflow).

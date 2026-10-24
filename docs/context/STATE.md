# Project State

_Last updated: 2026-10-23 (Phase 4 complete)_

## Current phase
**Phase 4 — Redis-backed distributed rate limiting: complete** (exit criterion verified in Docker). Next is
**Phase 5 — Caching and observability** (technical_implementation.md §14).

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
- Phase 3: `packages/reliability` (breaker State machine with permits, retry policy), executor in ProxyService
  (attempt timeouts, full-jitter retries for GET/HEAD/OPTIONS, 503 CIRCUIT_OPEN), normalized parser errors (ADR-0033). 223 tests; review added retained-response and socket tests (229).
- Phase 4: Lua token bucket on Redis server time, `ResilientRateLimiter` (fail-closed 503 / fail-open degraded local),
  Redis readiness ping, `packages/testing`, `pnpm dev:distributed` (ADR-0034).
- ADR-0034 review: startup fails without Redis, credential redaction, single-flight readiness with status body, TTL lower
  bound; CI workflow + automated mutation suite (16 mutations) + distributed smoke script. 253 tests.

## Next up (Phase 5 — Caching and observability, technical_implementation.md §14)
0. Review Claude-chosen details: ADR-0026, 0028, 0033 (Retry-After on CIRCUIT_OPEN, held responses, body-end settlement).
   CI has not run on GitHub yet: check the first run after pushing.
1. Q6 and Q13 decided (ADR-0035): per-client cache keys + shared opt-in; dedup deferred.
2. Bounded in-memory response cache (ADR-0009): eligibility, key composition, TTL, size limits, hit/miss/eviction counters.
3. Prometheus `/metrics` on the operations listener (tech_impl §11 names, bounded labels); hook into the request log points.
4. Then, as its own step: React dashboard on top of the metrics (ADR-0035).

Exit criteria: dashboard data matches the gateway's observed behavior in integration tests.

## Blockers / risks
- Later phases still need Q3, Q6, Q8, Q9, Q11 (see OPEN_QUESTIONS.md).
- Repo: `main` tracks `origin` (github.com/divyanshi-sachan/PulseGate). The user commits and pushes (see CLAUDE.md › Git workflow).

# Project State

_Last updated: 2026-10-24 (Phase 5 complete: cache, metrics, dashboard)_

## Current phase
**Phase 5 — Caching and observability: complete** (cache, `/metrics`, admin API and dashboard; ADR-0036–0043).
The dashboard e2e passes locally against Docker; the new CI `e2e` job runs on the next push. Next: **Phase 6**, starting with
**testing on real data** per `docs/plans/real-data-testing.md` (approved): step 1, deterministic Docker faults F1–F6,
is **done** (ADR-0044); step 2, real public API smoke tests R1–R9, is **done** (ADR-0045, opt-in `pnpm test:real`);
next is step 3, the k6 suite against the mocks. License and release work deferred.

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
- Phase 5: `packages/cache` (per-client keys, shared opt-in, tee-on-miss, LRU by entries+bytes), `packages/observability`
  (`/metrics`, bounded labels), X-Cache/Age headers (ADR-0036). 294 tests, 21 mutations. First CI run green.
- ADR-0036 review: freshness gaps fixed (Expires, Age, malformed max-age, response Pragma, receipt time); review tests
  for memory/streaming/metrics; 312 tests, 25 mutations.

## Dashboard plan (`docs/plans/dashboard.md`, approved 2026-10-24): all steps done
0. Review Claude-chosen details: ADR-0026, 0028, 0033.
1. ~~Contracts + `StatsWindow` + benchmark~~ **done** (ADR-0038).
2. ~~Admin listener (ADR-0020), auth, `/admin/api/*` endpoints + socket tests~~ **done** (ADR-0039).
3. ~~Static UI serving + security headers~~ **done** (ADR-0040).
4. ~~`apps/dashboard` scaffold, tokens, API client, token gate, bundle budget~~ **done** (ADR-0041; Recharts comes with step 5).
5. ~~Charts + `chart-data` + screens + component/contract tests; re-measure the bundle~~ **done** (ADR-0042: 94.6 / 203.9 KB gz, Recharts kept).
6. ~~Compose dashboard override + Playwright e2e + CI + Docker verification + docs~~ **done** (ADR-0043).

**Phase 5 exit criterion met** (socket tests + Playwright against Docker). Next: **Phase 6, release and benchmarks**.

Exit criteria: dashboard data matches the gateway's observed behavior in integration tests.

## Blockers / risks
- No open questions block current work (OPEN_QUESTIONS.md: all resolved).
- Repo: `main` tracks `origin` (github.com/divyanshi-sachan/PulseGate). The user commits and pushes (see CLAUDE.md › Git workflow).

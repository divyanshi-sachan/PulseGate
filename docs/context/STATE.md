# Project State

_Last updated: 2026-10-23 (scaffold)_

## Current phase
**Phase 1 — Gateway foundation, in progress.** pnpm monorepo scaffolded (ADR-0025); `packages/shared` holds
the normalized error registry. `pnpm check` passes.

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

## Next up (Phase 1 — Gateway foundation, technical_implementation.md §14)
1. `packages/config`: Zod schema + loader with actionable validation errors, implementing ADRs 0013–0024 (incl. `forwarding`, `trustedProxies`, three listeners).
2. `apps/gateway`: Fastify server, route registry (segment-aware longest prefix + method, ADR-0017) → UpstreamRegistry → ProxyService via Undici (raw-path joining ADR-0019, header rules ADR-0021), request IDs, structured logs.
3. `examples/mock-upstreams` + Docker Compose dev environment.

Exit criteria: a client can call a configured route and receive the correct upstream response.

## Blockers / risks
- None for Phase 1 (Q17 `X-Request-ID` handling is small; decide while building request IDs).
- Later phases still need Q3, Q6, Q8, Q9, Q11 (see OPEN_QUESTIONS.md).
- Repo: `backend/` has its own git repo on `main` (no remote yet).

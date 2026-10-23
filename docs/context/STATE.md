# Project State

_Last updated: 2026-10-23_

## Current phase
**Phase 0 — Planning / pre-scaffold.** Specs exist (prd.md, system_design_specification.md,
technical_implementation.md). No code yet. Claude agentic setup (hooks, ADRs, context docs) is in place.

## Done
- Product, system-design and implementation specs written.
- ADRs 0001–0012 seeded from decisions already stated in the specs.
- Config schema decisions settled: ADR-0013 (upstreamId, Q1), 0014 (auth shape, Q2), 0015 (breaker config, Q4),
  0016 (retry semantics, Q5), 0017 (route matching/forwarding, Q7).
- Error registry + admin auth (ADR-0018, 0020; Q10) and exact upstream URL joining (ADR-0019) settled.
- Spec gaps/conflicts catalogued in OPEN_QUESTIONS.md.

## Next up (Phase 1 — Gateway foundation, technical_implementation.md §14)
0. Decide Q16 (header forwarding) before building ProxyService; Q15 (health/metrics port) before wiring listeners.
1. Scaffold pnpm monorepo (TS strict, Vitest, ESLint, Prettier) and fill in commands in CLAUDE.md.
2. `packages/config`: Zod schema + loader with actionable validation errors, implementing ADRs 0013–0020.
3. `apps/gateway`: Fastify server, route registry (segment-aware longest prefix + method, ADR-0017) → UpstreamRegistry → ProxyService via Undici (raw-path joining, ADR-0019), request IDs, structured logs.
4. `examples/mock-upstreams` + Docker Compose dev environment.

Exit criteria: a client can call a configured route and receive the correct upstream response.

## Blockers / risks
- Q16 blocks the proxy step of Phase 1. Later phases still need Q3, Q6, Q8, Q9, Q11, Q12 (see OPEN_QUESTIONS.md).
- Repo: `backend/` has its own git repo on `main` (no remote yet).

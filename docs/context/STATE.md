# Project State

_Last updated: 2026-10-23_

## Current phase
**Phase 0 — Planning / pre-scaffold.** Specs exist (prd.md, system_design_specification.md,
technical_implementation.md). No code yet. Claude agentic setup (hooks, ADRs, context docs) is in place.

## Done
- Product, system-design and implementation specs written.
- ADRs 0001–0012 seeded from decisions already stated in the specs.
- Config schema decisions settled: ADR-0013 (upstreamId, Q1), 0014 (auth shape, Q2), 0015 (breaker config, Q4),
  0016 (retry semantics, Q5), 0017 (route matching/forwarding, Q7). Phase 1 is unblocked.
- Spec gaps/conflicts catalogued in OPEN_QUESTIONS.md.

## Next up (Phase 1 — Gateway foundation, technical_implementation.md §14)
1. Scaffold pnpm monorepo (TS strict, Vitest, ESLint, Prettier) and fill in commands in CLAUDE.md.
2. `packages/config`: Zod schema + loader with actionable validation errors, implementing ADRs 0013–0017.
3. `apps/gateway`: Fastify server, route registry (segment-aware longest prefix + method, ADR-0017) → UpstreamRegistry → ProxyService via Undici, request IDs, structured logs.
4. `examples/mock-upstreams` + Docker Compose dev environment.

Exit criteria: a client can call a configured route and receive the correct upstream response.

## Blockers / risks
- None for Phase 1. Later phases still need Q3, Q6, Q8–Q12 (see OPEN_QUESTIONS.md).
- Repo: `backend/` has its own git repo on `main` (no remote yet).

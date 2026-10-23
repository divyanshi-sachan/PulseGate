# Project State

_Last updated: 2026-10-23_

## Current phase
**Phase 0 — Planning / pre-scaffold.** Specs exist (prd.md, system_design_specification.md,
technical_implementation.md). No code yet. Claude agentic setup (hooks, ADRs, context docs) is in place.

## Done
- Product, system-design and implementation specs written.
- ADRs 0001–0012 seeded from decisions already stated in the specs.
- ADR-0013: routes reference upstreams by `upstreamId` (Q1 resolved).
- Spec gaps/conflicts catalogued in OPEN_QUESTIONS.md.

## Next up (Phase 1 — Gateway foundation, technical_implementation.md §14)
1. Resolve remaining blocking open questions for config schema: Q2, Q4, Q5, Q7 (Q7 must precede the proxy).
2. Scaffold pnpm monorepo (TS strict, Vitest, ESLint, Prettier) and fill in commands in CLAUDE.md.
3. `packages/config`: Zod schema + loader with actionable validation errors, incl. ADR-0013 upstream rules.
4. `apps/gateway`: Fastify server, route registry (prefix + method) → UpstreamRegistry → ProxyService via Undici, request IDs, structured logs.
5. `examples/mock-upstreams` + Docker Compose dev environment.

Exit criteria: a client can call a configured route and receive the correct upstream response.

## Blockers / risks
- None. (`backend/` now has its own git repo on `main`.)

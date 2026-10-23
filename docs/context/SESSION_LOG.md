# Session Log

Append-only. Newest entry at the **bottom**. One entry per working session, written by `/handoff`.
Format: date · goal · what changed · decisions (ADR links) · open threads.

---

## 2026-10-23 · Project read-through + agentic setup
- **Goal:** understand the three spec documents and set up Claude Code context sharing.
- **Changed:** added CLAUDE.md, docs/context/{STATE,SESSION_LOG,OPEN_QUESTIONS}.md, docs/adr/ (template + ADR 0001–0012),
  .claude/settings.json with hooks (SessionStart context injection, secret guard, edit tracking, Stop handoff reminder),
  slash commands /adr /handoff /spec-check, and a `spec-reviewer` subagent.
- **Decisions:** seeded ADRs from the specs; no new design decisions taken.
- **Open threads:** 14 open questions logged (config schema shape is the first blocker). Repo got its own `git init` on `main`; initial commit contains specs + Claude setup.

## 2026-10-23 · Decide Q1: route → upstream binding
- **Goal:** settle how routes reference upstream services.
- **Changed:** git repo initialized in `backend/` with the first commit (088f5e2). Added ADR-0013; updated ADR index,
  OPEN_QUESTIONS (Q1 resolved, notes added to Q4 and Q7), CLAUDE.md security invariant, STATE next steps.
- **Decisions:** [ADR-0013](../adr/0013-routes-reference-upstream-id.md): mandatory `upstreamId`, URLs only in top-level
  `upstreams[]`, http/https only, unique ids, unknown ids fail startup, shared upstream = shared breaker.
- **Open threads:** Q2, Q4, Q5, Q7 still block the config schema; route matching must handle same prefix + different methods.

## 2026-10-23 · Decide Q2, Q4, Q5, Q7: rest of the config schema
- **Goal:** unblock Phase 1 by settling the remaining config-schema questions (all recommended options chosen).
- **Changed:** ADR-0013 committed (71f3b2a). Added ADRs 0014–0017; updated ADR index, OPEN_QUESTIONS (four moved to Resolved,
  Q10 narrowed), CLAUDE.md invariants (405, maxAttempts meaning), STATE next steps.
- **Decisions:** [0014](../adr/0014-auth-config-shape.md) nested `auth: { required }`;
  [0015](../adr/0015-breaker-config-location.md) global `circuitBreaker` defaults + per-upstream override;
  [0016](../adr/0016-retry-config-semantics.md) `maxAttempts` = total attempts, optional backoff fields;
  [0017](../adr/0017-route-matching-and-forwarding.md) segment-aware longest-prefix + method, 405 + `Allow`, preserve prefix, verbatim query.
- **Open threads:** Phase 1 unblocked; next is the monorepo scaffold. Q3, Q6, Q8–Q14 remain for later phases.

## 2026-10-23 · Q10 error codes, admin auth, URL joining
- **Goal:** finish Q10 and lock down base-path joining + query handling before Phase 1 (user request).
- **Changed:** ADRs 0014–0017 committed (46f7823). Added ADRs 0018–0020; updated ADR index, OPEN_QUESTIONS
  (Q10 resolved, new Q15 and Q16), CLAUDE.md error/security invariants, STATE next steps.
- **Decisions:** [0018](../adr/0018-client-error-codes.md) 400 `BAD_REQUEST` / 413 `PAYLOAD_TOO_LARGE` are gateway-decided
  client errors, never upstream failures; [0019](../adr/0019-upstream-url-joining.md) raw `basePath + path`, dot segments → 400,
  `baseUrl` path-only, query byte-for-byte; [0020](../adr/0020-admin-authentication.md) admin on a separate port (default 9090)
  with `ADMIN_TOKEN` bearer, disabled when unset, 401 `ADMIN_AUTHENTICATION_FAILED`.
- **Open threads:** Q16 (header forwarding, incl. stripping `X-API-Key`) now blocks the proxy; Q15 (health/metrics port) is needed
  before wiring listeners. Request-size limit key/default to be chosen with the config schema.

## 2026-10-23 · Q15/Q16: header forwarding, operations listener
- **Goal:** record the user's final decisions on header forwarding and health/metrics ports, plus the oversized-response error.
- **Changed:** ADRs 0018–0020 committed (f3fea23). Amended ADR-0018; added ADRs 0021–0022; updated ADR index,
  OPEN_QUESTIONS (Q15, Q16 resolved; Q8 narrowed; new Q17), CLAUDE.md invariants (headers, listeners, 502 code), STATE.
- **Decisions:** [0018](../adr/0018-client-error-codes.md) amended: 502 `UPSTREAM_RESPONSE_TOO_LARGE` (abort if mid-stream; cache limit = bypass only);
  [0021](../adr/0021-header-forwarding.md) strip hop-by-hop + `X-API-Key`, `Authorization` opt-in via `forwarding.authorization`,
  `X-Forwarded-*` rebuilt from `server.trustedProxies`; [0022](../adr/0022-operations-listener.md) ops listener 9091 on 127.0.0.1, always on.
- **Open threads:** Phase 1 fully unblocked. Config names `forwarding.{authorization,forwardedHost}` were chosen by Claude. Q17 (request-ID handling) is new.

## 2026-10-23 · Q12 breaker failures, no WebSockets
- **Goal:** record the user's Q12 resolution, the no-WebSocket scope and the acceptance tests from their review.
- **Changed:** ADRs 0021–0022 committed (f9257c7). Added ADRs 0023–0024; amended 0015, 0016, 0018, 0021 (cross-refs and
  acceptance tests); updated ADR index, OPEN_QUESTIONS (Q12 resolved), CLAUDE.md invariants, STATE.
- **Decisions:** [0023](../adr/0023-no-websockets-v1.md) upgrades/h2c/CONNECT get an explicit 400 via Node `upgrade`/`connect`
  handlers, never 101; [0024](../adr/0024-breaker-failure-classification.md) consecutive failures per attempt, breaker checked
  before every retry, `failureStatuses` default [500,502,503,504], `UPSTREAM_RESPONSE_TOO_LARGE` counts once and isn't retried,
  client aborts don't count, size limit enforced while streaming.
- **Open threads:** Claude-chosen details to confirm: `failureStatuses` default, CONNECT handling, upstream 101 → 502,
  last error returned when breaker opens mid-retry. Remaining open: Q3, Q6, Q8, Q9, Q11, Q13, Q14, Q17.

## 2026-10-23 · Phase 1: monorepo scaffold
- **Goal:** set up the pnpm monorepo (TS strict, Vitest, ESLint, Prettier) and the real commands in CLAUDE.md.
- **Changed:** ADRs 0023–0024 committed (4cb55ec). Added root package.json, pnpm-workspace.yaml, tsconfig.base/json,
  eslint.config.js, vitest.config.ts, Prettier/EditorConfig files, pnpm-lock.yaml; `packages/shared` (error registry from
  ADR-0018 + `GatewayError`, 5 tests). Prettier reformatted .claude/settings.json (whitespace only). CLAUDE.md Commands filled in.
- **Decisions:** [ADR-0025](../adr/0025-monorepo-tooling.md): TS 6.0.3 (not 7, since typescript-eslint supports only <6.1), ESM,
  `.ts` imports + `erasableSyntaxOnly` + `rewriteRelativeImportExtensions`, `@pulsegate/source` export condition, single root configs.
- **Verified:** `pnpm check` passes (format, lint, typecheck, 5 tests); `pnpm build` emits dist with `.js` imports;
  Node 26 runs package source directly. Cross-package source resolution not exercised yet (no consumer package).
- **Open threads:** next is `packages/config` (Zod schema for ADRs 0013–0024; pick request/response size-limit keys).

## 2026-10-23 · Phase 1: packages/config
- **Goal:** Zod schema + loader implementing ADRs 0013–0024, with actionable errors and tests.
- **Changed:** scaffold committed (22bc791). Added `packages/config` (schema.ts, errors.ts, loader.ts, 2 test files; deps zod 4.6.7,
  yaml 2.9.1) and `config/routes.example.yaml`; ADR-0026; ADR index, CLAUDE.md, STATE updated.
- **Decisions:** [ADR-0026](../adr/0026-config-schema-defaults.md), **chosen by Claude, pending user review**: size-limit keys under
  `server.limits` (1 MiB / 10 MiB), admin bind 127.0.0.1, `auth.required` default true, `rateLimit` required per route,
  `maxAttempts` default 1, bounds, method list, pathPrefix charset, strict unknown keys with legacy-key hints, frozen output.
- **Verified:** `pnpm check` (56 tests) and `pnpm build` pass; a sample bad file yields 6 readable issues without echoing the URL password.
- **Open threads:** cross-field errors only show once per-field errors are fixed (Zod limitation, documented). API-client/key config
  is not designed yet (Phase 2). Next: `apps/gateway` (first consumer of the `@pulsegate/source` condition).

## 2026-10-23 · Commit workflow change
- **Changed:** user committed `packages/config` as 991a3a6 and pushed to origin (github.com/divyanshi-sachan/PulseGate).
  Added "Git workflow" to CLAUDE.md; STATE repo note updated.
- **Decisions:** from now on Claude gives commit commands and waits for the user to commit; Claude doesn't commit or push.

## 2026-10-23 · Phase 1: apps/gateway proxy
- **Goal:** Fastify server, RouteRegistry, UpstreamRegistry and ProxyService.
- **Changed:** user committed the workflow docs. Added `apps/gateway` (routing/, proxy/, app.ts, main.ts; fastify 5.12.7, undici 8.12.3),
  unit tests in src/ and integration tests + harness in test/; vitest/tsconfig now include `*/test/`. ADRs 0027, 0028; ADR-0019 note;
  Q17 resolved; CLAUDE.md, STATE updated.
- **Decisions:** [0027](../adr/0027-request-ids.md) (user: always generate request IDs); [0028](../adr/0028-gateway-implementation-notes.md)
  (Claude, pending review): backslash → 400, Expect stripped, deadline covers body streaming, PULSEGATE_CONFIG/LOG_LEVEL, one log line per request.
- **Verified:** `pnpm check` (113 tests, stable over 3 runs), `pnpm build`; smoke run of `main.ts` with the example config: health/ready OK,
  502 for an unreachable upstream, 404 normalized, clean SIGTERM, API key absent from logs. Cross-package `@pulsegate/source` resolution works.
- **Bug fixed:** destroying an oversized undici body without an error listener crashed the process (found by tests).
- **Open threads:** `/metrics` and the admin listener not built yet; the mid-stream oversized test accepts either a reset or a truncated body.

## 2026-10-23 · Phase 1 complete: mock upstreams + Docker Compose
- **Goal:** finish Phase 1 with mock upstream services and a Docker Compose dev environment.
- **Changed:** user committed apps/gateway. Added `examples/mock-upstreams` (fault injection via `_` query params, 8 tests), multi-stage
  `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `pnpm dev:up/dev:down`, README quickstart; ADR-0029; ADR-0022 amended; CLAUDE.md, STATE.
- **Decisions:** [ADR-0029](../adr/0029-dev-environment.md) (Claude, pending review): node:26.4.0-slim, pnpm via npm (no corepack in Node 25+),
  `pnpm deploy --legacy` bundles, non-root runtime, Compose mounts the example config unchanged, ops listener stays on 127.0.0.1.
- **Verified:** `pnpm check` (121 tests); `docker compose up --wait` → all healthy; curl through the gateway: 200 forwarding with
  key/auth stripped and XFF rebuilt, 404/405/400, 503 pass-through, 504 timeout, 502 reset, 502 oversized, mid-stream cut-off, 400 upgrade;
  9091 unreachable from host; no secrets or query strings in logs; clean SIGTERM. Stack torn down afterwards.
- **Open threads:** Phase 2 needs an API-client/key config design first. Images ~400 MB (slim later). Q3, Q6, Q8, Q9, Q11, Q13, Q14 open.

## 2026-10-23 · ADR-0029 review follow-ups: shutdown, readiness, verification
- **Goal:** address the user's four verification points before accepting ADR-0029.
- **Changed:** `server.shutdownTimeoutMs` (schema, example, defaults test); `Gateway.close()` now bounded + idempotent, returns `{ forced }`;
  `UpstreamRegistry.destroy()`; lifecycle tests; stricter chunked oversize test + in-limit chunked test; log-capture harness + tests.
  ADR-0030; ADR-0029 → Accepted; ADR-0026/0028 updated; CLAUDE.md hazards.
- **Verified:** (1) Node 26.4.0 + pnpm 11.9.0 + frozen lockfile in the build stage; (2) mocks healthy before the gateway starts, `/ready` scope
  documented (upstreams excluded on purpose); (3) Content-Length and chunked oversize paths tested; (4) Docker SIGTERM drain (200, ~2 s)
  and forced close at the 2 s deadline (exit 0). `pnpm check`: 129 tests.
- **Bug fixed:** every successful response logged a false "aborted mid-stream" warning (pipeline passes `undefined`, not `null`).
- **Unexplained:** one Docker run was SIGKILLed after 1.2 s; not reproducible with an explicit `-t 10` or under Compose. Recorded in ADR-0030.

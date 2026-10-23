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

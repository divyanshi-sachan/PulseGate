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

# ADR-0020: Admin API on a separate port with a bearer token

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** OPEN_QUESTIONS Q10; PRD §9, NFR Security; tech_impl §9.3, §12.3

## Context
Management endpoints (`/admin/*`) must be protected separately from public gateway traffic, but no
mechanism had been chosen.

## Decision
- `/admin/*` is served by a **separate Fastify listener on its own port** (configurable, default `9090`), never
  on the public gateway port.
- Authentication: `Authorization: Bearer <token>`, where the token comes from the **`ADMIN_TOKEN` env var**.
  It is compared in constant time (`crypto.timingSafeEqual` on equal-length digests).
- If `ADMIN_TOKEN` is unset, the admin listener **is not started** and a startup log line says so.
- A missing or wrong token gets **401 `ADMIN_AUTHENTICATION_FAILED`** with `WWW-Authenticate: Bearer`, in the
  normalized error shape (ADR-0011). There is a single token, so there is no 403 case in this version.
- The token is never logged, echoed, or used as a metric label. Client API keys (`X-API-Key`) never grant admin access.

## Alternatives considered
- **Same port under `/admin`** — simpler to deploy, but admin routes would share the public listener and its exposure.
- **mTLS / SSO** — out of scope for v1 (PRD §5).

## Consequences
- Docker Compose maps the admin port only where it is needed; the public demo doesn't expose it publicly.
- Tests: admin is off without `ADMIN_TOKEN`; 401 for a missing, wrong or wrong-scheme token; a correct token succeeds;
  `/admin/*` on the public port returns 404; a client API key is rejected on the admin port.

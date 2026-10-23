# ADR-0014: Route auth is a nested `auth: { required }` object

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** OPEN_QUESTIONS Q2; tech_impl §10.1
- **Supersedes:** `authRequired: boolean` in system_design §8 `RouteConfig`

## Context
system_design §8 used a flat `authRequired: boolean`; tech_impl §10.1 used `auth: { required: boolean }`.

## Decision
Routes declare authentication as a nested object:

```yaml
auth:
  required: true
```

`required` is the only Phase 1 field. Future auth options (header name, scopes, allowed clients) are added
as optional fields inside `auth`.

## Alternatives considered
- **`authRequired: boolean`** — simpler today, but every later auth option would need a breaking schema change.

## Consequences
- The Zod route schema has an `auth` object; the flat `authRequired` key is rejected as unknown.
- Tests: `auth.required: true` rejects missing/invalid keys with 401; `false` forwards without a client identity
  (rate-limit key for that case is still open — Q8).

# ADR-0022: Separate operations listener for health, readiness and metrics

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** OPEN_QUESTIONS Q15; tech_impl §9.2; PRD §9
- **Relates to:** ADR-0020 (admin listener)

## Context
ADR-0020 moved `/admin/*` to its own port and turns it off when `ADMIN_TOKEN` is unset. Health and metrics
must stay available even when admin is disabled, and must not share the public listener.

## Decision
PulseGate runs up to three listeners:

| Listener | Default port | Default bind | Serves |
|---|---|---|---|
| Public gateway | 8080 | `0.0.0.0` | Proxied traffic only |
| Admin API | 9090 | (ADR-0020) | `/admin/*`, bearer-protected; off when `ADMIN_TOKEN` unset |
| **Operations** | **9091** | **`127.0.0.1`** | `GET /health`, `GET /ready`, `GET /metrics` |

- The operations listener is **always on** and doesn't depend on the admin listener or `ADMIN_TOKEN`.
- `/health` = process liveness; it does not fail just because Redis is down. `/ready` = readiness including required
  dependencies (e.g. Redis when distributed mode requires it). `/metrics` = Prometheus format.
- No route management or other admin/mutation endpoints on the operations listener, ever.
- Exposing it beyond localhost is a deployment choice (bind override), and access must then be restricted at the
  network/deployment layer. The listener has no authentication of its own.
- None of these endpoints exist on the public gateway port (they return 404 there).

## Alternatives considered
- **Health and metrics on the public port** — leaks Prometheus data and puts probe traffic on the public port.
- **Metrics on the admin port** (the earlier Q15 proposal) — metrics would disappear whenever admin is disabled.

## Consequences
- In Docker, `127.0.0.1` inside a container is unreachable from other containers. The Compose setup overrides the
  bind to `0.0.0.0` on an internal network and does **not** publish 9091 to the host by default; container
  healthchecks run inside the container.
- Tests: all three endpoints on 9091; 404 on 8080; ops stays up with admin disabled; `/health` stays OK while
  `/ready` fails when required Redis is down; no `/admin/*` on 9091.

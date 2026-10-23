# PulseGate — Claude working guide

PulseGate is a self-hostable **API gateway & reliability platform** (TypeScript/Node). It sits between
clients and upstream HTTP services and provides: routing, API-key auth, token-bucket rate limiting
(local + Redis), response caching, timeouts, bounded retries, per-upstream circuit breakers, and
Prometheus metrics + a React dashboard. Solo-developer, open-source, interview-grade project:
**every feature must be testable, observable, and explainable.**

## Source-of-truth documents (read before designing anything)

| File | What it is | Authority |
|---|---|---|
| [prd.md](prd.md) | Product requirements: goals, scope (P0/P1/out), FR-01..FR-08, milestones | *What* and *why* |
| [system_design_specification.md](system_design_specification.md) | HLD + LLD: interfaces, class diagrams, patterns, pipeline order, ADR list | *Shape* of the system |
| [technical_implementation.md](technical_implementation.md) | Stack, monorepo layout, request lifecycle, config contract, metrics, roadmap | *How* to build it |
| [docs/adr/](docs/adr/README.md) | Architecture Decision Records | **Overrides the specs** where they conflict |
| [docs/context/STATE.md](docs/context/STATE.md) | Current phase, what's done, what's next | Live status |
| [docs/context/OPEN_QUESTIONS.md](docs/context/OPEN_QUESTIONS.md) | Spec gaps/conflicts awaiting a decision | Don't guess past these |
| [docs/context/SESSION_LOG.md](docs/context/SESSION_LOG.md) | Append-only journal of each working session | History |

Precedence when sources disagree: **accepted ADR > technical_implementation.md > system_design_specification.md > prd.md**.
If you find a new conflict, add it to OPEN_QUESTIONS.md instead of silently picking one.

## Context protocol (how decisions survive between sessions)

A `SessionStart` hook injects STATE.md, open questions, the ADR index and the latest session-log
entries automatically (also after `/compact`). Keep those files accurate — they *are* the shared memory.

1. **Decision made → record it immediately.** Any choice that a future session could make differently
   (schema shape, library, algorithm detail, header name, default value, error code) gets an ADR via
   `/adr`. Small choices can be one-paragraph ADRs. Never leave a decision only in chat.
2. **Deviation from a spec → ADR that says so** ("Supersedes technical_implementation.md §8 example").
3. **Gap found → OPEN_QUESTIONS.md** with a proposed default. Ask the user if it blocks the current task.
4. **End of a working session → `/handoff`** (updates STATE.md + appends SESSION_LOG.md). A `Stop` hook
   reminds you if you edited files but didn't log the session.
5. Before finishing a feature, run `/spec-check` (spawns the `spec-reviewer` agent).

## Non-negotiable invariants

These come straight from the specs; violating one requires an ADR first.

- **Pipeline order:** request validation → route match → **auth → rate limit → cache lookup** →
  circuit-breaker check → upstream (timeout + retry inside) → cache write → observation.
  Cache hits must never bypass rate limiting. Every exit path records metrics and cleans up.
- **Hot path never touches PostgreSQL.** Redis is optional in single-instance mode.
- **Retries:** bounded attempts (`maxAttempts` = total incl. first, ADR-0016), exponential backoff **with jitter**, never exceed the request deadline,
  **no automatic retry of non-idempotent methods** unless an explicit idempotency mechanism is configured.
- **Circuit breaker:** one per upstream, in-memory per instance (MVP). States CLOSED/OPEN/HALF_OPEN,
  bounded half-open probes, transitions centralized, logged and metered. Ordinary 4xx ≠ upstream failure.
- **Rate limiting:** `RateLimiter` Strategy interface; local = per-instance (not global); Redis = single
  atomic Lua script using **Redis server time**; Redis outage → explicit `fail-open | fail-closed`, never silent.
- **Caching:** conservative by default — GET + success only, TTL + size + entry bounds, respect
  `private`/`no-store`, never cache personalized data under a shared key, no credentials in keys.
- **Security:** never log/label/cache raw API keys or auth headers; admin on its own port with an `ADMIN_TOKEN` bearer (ADR-0020);
  upstreams only from validated config — routes reference them by `upstreamId` (ADR-0013), `baseUrl` http/https and path-only, never from requests (SSRF); raw-path forwarding with dot segments rejected (ADR-0019);
  strip hop-by-hop headers and `X-API-Key` before forwarding, `Authorization` only on opt-in, `X-Forwarded-*` only from
  `server.trustedProxies` (ADR-0021); request/response size limits;
  secrets only via env (`.env.example` is committed, `.env` never is).
- **Errors:** typed `GatewayErrorCode` + HTTP status + `requestId` in one normalized JSON shape;
  no stack traces to clients. Full registry in ADR-0018: 400 malformed / 401 auth / 404 route / 405 method /
  413 body too large / 429 limit / 502 conn failure or `UPSTREAM_RESPONSE_TOO_LARGE` / 503 circuit open / 504 timeout / 500 internal.
  Gateway-decided 4xx never count as upstream failures.
- **Listeners (ADR-0020, 0022):** public 8080 = proxy only; admin 9090 = `/admin/*`; operations 9091 on 127.0.0.1 =
  `/health`, `/ready`, `/metrics`. Nothing operational or administrative on the public port.
- **Metrics:** bounded label cardinality only (route id, status class, outcome, cache result).
  Never request IDs, keys, or raw URLs as labels.
- **Benchmarks:** never publish or write a number that wasn't measured. Record hardware, versions, config, workload.
- **Scope discipline:** finish proxy → rate limiter → reliability before dashboard or distributed extras.
  Out of scope: K8s operator, service mesh, billing, ML, multi-region, SSO.

## Stack & layout (planned — see technical_implementation.md §3)

Node.js + TypeScript, pnpm workspaces, Fastify (typed hooks), Undici, ioredis, Zod (runtime source of
truth; infer TS types from schemas), Vitest + `fastify.inject`, k6, Docker Compose, React dashboard.

```
apps/gateway  apps/dashboard
packages/{config,rate-limiter,cache,reliability,observability,shared,testing}
examples/mock-upstreams  config/routes.example.yaml  tests/{integration,e2e}  benchmarks/{k6,reports}
```

Packages expose small public interfaces; the gateway composes interfaces, never imports internals.

## Coding conventions

- Strict TypeScript; no `any` in public interfaces. Zod schema first, `z.infer` for types.
- Inject clocks (`now()`/monotonic) and randomness (jitter) — **tests use fake clocks, never sleeps.**
- Every component ships with unit tests covering its failure behavior (see system_design §15 table).
- Integration tests use real Redis (test container) and mock upstreams that can delay/reset/5xx.
- Bound everything: maps, queues, retries, concurrency, body sizes.

## Commands (fill in once scaffolded)

```
pnpm install      # TODO
pnpm test         # TODO
pnpm lint         # TODO
pnpm typecheck    # TODO
docker compose up # TODO
```

## Project slash commands

- `/adr <title>` — record a decision (next number, template, index, resolve open question).
- `/handoff` — update STATE.md and append a SESSION_LOG.md entry.
- `/spec-check` — review current changes against specs, invariants and ADRs.

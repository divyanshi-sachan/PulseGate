# ADR-0029: Mock upstreams and Docker Compose dev environment

- **Status:** Accepted (user review 2026-10-23: follow-up checks done, see Consequences)
- **Date:** 2026-10-23
- **Source:** Phase 1 deliverables (tech_impl §14); PRD Portability; ADR-0022
- **Amends:** ADR-0022 Consequences (Compose bind override not needed yet)

## Decision

### Mock upstreams (`examples/mock-upstreams`)
- A dependency-free `node:http` server. It echoes the raw URL, method, headers and body as JSON, and serves `GET /healthz`.
- Faults are triggered per request with `_`-prefixed query parameters, which the gateway forwards verbatim (ADR-0019),
  so they work through the gateway with curl: `_delay`, `_status`, `_failRate`, `_reset`, `_bytes`,
  `_contentLength`. Out-of-range values are ignored. Configured with `SERVICE_NAME`, `PORT`, `HOST`.
- It is a development and demo tool, not a test double: gateway integration tests keep their own in-process servers.

### Images
- One multi-stage `Dockerfile` with targets `gateway` and `mock-upstreams`, on `node:26.4.0-slim`. pnpm 11.9.0 is installed
  with npm, because Node 25+ dropped corepack. Dependencies are installed from manifests first, for layer caching.
- Runtime images contain only `pnpm deploy --prod --legacy` output (`dist` plus production `node_modules`; workspace
  packages are copied as `dist` only) and run as the non-root `node` user. `--legacy` is used because the
  workspace doesn't use `injectWorkspacePackages`, which would break the source-first dev setup (ADR-0025).

### Compose (`docker-compose.yml`)
- Services: `gateway`, `orders-mock` (4001) and `payments-mock` (4002). The gateway mounts **`config/routes.example.yaml`
  unchanged**: its upstream hosts match the service names, so there is no second config to keep in sync.
- Only `8080` is published. The operations listener stays on `127.0.0.1:9091` inside the container, and the container
  healthcheck probes `/ready` there. ADR-0022's suggested `0.0.0.0` override on an internal network is **deferred**
  until something outside the container (e.g. Prometheus in Phase 5) needs to reach it.
  **When Prometheus arrives, decide the binding and network access deliberately:** at most an internal network
  shared with the scraper, never a host-published port by default.
- Mocks have healthchecks, and the gateway waits for them (`depends_on: service_healthy`). There is no Redis yet (Phase 4).
- Root scripts: `pnpm dev:up` (`docker compose up --build`) and `pnpm dev:down`.

## Consequences
- Verified on Docker 29.6.1 (arm64): all services healthy; the gateway returned 200/404/405/400/503/504/502 for normal and
  injected-fault requests; an 11 MiB chunked response was cut off below the 10 MiB limit; no API keys or query strings
  in logs; SIGTERM shut it down cleanly. Image sizes are around 400 MB (slim base plus deps); slimming is Phase 6 work.
- Review follow-ups, all verified:
  1. **Node/pnpm/lockfile:** the build stage runs Node 26.4.0 with pnpm 11.9.0, the same as local;
     `pnpm install --frozen-lockfile` passes; lockfile format 9.0 on both.
  2. **Health ordering:** the gateway container starts only after both mocks report healthy. `/ready` scope is in ADR-0030.
  3. **Response size:** both the known-`Content-Length` path (502 before any body) and the chunked path (aborted after at
     most the limit, `complete === false`) are covered by integration tests and were checked in Docker.
  4. **Shutdown:** bounded drain plus forced close, ADR-0030.
- **A development hazard, not only a Docker detail:** run `pnpm deploy` only inside the Docker build. Running it in the local checkout marks the workspace `node_modules` as a
  production install, and later `pnpm` scripts abort with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. Fix it with
  `pnpm install --config.confirmModulesPurge=false`.

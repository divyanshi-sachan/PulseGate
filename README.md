# PulseGate

A lightweight, self-hostable API gateway focused on reliability: routing, API-key auth, rate limiting,
caching, timeouts, bounded retries and circuit breakers, with observable, explainable behavior.

**Status:** Phase 1 (gateway foundation) complete. Auth, rate limiting, retries/breakers, caching and metrics
are next. See [docs/context/STATE.md](docs/context/STATE.md) for the current state and [docs/adr/](docs/adr/README.md)
for the design decisions.

## Quickstart (Docker)

```bash
pnpm dev:up        # or: docker compose up --build
curl -i http://localhost:8080/api/orders/1
```

The mock upstreams echo what they received, so you can see what the gateway forwards. Faults can be
injected through the gateway with query parameters:

```bash
curl -i "http://localhost:8080/api/orders/1?_delay=4000"   # 504 UPSTREAM_TIMEOUT (route timeout 3 s)
curl -i "http://localhost:8080/api/orders/1?_status=503"   # upstream status passed through
curl -i "http://localhost:8080/api/orders/1?_reset=1"      # 502 UPSTREAM_UNAVAILABLE
curl -i http://localhost:8080/nope                         # 404 ROUTE_NOT_FOUND
```

## Local development

Requires Node.js 24+ (developed on 26) and pnpm 11.

```bash
pnpm install
pnpm check                                   # format, lint, typecheck, tests
cp config/routes.example.yaml config/routes.yaml
pnpm --filter @pulsegate/gateway dev         # runs from TypeScript source
```

Configuration is validated at startup; every option and default is documented in
[config/routes.example.yaml](config/routes.example.yaml).

## Layout

| Path | Contents |
|---|---|
| `apps/gateway` | Fastify gateway: public and operations listeners, routing, proxy |
| `packages/config` | Zod config schema and loader |
| `packages/shared` | Normalized error registry |
| `examples/mock-upstreams` | Mock upstream with fault injection |
| `docs/adr` | Architecture decision records |

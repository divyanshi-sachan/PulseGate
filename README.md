# PulseGate

A lightweight, self-hostable API gateway focused on reliability: routing, API-key auth, rate limiting,
caching, timeouts, bounded retries and circuit breakers, with observable, explainable behavior.

**Status:** Phases 1–2 complete (proxy, API-key auth, local rate limiting). Retries/breakers, Redis limiting,
caching and metrics are next. See [docs/context/STATE.md](docs/context/STATE.md) for the current state and [docs/adr/](docs/adr/README.md)
for the design decisions.

## Quickstart (Docker)

```bash
pnpm dev:up        # or: docker compose up --build
```

`/api/orders` requires an API key; `/api/payments` is public and rate-limited per client IP. The demo stack
ships a **public, local-only** demo key. Never use it outside your machine:

```bash
KEY=pg_NSMO1rF_e7v07Y_Qd3JxwQTqqx_bzqVXumT2LBwvf98
curl -i http://localhost:8080/api/orders/1 -H "x-api-key: $KEY"   # 200, X-RateLimit-* headers
curl -i http://localhost:8080/api/orders/1                        # 401 AUTHENTICATION_FAILED
curl -i http://localhost:8080/api/payments/7                      # 200, limited per IP
```

The mock upstreams echo what they received, so you can see what the gateway forwards (no `X-API-Key`).
Faults can be injected through the gateway with query parameters:

```bash
curl -i "http://localhost:8080/api/orders/1?_delay=4000" -H "x-api-key: $KEY"   # 504 UPSTREAM_TIMEOUT
curl -i "http://localhost:8080/api/orders/1?_status=503" -H "x-api-key: $KEY"   # upstream status passed through
curl -i "http://localhost:8080/api/orders/1?_reset=1" -H "x-api-key: $KEY"      # 502 UPSTREAM_UNAVAILABLE
curl -i http://localhost:8080/nope                                              # 404 ROUTE_NOT_FOUND
```

Create real keys with `pnpm keygen --client <id>`. It prints the key once plus the SHA-256 digest to put in
your clients file (see [config/clients.example.yaml](config/clients.example.yaml)).

## Local development

Requires Node.js 24+ (developed on 26) and pnpm 11.

```bash
pnpm install
pnpm check                                   # format, lint, typecheck, tests
cp config/routes.example.yaml config/routes.yaml
cp config/clients.example.yaml config/clients.yaml   # or: pnpm keygen
pnpm --filter @pulsegate/gateway dev         # runs from TypeScript source
```

Configuration is validated at startup; every option and default is documented in
[config/routes.example.yaml](config/routes.example.yaml).

## Layout

| Path | Contents |
|---|---|
| `apps/gateway` | Fastify gateway: public and operations listeners, routing, proxy |
| `packages/config` | Zod config schema and loader |
| `packages/rate-limiter` | Token-bucket `RateLimiter` and in-memory implementation |
| `packages/shared` | Normalized error registry |
| `examples/mock-upstreams` | Mock upstream with fault injection |
| `docs/adr` | Architecture decision records |

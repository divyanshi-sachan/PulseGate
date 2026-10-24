# PulseGate

A lightweight, self-hostable API gateway focused on reliability: routing, API-key auth, rate limiting,
caching, timeouts, bounded retries and circuit breakers, with observable, explainable behavior.

**Status:** Phases 1–5 complete: proxy, API-key auth, local and Redis-backed rate limiting, bounded retries, circuit
breakers, response cache, Prometheus `/metrics`, and an admin dashboard. Release and benchmarks (Phase 6) are next. See [docs/context/STATE.md](docs/context/STATE.md) for the current state and [docs/adr/](docs/adr/README.md)
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

Repeat the first request: `X-Cache: MISS` then `HIT` (cached per API client for 30 s). Metrics are on the
operations listener inside the container: `docker compose exec gateway node -e "fetch('http://127.0.0.1:9091/metrics').then(r=>r.text()).then(console.log)"`.

The mock upstreams echo what they received, so you can see what the gateway forwards (no `X-API-Key`).
Faults can be injected through the gateway with query parameters:

```bash
curl -i "http://localhost:8080/api/orders/1?_delay=4000" -H "x-api-key: $KEY"   # 504 UPSTREAM_TIMEOUT
curl -i "http://localhost:8080/api/orders/1?_status=503" -H "x-api-key: $KEY"   # upstream status passed through
curl -i "http://localhost:8080/api/orders/1?_reset=1" -H "x-api-key: $KEY"      # 502 UPSTREAM_UNAVAILABLE
curl -i http://localhost:8080/nope                                              # 404 ROUTE_NOT_FOUND
curl -i "http://localhost:8080/api/orders/1?_failRate=0.3" -H "x-api-key: $KEY" # flaky upstream; GETs retried once
for i in 1 2 3 4; do curl -s -o /dev/null -w '%{http_code} ' "http://localhost:8080/api/payments/1?_reset=1"; done
# 502 502 502 503: the payments circuit breaker opened (CIRCUIT_OPEN, Retry-After: 10)
```

### Dashboard

```bash
pnpm dev:dashboard     # the stack above + the admin listener on 127.0.0.1:9090
```

Open <http://127.0.0.1:9090/admin/ui/> and paste the local-only token `pulsegate-local-dashboard-token-not-a-secret`
(or start with your own: `ADMIN_TOKEN=$(openssl rand -hex 32) pnpm dev:dashboard`). Send some traffic with the curl
commands above; the screens update every 5 seconds:

- **Overview:** requests, throughput, success and error rates, and p95/p99 latency, plus 5-minute trends.
- **Routes:** a sortable table with sparklines, and each route's configuration.
- **Upstreams:** circuit-breaker state, attempt failure rate and latency.
- **Cache:** memory against its limits, and hit ratio, bypass share and store outcomes per route.
- **Rate limits:** rejections per route, and Redis health and degraded state.

The numbers come from a bounded rolling window: 30 × 10 s buckets per route, for the connected instance. Percentiles
are labelled `low`, `approximate` or `adequate`; ADR-0038 explains exactly what each label promises. The admin API
behind the screens (`/admin/api/{stats,upstreams,routes,rate-limits,cache}`) needs `Authorization: Bearer <token>` and
is typed by `packages/admin-contract`. Without `ADMIN_TOKEN`, the admin listener doesn't start at all.

### Distributed mode (two gateways, one Redis budget)

```bash
pnpm dev:distributed   # gateway on :8080 and :8081, Redis behind both
for i in $(seq 1 100); do curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:$((8080 + i % 2))/api/payments/$i" & done | sort | uniq -c
# exactly 30 × 200 across both instances (capacity 30), the rest 429
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
pnpm --filter @pulsegate/dashboard dev       # dashboard on Vite, proxying /admin/api to a gateway on :9090
pnpm test:e2e                                # Docker stack + Playwright (first: pnpm exec playwright install chromium)
pnpm test:real                               # opt-in: correctness against real public APIs (≤ 30 requests per run)
pnpm bench                                   # opt-in k6 suite against the mocks (BENCH_PROFILE=quick|full)
```

Configuration is validated at startup; every option and default is documented in
[config/routes.example.yaml](config/routes.example.yaml).

## Layout

| Path | Contents |
|---|---|
| `apps/gateway` | Fastify gateway: public and operations listeners, routing, proxy |
| `apps/dashboard` | React + Vite admin dashboard, served by the gateway at `/admin/ui/` |
| `packages/admin-contract` | Zod contracts for the admin API, shared by the gateway and the dashboard |
| `packages/config` | Zod config schema and loader |
| `packages/cache` | Bounded response cache and cacheability rules |
| `packages/observability` | Prometheus metrics with bounded labels, and the dashboard's rolling stats window |
| `packages/rate-limiter` | Token-bucket `RateLimiter`: in-memory and Redis implementations |
| `packages/reliability` | Circuit breakers and retry policy |
| `packages/testing` | Test-only helpers: real Redis (Testcontainers), fault-injecting TCP proxy |
| `packages/shared` | Normalized error registry |
| `examples/mock-upstreams` | Mock upstream with fault injection |
| `tests/e2e` | Playwright end-to-end test of the dashboard against the Docker stack |
| `docs/adr` | Architecture decision records |

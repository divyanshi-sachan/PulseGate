# ADR-0037: Dashboard: admin API, rolling window, static hosting

- **Status:** Accepted (user chose all recommended options; implementation details to follow in the build)
- **Date:** 2026-10-24
- **Source:** dashboard design questions; ADR-0020 (admin listener), ADR-0035 (dashboard after metrics); tech_impl §9.3, §11
- **Builds on:** ADR-0036 (metrics), ADR-0022 (listeners)

## Decisions
1. **Data source: an admin JSON API.** Build the ADR-0020 admin listener (port 9090, `ADMIN_TOKEN` bearer, disabled when
   unset) with read-only endpoints (tech_impl §9.3): `/admin/stats`, `/admin/upstreams` (breaker states), `/admin/routes`,
   `/admin/cache/stats`. They return dashboard-ready JSON from the same sources as `/metrics`, with typed contracts.
2. **Window: a rolling 5 minutes.** The gateway keeps a **bounded** per-route sliding window (5 × 1-minute buckets, capped
   sample count) for p50/p95/p99 latency, error rate, rate-limit rejections and cache hit ratio, so the numbers reflect
   recent behavior during an incident. Lifetime totals stay in `/metrics`.
3. **Hosting: a static build on the admin port.** `apps/dashboard` is React + TypeScript, built with Vite into static files
   served by the admin listener at `/admin/ui/`. Same origin as the API, so no CORS and no extra service; `vite dev` proxies
   to the admin port locally.
4. **Browser auth: paste the token, keep it in `sessionStorage`.** The UI asks for `ADMIN_TOKEN` once per tab and sends it
   as `Authorization: Bearer`. It is never put in URLs or `localStorage`, and nothing new is added to the gateway's auth
   surface. The 401 contract is ADR-0020's `ADMIN_AUTHENTICATION_FAILED`.

## Consequences
- The admin listener starts only when `ADMIN_TOKEN` is set (ADR-0020). Compose gets a local-only token, and port 9090 is
  published for the demo only.
- Exit criterion (tech_impl §14 Phase 5): the dashboard's numbers match traffic sent through the gateway in integration tests.
- The rolling window is bounded memory; its sizing and sample cap are recorded in the implementation ADR.

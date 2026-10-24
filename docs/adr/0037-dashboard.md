# ADR-0037: Dashboard: admin API, rolling window, static hosting

- **Status:** Accepted, amended 2026-10-24 by the approved plan (`docs/plans/dashboard.md`)
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

## Amendments (2026-10-24, approved plan)
- **Buckets:** **30 × 10 s** instead of the example 5 × 1 min, so trend charts get 30 real points.
  - Per-bucket reservoirs are capped at 256 samples, about 60 KB per route at worst.
  - Window percentiles use a weighted quantile over the bucket reservoirs, never the cumulative `/metrics` histograms.
- **Time series in the API:** `/admin/api/stats` returns the window aggregate **and** the buckets.
  - Buckets from before the process started are omitted, not zero-filled.
  - The newest bucket is marked `partial` with its real duration; empty buckets have `latency: null`, so charts show gaps.
  - The API is for the connected instance only.
- **API paths:** `/admin/api/{stats,upstreams,routes,rate-limits,cache}`, so they can't collide with the UI under `/admin/ui/`.
- **Static UI files are served without a token;** every `/admin/api/*` call needs it.
- **Charts: Recharts 3.10.1**, chosen after measurement.
  - Measured cost over React alone: Recharts +106.1 KB gz, uPlot +21.3 KB gz.
  - Conditions: lazy-loaded behind the token gate, CI budget of initial JS ≤ 120 KB gz and total ≤ 260 KB gz.
  - Fall back to uPlot if the real build breaks the budget.
- **Design system:** a light, enterprise visual standard as in-repo tokens (`apps/dashboard/src/design`); no account
  design system exists.
- **Docker:** `docker-compose.dashboard.yml` + `config/routes.dashboard.example.yaml` (`admin.host: 0.0.0.0` in the container,
  a local-only token), published as `127.0.0.1:9090:9090`.
- **Testing:** component and contract tests **plus Playwright end to end now**, in CI against the Docker stack.

## Second review (2026-10-24, user): plan clarifications
- **Percentile confidence per percentile:**
  - Each percentile carries `method` (`exact` | `sampled`), observations, samples, `tailSamples` and `confidence`.
  - `low` when fewer than 5 samples lie beyond the estimate: n ≥ 10 for p50, ≥ 100 for p95, ≥ 500 for p99. For the
    window, n is the effective sample size of the weighted merge.
  - The reservoir is raised to **512 samples per bucket** (Float32), so a busy 10 s bucket can reach a confident p99.
- **Memory:**
  - Fixed, preallocated typed arrays, allocated only when the admin listener is enabled.
  - Bound: (R + 2) × 64.6 KiB + U × 60.9 KiB, e.g. 4.47 MiB for 50 routes and 20 upstreams.
  - Verified by `scripts/bench-stats-window.ts` (within formula + 15 %, no growth over 1M requests).
- **Rates:** every numerator and denominator is defined in the plan (§2.3); `null` when the denominator is 0.
  - The cache hit ratio excludes bypasses.
  - The rate-limit rejection rate counts only requests that reached the limiter.
  - The upstream failure rate is per attempt, with aborts neutral.
- **Docker boundary:** other containers on the Compose network can reach the admin listener, so Bearer auth on **every**
  `/admin/api/*` route is the real boundary. It is tested by route enumeration and by a cross-container curl (401 without
  the token).
- **Bundle budget** enforced in CI against the real Vite build (initial ≤ 120 KB gz, total ≤ 260 KB gz). Any breach is
  measured before uPlot is considered.
- **Playwright** runs on a dedicated deterministic stack: `routes.e2e.yaml`, known traffic, explicit `_reset` faults,
  a long open period so the breaker can't close mid-test, no sleeps or retries, and teardown always.
- **Contracts:** all five endpoints are specified as shared Zod schemas (`packages/admin-contract`), with a screen-to-field check.


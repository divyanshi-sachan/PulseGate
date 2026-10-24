# Plan: admin API + dashboard (Phase 5 remainder)

_Status: **approved by the user on 2026-10-24.** Decisions: ADR-0037 (amended). Every former open point has been confirmed._

**Exit criterion (tech_impl §14 Phase 5):** the dashboard's numbers match traffic sent through the gateway, shown by
socket-level API tests **and** a Playwright test against the Docker stack.

**Product bar (user):** a polished, production-quality developer product, not merely a functional admin page.

## Settled by the user
| Topic | Decision |
|---|---|
| Data source | Admin JSON API on the ADR-0020 listener (ADR-0037) |
| Window | Rolling 5 minutes, bounded (ADR-0037) |
| Hosting | Static Vite build served at `/admin/ui/` on the admin port (ADR-0037) |
| Browser auth | Token pasted once per tab, kept in `sessionStorage`, sent as Bearer (ADR-0037) |
| UI static files | Served **without** a token; only `/admin/api/*` needs it |
| Docker exposure | `docker-compose.dashboard.yml` + `config/routes.dashboard.example.yaml` (`admin.host: 0.0.0.0` in the container, local-only `ADMIN_TOKEN`), published as `127.0.0.1:9090:9090`; a test loads the example file |
| Charts | **Recharts**, chosen after measuring (§3): lazy-loaded, with a CI bundle budget; uPlot only if the real build breaks the budget |
| UI tests | Component + contract tests **and Playwright end to end now** |
| Buckets | **30 × 10 s** for the 5-minute window (§2) |
| Design system | **In-repo tokens** in `apps/dashboard/src/design` (§4) |

## 1. Gap analysis: can the planned API drive real trend charts?
**No, not as drafted.**
- tech_impl §11 requires: request volume, success and error rates, p50/p95/p99, rate-limit rejections, cache hit ratio,
  and upstream health/breaker states.
- tech_impl §9.3 lists only endpoint names; **there is no API contract yet.**
- The draft's `/admin/api/stats` returned **one 5-minute aggregate** per route. That supports KPI tiles but not a trend.
- The draft's fallback (client-side history built from polls) would have been **misleading**:
  - After a page load there is no history at all.
  - Each poll is a rolling aggregate, so a series of polls is a smeared, overlapping signal rather than real
    per-interval values.
- `/metrics` histograms are cumulative and since process start. Percentiles derived from them would be inferred, not
  measured; ruled out by the user.

**Smallest justified change.** The rolling window is new code anyway, and it already has to keep per-interval buckets
internally to roll. Expose those buckets in the API instead of only their sum. No new state, no extra service.

## 2. Rolling window and time-series contract: `packages/observability`
- **Buckets (confirmed):** **30 × 10-second buckets** (5 minutes). The ADR's earlier example of 5 × 1-minute buckets
  would give only 5 points per chart, too coarse to show a trend.
- **Per bucket**, for every route and upstream:
  - Requests, status classes and error codes (bounded registry).
  - Rate-limit rejections; cache hit/miss/bypass.
  - Upstream attempts by outcome; retries.
  - Latency **reservoir**: Algorithm R, capped at 256 samples per bucket, with injected randomness and clock.
- **Memory bound:** 30 × 256 × 8 B ≈ 60 KB per route at worst. Unknown ids map to `unmatched`/`unknown`.
- **Percentiles are measured, never inferred:**
  - **Per bucket:** p50/p95/p99 from that bucket's own samples; `null` when it had no requests.
  - **For the window:** a **weighted** quantile over all live reservoirs, each sample weighted by
    bucket count ÷ bucket samples, so busy and quiet buckets count correctly.
  - Each value carries `samples` and `exact` (count ≤ cap). Values with fewer than 10 samples are flagged
    `lowSample: true`.
- **Honesty rules in the contract:**
  - Buckets from before the process started are **omitted**, not reported as zeros; `collectingSince` is included.
  - The newest bucket is `partial: true` with its real elapsed `durationMs`, so rates divide by actual time.
  - Empty buckets report `requests: 0` and `latency: null`, and the UI draws a **gap**: no interpolation, no smoothing.
  - The response names the **instance** it describes. There is no cross-instance aggregation here; Prometheus can do that later.
- **Feeding:** the same hook points as `GatewayMetrics`, so both always count the same events (tested).
- **Tests:**
  - Rotation and expiry with a fake clock; partial-bucket rate math.
  - Exact percentiles on small known inputs; the weighted quantile against a brute-force reference.
  - The reservoir stays bounded under 100,000 samples; low-sample flags.
  - Mutations: unbounded reservoir, unweighted merge, zero-filling before start.

## 3. Charting library: measured, not assumed
Measured on 2026-10-24: identical apps, Vite 8.3.5 production builds, React 19.3.1.

| Bundle | Minified JS | Gzipped JS | Cost over React alone (gz) |
|---|---|---|---|
| React only | 214.5 KB | 66.2 KB | — |
| + Recharts 3.10.1 (line, bar, axes, grid, tooltip, legend, responsive) | 594.3 KB | 172.3 KB | **+106.1 KB** |
| + uPlot 1.6.32 (equivalent line + bar, + 0.7 KB CSS) | 265.1 KB | 87.5 KB | **+21.3 KB** |

**Assessment.**
- Recharts costs about 5× more than uPlot.
- uPlot's speed advantage is irrelevant at 30 points per chart.
- Recharts provides declarative React components, built-in tooltips and legends, responsive containers, and an
  `accessibilityLayer` for keyboard navigation.
- uPlot would need a custom tooltip plugin, a React lifecycle wrapper, and hand-built accessibility, which means more
  bespoke code to keep polished.

**Decision (confirmed):** use **Recharts**, under these conditions:
- **Lazy-load** the chart chunk (`React.lazy`) so the token gate and shell load first.
- Set a **bundle budget** enforced in CI: initial JS ≤ 120 KB gz, total ≤ 260 KB gz.
- Switch to uPlot if the real dashboard breaks the budget, or if Recharts can't meet the chart requirements below
  without hacks.

## 4. Chart and UX requirements (user)
- **Charts:**
  - **Reusable chart components**, with data calculations kept **outside presentation**. A `chart-data` module turns API
    buckets into series and is unit-tested for gaps, partial buckets, low samples, unit conversion, and a single bucket.
  - Responsive layouts, readable axes with **timestamps and units** (ms, req/s, %), useful tooltips (value, unit,
    sample count, partial/low-sample notes), and accessible labels: a `title`/`desc` per chart plus a visually hidden
    table alternative.
  - **Latency:** p50/p95/p99 lines from bucket percentiles. **Request rate:** req/s per bucket. **Error rate** and
    **cache hit ratio:** per-bucket percentages. **Breaker state:** a status timeline or badges per upstream.
  - **Restrained style:** subtle gridlines, consistent spacing, clear legends, **semantic status colours**.
    `isAnimationActive={false}`, linear segments (no curve smoothing), no decorative gradients.
- **States:** loading (skeletons), **empty** (no traffic yet, with a hint), **low traffic** (percentiles marked with
  `n=…`), **stale** (banner after 2 missed polls, with the last-updated time), unauthorized (back to the token gate), and
  API unreachable.
- **Design system:** none exists in the account, so the dashboard defines a **light, enterprise design system as
  tokens** (`src/design/tokens.css`):
  - A neutral grey scale; semantic success/warning/danger/info colours.
  - A colour-blind-safe series palette for p50/p95/p99.
  - A type scale; a 4/8 px spacing grid; radii; focus rings.
  - The same tokens are used across traffic, latency, error-rate and cache views. Light theme first; a dark theme
    can follow from the same tokens.
  - **Confirmed:** in-repo tokens only, versioned with the code.

## 5. Admin listener and API: `apps/gateway`
- A third Fastify instance on `config.admin`, **started only if `ADMIN_TOKEN` is set**.
- **Token rules:** constant-time comparison (SHA-256 of both sides, then `timingSafeEqual`). **Startup fails** if the token
  has fewer than 32 characters *(Claude-chosen)*. The token is never logged.
- **Errors:** 401 `ADMIN_AUTHENTICATION_FAILED` + `WWW-Authenticate: Bearer` in the normalized shape, with request IDs and
  one log line per request.
- **Endpoints:** read-only JSON. Contracts are **Zod schemas in a shared package**: the gateway tests its responses against
  them, and the UI validates every response with them.

  | Endpoint | Content |
  |---|---|
  | `GET /admin/api/stats` | `window` (aggregate) + `buckets[]` per route and in total (§2) |
  | `GET /admin/api/upstreams` | breaker snapshot + per-bucket attempts by outcome, failure rate, p95 |
  | `GET /admin/api/routes` | configured routes (prefix, methods, upstream, auth, limits, cache); no secrets |
  | `GET /admin/api/rate-limits` | policies, mode, Redis health / degraded state (ADR-0034) |
  | `GET /admin/api/cache` | entries, bytes, limits, evictions |

- **UI serving:** `/admin/ui/*` from the dashboard build, with correct content types, path traversal blocked and an
  `index.html` fallback.
- **Headers:** `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` on the API, long caching for hashed assets,
  and a strict CSP (`default-src 'self'`, no inline scripts).
- **Tests:**
  - The admin listener is off without a token; startup fails on a short token.
  - 401 for missing, wrong or wrong-scheme tokens; a client API key is rejected.
  - The API is absent on the public and operations ports.
  - **Every endpoint's numbers match traffic sent over sockets.**
  - Static serving rejects traversal; UI files load without a token.
  - Mutations: auth bypass, token-length check, static traversal.

## 6. `apps/dashboard`: React + TypeScript + Vite
- **Tooling:** pinned Vite 8 and React 19.
  - Its own `tsconfig` (DOM lib, `jsx: react-jsx`, the same strictness), wired into `pnpm typecheck`.
  - ESLint with `eslint-plugin-react-hooks` for `apps/dashboard/**`.
  - `base: '/admin/ui/'`; `vite dev` proxies `/admin/api` to `:9090`.
  - The bundle budget is checked by a script after `vite build`.
- **Structure:**
  - `src/api/`: a typed client that validates responses with the shared Zod contracts.
  - `src/data/`: pure transformations, unit-tested.
  - `src/charts/`: reusable presentation components.
  - `src/screens/`: overview, routes, upstreams, cache and rate limits.
  - `src/design/`: tokens and primitives.
- **Screens:**
  - **Token gate.**
  - **Overview:** KPI tiles plus latency, rate and error trend charts.
  - **Routes table:** sortable, with sparklines.
  - **Upstreams:** breaker states and failure trends.
  - **Cache:** hit-ratio trend and memory usage against its bounds.
  - **Rate limits:** rejections and Redis/degraded state.
- **Refresh:** poll every 5 s, with pause/resume. The window comes from the server, so a page reload shows the full last
  5 minutes immediately.
- **Tests:**
  - Vitest + Testing Library (jsdom): every state (loading, empty, low traffic, stale, 401), formatting, units.
  - `chart-data` transformation edge cases.
  - Contract fixtures that validate against the shared schemas.

## 7. Playwright end-to-end test (user: now)
- `@playwright/test` (pinned, Chromium only) runs against the Docker stack with the dashboard override:
  1. Open `/admin/ui/` and paste the token.
  2. Generate known traffic: successes, a 429, a cache hit, a breaker opening.
  3. Assert that the KPI and table values equal `/admin/api/stats` and the expected counts.
  4. Check that a wrong token returns to the gate.
- Screenshots and traces are uploaded as CI artifacts on failure.
- **CI:**
  - The check job builds, typechecks and tests the dashboard and enforces the bundle budget.
  - A new `e2e` job (or the docker job) installs Chromium (`playwright install --with-deps chromium`) and runs the suite.

## 8. Docker / Compose
- The build stage builds the dashboard; the gateway image ships its `dist`. The runtime image still has no dev
  dependencies, and its size is measured before and after.
- `docker-compose.dashboard.yml` sets a local-only `ADMIN_TOKEN`, mounts the dashboard example config, and publishes
  `127.0.0.1:9090:9090`. Script: `pnpm dev:dashboard`.

## 9. Order of work (each step is a commit point; mutations and docs in the same step)
1. Shared admin API contracts (Zod) + the `StatsWindow` time-series + unit tests + mutations.
2. Admin listener, auth and endpoints + socket integration tests (exit criterion on the API side).
3. Static UI serving + security headers + tests.
4. `apps/dashboard` scaffold: tooling in check/lint/typecheck, design tokens, API client, token gate, bundle-budget script.
5. Chart components + `chart-data` + screens + component and contract tests. **Re-measure the bundle** against the budget
   and record the Recharts/uPlot result in an ADR.
6. Docker/Compose override + Playwright e2e + CI jobs + Docker verification + docs (README, STATE, implementation ADR).

## 10. Out of scope
Write endpoints (route/key management), multi-instance aggregation, long-term history storage, a dark theme (tokens make
it easy later).

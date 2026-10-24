# Plan: admin API + dashboard (Phase 5 remainder)

_Status: **approved by the user on 2026-10-24**, revised the same day for the second review (percentile confidence, memory
bound, rate formulas, Docker boundary, bundle enforcement, Playwright determinism, full contracts). Decisions: ADR-0037 (amended)._

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

## 2. Rolling window: `packages/observability`
- **Buckets:** **30 × 10 s** (5 minutes), ring-indexed by `floor(t / 10 s) mod 30`. *t* is a monotonic clock anchored to the
  wall clock at startup and clamped to never run backwards (ADR-0038 review).
- **Series:** one per configured route, one for `unmatched`, one **total**, and one per configured upstream. The set of
  series is fixed at startup; unknown ids map to `unmatched`/`unknown`.
- **Allocated only when the admin listener is enabled** (`ADMIN_TOKEN` set). Otherwise it costs nothing.
- **Per bucket:** the counters in §2.3, plus a latency reservoir (Algorithm R, injected randomness) of **512 samples**,
  raised from 256 because of the p99 rule below.
- **Feeding:** the same hook points as `GatewayMetrics`, so both always count the same events (tested).

### 2.1 Percentile confidence, per percentile (review fix)
For percentile *q* ∈ {0.50, 0.95, 0.99}, the API returns
`{ value, method, observations, samples, effectiveSamples, tailSamples, confidence }`:
- **`method`:**
  - `"exact"` when every observation is retained (observations ≤ 512 per bucket).
  - `"sampled"` when the reservoir holds a uniform sample. The window always uses `"sampled"` once any bucket was sampled.
- **`samples`** = retained samples. **`effectiveSamples`** = the same for a bucket; for the window,
  min(Kish ESS, Woodruff stratified ESS), because unequal weights *and* different bucket distributions both reduce
  the information in a merge. **`tailSamples`** = ⌊effectiveSamples × (1 − q)⌋.
- **`confidence`** *(revised twice by the ADR-0038 reviews; full analysis there)*:
  - `"none"`: no observations; `value: null`, drawn as a gap.
  - `"low"`: effective samples below the exact threshold **383 / 484 / 1,707** for p50 / p95 / p99 (tolerance
    ±5 / ±2 / ±0.5 points). Value shown, visibly marked.
  - `"adequate"` (buckets only): at or above the threshold. Exact order-statistic coverage ≥ 95 % *under the model*
    "independent draws from one continuous distribution"; not a claim about reality.
  - `"approximate"` (windows only): both effective sizes meet the threshold. Empirically calibrated, no exact guarantee.
  - The UI never says "95 %"; the tooltip gives n, the threshold and the label's meaning.
- **Consequences:**
  - A per-bucket p99 is never `adequate` (≤ 512 samples), and the window p99 is at most `approximate`.
  - Per-bucket p50 and p95 become `adequate` at ≈ 38 and 48 req/s.
  - The UI never hides this.
- **Window quantile:** a weighted quantile over all live reservoirs, each sample weighted by
  bucket observations ÷ bucket samples, never derived from `/metrics` histograms.
- **Tests:**
  - Exact values on small known inputs.
  - The weighted quantile and ESS against brute-force references.
  - Each threshold is the smallest n whose exact coverage stays ≥ 95 %; labels at n − 1 / n; window never `adequate`.
  - Exact → sampled switch-over at 512; window method and ESS when buckets mix exact and sampled.

### 2.2 Memory layout and total bound (review fix)
Fixed-size **typed arrays**, preallocated at startup. Nothing grows with traffic.

| Per series | Layout | Bytes |
|---|---|---|
| Latency samples | `Float32Array(30 × 512)` (ms; float32 is ample for latency) | 61,440 |
| Retained sample count per bucket | `Uint16Array(30)` | 60 |
| Observations per bucket | `Uint32Array(30)` | 120 |
| Bucket start times | `Float64Array(30)` | 240 |
| Counters, route series | `Uint32Array(30 × 36)` (§2.3) | 4,320 |
| Counters, upstream series | `Uint32Array(30 × 4)` | 480 |

- **Payload:** **66,180 B (64.6 KiB) per route series**, **62,340 B (60.9 KiB) per upstream series**.
- **Total bound:** **(R + 2) × 64.6 KiB + U × 60.9 KiB**, plus small fixed object overhead per series. For example:
  - 10 routes / 5 upstreams: 1.05 MiB
  - 50 / 20: 4.47 MiB
  - 200 / 100: 18.69 MiB
- The computed bound is logged at startup.
- **Benchmark (required):** `scripts/bench-stats-window.ts` (run with `--expose-gc`, also in CI) builds windows for
  10/5, 50/20 and 200/100 routes/upstreams, fills **every** bucket and reservoir, and measures the change in
  `heapUsed + arrayBuffers`. It asserts the result is within the formula + 15 %, and that it doesn't grow after a further
  1,000,000 recorded requests. Results go into the implementation ADR.
- Mutation: replace the typed reservoir with an unbounded array → the benchmark and unit bound tests fail.

### 2.3 Counters and every rate's formula (review fix)
Per route bucket, **36 counters**:
- `requests` (completed responses) and `aborted` (client left before the response finished).
- `status{1xx..5xx}`.
- `code{…15 registry codes…}`.
- `rl{allowed, rejected, degraded}` and `rlUnavailable`.
- `cache{hit, miss, bypass}` and `store{stored, notStorable, tooLarge}`.
- `attempts{success, failure, aborted}` and `retries`.

**Rates** in the contract, and in tests against known traffic. A rate is **`null` when its denominator is 0**, never 0 %.

| Rate | Numerator | Denominator | Notes |
|---|---|---|---|
| `rps` | `requests` | seconds covered (a partial bucket uses its real elapsed time) | aborted excluded |
| `successRate` | `status.2xx + status.3xx` | `requests` | |
| `clientErrorRate` | `status.4xx` | `requests` | includes gateway 4xx (401/404/429…) and upstream 4xx |
| `errorRate` (server) | `status.5xx` | `requests` | includes gateway 502/503/504 and upstream 5xx |
| `abortRate` | `aborted` | `requests + aborted` | aborted requests have no status |
| `rateLimitRejectionRate` | `rl.rejected` | `rl.allowed + rl.rejected` | only requests that **reached the limiter**: 401/404/400 never do; `degraded` counts within `allowed`/`rejected` and is reported separately |
| `rateLimiterUnavailableRate` | `rlUnavailable` | `rl.allowed + rl.rejected + rlUnavailable` | fail-closed 503s |
| `cacheHitRatio` | `cache.hit` | `cache.hit + cache.miss` | **bypasses excluded**, so they can't distort the ratio |
| `cacheBypassRate` | `cache.bypass` | `cache.hit + cache.miss + cache.bypass` | shown next to the hit ratio |
| `cacheStoreRate` | `store.stored` | `cache.miss` | misses that were stored |
| `upstreamFailureRate` (route and upstream) | `attempts.failure` | `attempts.success + attempts.failure` | **per attempt**, not per request; `aborted` is neutral (ADR-0024) and reported separately |
| `retryRate` | `retries` | requests that reached the upstream (`attempts` − `retries`) | |

Window aggregates sum the bucket counters first, then divide, never averaging per-bucket rates.

### 2.4 Honesty rules in the contract
- Buckets from before the process started are **omitted**, not zero-filled; `collectingSince` is included.
- The newest bucket is `partial: true` with its real `durationMs`.
- Empty buckets report zeros and `null` rates and percentiles, so the UI draws gaps: no interpolation, no smoothing.
- Each response names the **instance**; there is no cross-instance aggregation here.

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
- **Budget, enforced in CI against the real production build** (review): `scripts/check-bundle.ts` reads Vite's
  `manifest.json` after `vite build`.
  - **Initial JS** = the entry chunk plus its static imports, gzip −9: **≤ 120 KB**.
  - **Total JS** = every emitted chunk: **≤ 260 KB**.
  - It prints a per-chunk table and fails the job on a breach.
- **If the real dashboard breaches the budget:** first measure the production build (the script's table plus
  `rollup-plugin-visualizer` once, locally) and look for fixable causes such as eager imports, duplicate dependencies, or
  icons. Only then compare against a uPlot build of the same screens, and record the numbers in an ADR before switching.

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
- **Endpoints:** read-only JSON. Every contract is a **Zod schema in a shared package**
  (`packages/admin-contract`, imported by both the gateway and the dashboard). The gateway's tests validate real responses
  against these schemas, and the UI validates every response with the same schemas. **Full contracts: §5.1.**
- **UI serving:** `/admin/ui/*` from the dashboard build, with correct content types, path traversal blocked and an
  `index.html` fallback.
- **Headers:** `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` on the API, long caching for hashed assets,
  and a strict CSP (`default-src 'self'`, no inline scripts).
- **Security boundary (review):**
  - **Every** `/admin/api/*` route goes through one Bearer-auth hook registered before the routes. A test enumerates the
    registered routes and asserts that none bypasses it.
  - In Docker the admin listener binds `0.0.0.0` *inside* the container, so **other containers on the Compose network can
    reach it**; publishing to `127.0.0.1` only limits host access. The token is therefore the real boundary. The Docker
    verification curls `gateway:9090/admin/api/stats` from the `orders-mock` container: 401 without the token, 200 with it.
  - The CSP and security headers are asserted in both the socket tests and Playwright.
- **Tests:**
  - The admin listener is off without a token; startup fails on a short token.
  - 401 for missing, wrong or wrong-scheme tokens on **every** endpoint; a client API key is rejected.
  - The public and operations listeners serve no `/admin/*` path (404 on both).
  - **Every endpoint's numbers match traffic sent over sockets**, including each rate formula in §2.3.
  - Static serving rejects traversal (`..`, `%2e%2e`, absolute paths); UI files load without a token.
  - Mutations: auth hook skipped for one route, token-length check, static traversal, unweighted window quantile,
    cache bypass counted in the hit ratio.

### 5.1 Admin API contracts (all five endpoints)
Common envelope:
`{ instance: { id, startedAt }, generatedAt, window: { seconds: 300, bucketSeconds: 10, collectingSince } }`.
Time series below means `{ window: Aggregate, buckets: Bucket[] }`. A `Bucket` holds counters, rates and latency for its
10 s (`start`, `durationMs`, `partial`). `Percentile` is defined in §2.1; rates are defined in §2.3.

| Endpoint | Body | Feeds |
|---|---|---|
| `GET /admin/api/stats` | `total` and `routes[]` time series: requests, `rps`, `status{}`, `codes{}`, all request-level rates, `latency{p50,p95,p99: Percentile}`, retries | Overview KPI tiles and trend charts, Routes table and sparklines |
| `GET /admin/api/upstreams` | `upstreams[]: { id, baseUrl, breaker: { state, consecutiveFailures, halfOpenInFlight, settings }, attempts{success, failure, aborted}, upstreamFailureRate, latency (attempt latency) }`, each as a time series | Upstreams screen: breaker badges, failure-rate and latency trends |
| `GET /admin/api/routes` | `routes[]: { id, pathPrefix, methods, upstreamId, stripPrefix, auth.required, rateLimit{capacity, refillRatePerSecond}, timeoutMs, attemptTimeoutMs?, retries, cache{enabled, ttlSeconds, scope, varyHeaders, maxResponseBytes}, forwarding }`. Configuration only; no clients, keys or upstream credentials | Routes screen detail panel |
| `GET /admin/api/rate-limits` | `{ mode, redisFailurePolicy?, backend: { kind: "local" \| "redis", healthy, target? (host:port only), degraded }, maxBuckets, routes[]: { id, policy{capacity, refillRatePerSecond}, rl{allowed, rejected, degraded}, rlUnavailable, rateLimitRejectionRate, rateLimiterUnavailableRate } }`, each as a time series | Rate-limits screen: policy table, rejection trends, Redis health and degraded banner |
| `GET /admin/api/cache` | `{ limits{maxEntries, maxBytes}, usage{entries, bytes}, evictions{ window{capacity, expired}, lifetime{capacity, expired} }, routes[]: { id, scope, ttlSeconds, cache{hit, miss, bypass}, store{stored, notStorable, tooLarge}, cacheHitRatio, cacheBypassRate, cacheStoreRate } }`, each as a time series | Cache screen: hit-ratio trend, bypass share, store outcomes, memory gauge against limits |

**Screen-to-data check:** every number on every screen in §6 comes from exactly one field above (tracked in the
implementation ADR). The contract tests fail if a screen fixture uses a field the schema doesn't define.

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
- **Refresh:** poll every 5 s, with pause/resume and a **"Refresh now"** button (also used by the Playwright tests). The window comes from the server, so a page reload shows the full last
  5 minutes immediately.
- **Tests:**
  - Vitest + Testing Library (jsdom): every state (loading, empty, low traffic, stale, 401), formatting, units.
  - `chart-data` transformation edge cases.
  - Contract fixtures that validate against the shared schemas.

## 7. Playwright end-to-end test (user: now), deterministic (review)
- **A dedicated stack:** `docker-compose.e2e.yml` (on top of the dashboard override) with `config/routes.e2e.yaml`.
  A loader test keeps that file valid. It defines four routes, each with one job:
  - `e2e-ok`: a healthy mock.
  - `e2e-limited`: capacity 3, refill 0.001/s.
  - `e2e-cached`: TTL 600 s.
  - `e2e-faulty`: its own upstream with `failureThreshold: 2` and `openDurationMs: 600000`, so the breaker cannot close
    during the test.
- It also has a fixed e2e `ADMIN_TOKEN`.
- **Known traffic, generated by the test itself** (Playwright `request` fixture), before opening the UI:
  - 10 × `e2e-ok`.
  - 5 × `e2e-limited` → exactly 3 allowed and 2 rejected.
  - 1 + 4 × `e2e-cached` → 1 miss and 4 hits.
  - 3 × `e2e-faulty?_reset=1` → 2 failed attempts open the breaker, and the 3rd gets `CIRCUIT_OPEN`.
  - Faults are explicit (`_reset`), never incidental timing.
- **Assertions are on exact counts and rates** in the UI, through `data-testid`s, matched against the same numbers from
  `/admin/api/*`. Examples: the cache hit ratio is 80 %, the rejection rate is 40 %, the breaker badge says "open".
- **Waiting:** web-first assertions and `expect.poll` with a deadline, plus the dashboard's **"Refresh now"** button. No
  fixed sleeps. The whole run takes well under 5 minutes, so all traffic stays inside the window.
- **Isolation and cleanup:** a fresh stack per run (`compose up --wait`), always followed by `compose down -v`, even on
  failure. Retries are disabled, so a flaky test shows up as red rather than being retried into green.
- **Also checked:** a wrong token goes back to the gate, the CSP header is present, and nothing is served on `/admin/*` of
  the public port.
- **CI:** a dedicated `e2e` job installs Chromium (`playwright install --with-deps chromium`). Traces and screenshots are
  kept as artifacts on failure. Locally: `pnpm test:e2e`.

## 8. Docker / Compose
- The build stage builds the dashboard; the gateway image ships its `dist`. The runtime image still has no dev
  dependencies, and its size is measured before and after.
- `docker-compose.dashboard.yml` sets a local-only `ADMIN_TOKEN`, mounts the dashboard example config, and publishes
  `127.0.0.1:9090:9090`. Script: `pnpm dev:dashboard`.

## 9. Order of work (each step is a commit point; mutations and docs in the same step)
1. `packages/admin-contract` (Zod, §5.1) + the `StatsWindow` (§2: typed arrays, confidence rules, rate formulas) + unit
   tests + the memory benchmark + mutations.
2. Admin listener, auth and endpoints + socket integration tests (exit criterion on the API side).
3. Static UI serving + security headers + tests.
4. `apps/dashboard` scaffold: tooling in check/lint/typecheck, design tokens, API client, token gate, bundle-budget script.
5. Chart components + `chart-data` + screens + component and contract tests. **Re-measure the bundle** against the budget
   and record the Recharts/uPlot result in an ADR.
6. Docker/Compose dashboard + e2e overrides + deterministic Playwright + CI jobs (bundle budget, benchmark, e2e) + Docker
   verification, including the cross-container 401 check + docs (README, STATE, implementation ADR).

## 10. Out of scope
Write endpoints (route/key management), multi-instance aggregation, long-term history storage, a dark theme (tokens make
it easy later).

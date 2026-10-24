# ADR-0042: Dashboard charts, screens and polling; Recharts confirmed by measurement (dashboard step 5)

- **Status:** Accepted (implements the approved plan `docs/plans/dashboard.md` §3, §4, §6; details below to review)
- **Date:** 2026-10-24
- **Implements:** `apps/dashboard/src/{charts,data/chart-data.ts,api/use-poll.ts,app/ScreenFrame.tsx,app/navigation.ts,screens/*}`

## Recharts vs uPlot: re-measured on the real build
| Bundle (gzip -9, `pnpm bundle:check`) | Measured | Budget |
|---|---|---|
| Initial JS: React, Zod + contract, gate, shell | **94.6 KB** | 120 KB |
| Total JS: + Recharts chunk (102.0 KB, lazy) + 5 screen chunks (0.8–2.1 KB) | **203.9 KB** | 260 KB |

- The real dashboard stays inside both budgets with 25 KB and 56 KB of headroom, so plan §3's fallback (uPlot) is
  **not** triggered.
- Recharts loads only after the token gate, in a chunk shared by all screens.
- The chart chunk costs about 102 KB in the real build, close to plan §3's isolated measurement (+106 KB).
- **CSP:** Recharts 3.10.1 injects no `<style>` and uses no `innerHTML`. It sets inline sizes through React's `style`
  prop, i.e. the CSSOM, which `style-src 'self'` allows. Verified in a real browser: every screen rendered under the
  gateway's CSP with no console errors or violations. Playwright repeats this check in step 6.

## Decisions made while implementing *(Claude-chosen within the plan)*
- **Data stays outside presentation:** `chart-data.ts` turns API buckets into chart points, with `null` for missing values
  (drawn as gaps; `connectNulls` is off). Each point carries notes for the tooltip and the table:
  - "In progress: 4.0 s so far" on the partial bucket;
  - "p99 low confidence (n=12)", taken from the ADR-0038 labels;
  - the denominator, e.g. "of 5 lookups (bypasses excluded)".
- **One reusable `TimeSeriesChart`:**
  - It is a `<figure>` named by its title and described by its description, with a visually hidden `<table>` of the
    same data, formatted values and notes. The SVG itself is `aria-hidden`.
  - Linear segments, `isAnimationActive={false}`, horizontal gridlines only, and no gradients.
  - Percentages use a fixed 0–100 % axis, so a small rate never looks like a spike. Other units start at 0.
  - A dot is drawn only where a value has no neighbour (a single bucket, or a point between gaps), so isolated data
    stays visible without cluttering lines.
- **Colours only through CSS classes:**
  - Each series class sets `--pg-series-color` and `--pg-series-dash`, used by lines, dots, legend swatches and
    tooltips alike. No colour is hard-coded in components.
  - p50/p95/p99 differ by dash pattern as well as colour (solid, dashed, dotted), and so do 5xx/4xx.
- **Sparklines:** about 40 lines of plain SVG with gaps and a minimum tick for lone points, not Recharts, so the Routes
  table doesn't mount 30 chart instances.
- **Polling (`usePoll`):**
  - 5 s polls that never overlap: the next one is scheduled when the previous settles.
  - Each poll is cut off at the interval through one `AbortController` plus a timer, so a hung gateway counts as a miss.
    `AbortSignal.any` + `AbortSignal.timeout` was replaced because jsdom never fires the combination.
  - **Pause** stops the schedule without refetching. **Resume** and **Refresh now** fetch at once, even while paused.
  - A 401 goes back to the token gate and stops polling.
  - Data is kept through failures; after 2 consecutive misses a stale banner shows the last-updated time and the error.
- **Screens:**
  - **Overview:** 6 KPI tiles (low-confidence p95/p99 show "low confidence, n=…") plus latency, throughput and
    4xx/5xx charts. A quiet window shows an empty state instead of flat charts.
  - **Routes:** a sortable table (`aria-sort`, nulls last) with sparklines, and a detail panel with configuration and
    trends.
  - **Upstreams:** breaker badges in text plus shape (never colour alone), attempt failure rate, the breaker policy, and
    failure-rate and attempt-latency charts. While a breaker is open, the consecutive-failure counter explains that it
    was reset when the breaker opened.
  - **Cache:** `<meter>` gauges for entries and bytes against their limits, lifetime evictions, and per route the hit
    ratio, bypass share, store rate and a hit-ratio trend.
  - **Rate limits:** backend kind and health; a fail-open "degraded" banner and a fail-closed "unavailable" banner; a
    policy table with rejection rates; trends for routes that had limiter decisions.
  - `retryRate` is shown as "/ req" (ADR-0039).
- **Navigation:**
  - The History API (no router dependency): real URLs `/admin/ui/{routes,upstreams,cache,rate-limits}`, so reload and
    back work. The gateway serves `index.html` for these paths (ADR-0040).
  - A skip link, `aria-current`, and modified clicks open new tabs as usual.
  - `UI_BASE` is one constant shared by `vite.config.ts` and the app.
- **`data-testid`s for Playwright** (plan §7): `kpi-*`, `route-{column}-{id}`, `breaker-{upstream}` (`data-state`),
  `upstream-failure-rate-*`, `cache-hit-ratio-*`, `rejection-rate-*`, `rate-limit-degraded`, `stale-banner`,
  `refresh-now`.

## Verified (2026-10-24)
- **Dashboard tests:** 88 in total (44 new in this step).
  - **chart-data (12):** gaps, partial bucket, low-confidence notes, a single bucket, percent conversion, denominators,
    quiet window, sparkline paths, sorting.
  - **usePoll (8, fake timers):** cadence without overlap, stale after 2 misses and recovery, error without data,
    pause/resume, refresh while paused, 401 stops, timeout counts as a miss, abort on unmount.
  - **Charts (7):** figure naming, the table alternative with units, gaps and notes, percentages, sparkline label,
    breaker badge text.
  - **Screens (14):** each screen against fixtures from the real `StatsWindow` carrying plan §7's traffic mix
    (80 % hits, 40 % rejections, open breaker); stale banner; unreachable + retry; pause/refresh; the young-window note.
  - **Navigation (2):** URLs, `aria-current`, back, and deep links.
- **Real browser run:** a local gateway and mock upstream with plan §7's four routes and its exact traffic.
  - Every screen showed the expected numbers: 3 allowed / 2 rejected = 40 %, 1 miss + 4 hits = 80 %, faulty breaker
    Open at 100 % failures.
  - No console errors.
- **Mutations:** 8 new, 67 in total, all caught: gaps drawn as zeros, ratio not converted to a percentage, bypass in the
  hit-ratio denominator, stale after 1 miss, pause ignored, polling after a 401, low-confidence note hidden, navigation
  without URLs.
  - The run also exposed a now-unused `use-resource.ts`: its mutation survived because no screen used it. The file was
    deleted and the mutation re-pointed at `usePoll`.

## Consequences
- Step 6 runs these screens in Playwright against the Docker stack, asserting the same numbers via the test IDs and that
  no CSP violation is reported.
- A dark theme can follow from the tokens (plan §4); nothing in the components assumes light colours.

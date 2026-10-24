# ADR-0041: Dashboard scaffold, tooling, API client and token gate (dashboard step 4)

- **Status:** Accepted (implements the approved plan `docs/plans/dashboard.md` §3, §4, §6 and ADR-0037; details below to review)
- **Date:** 2026-10-24
- **Implements:** `apps/dashboard`, `scripts/check-bundle.ts`, root tooling (typecheck, ESLint, Vitest projects, CI step)

## Decisions made while implementing *(Claude-chosen within the plan)*
- **Pinned versions:** Vite 8.3.5 and React 19.3.1 (the versions measured in plan §3), `@vitejs/plugin-react` 6.1.2,
  `@types/react(-dom)` 19.3.0, Testing Library (react 16.3.3, dom 10.4.2, user-event 14.6.8), jsdom 30.1.3,
  `eslint-plugin-react-hooks` 7.1.1. Recharts arrives with the charts in step 5.
- **Tooling, all inside `pnpm check`:**
  - **Typecheck:** a second `tsc -p apps/dashboard/tsconfig.json` (DOM lib, `jsx: react-jsx`, Bundler resolution,
    the same strict flags). The root project excludes `apps/dashboard`.
  - **Lint:** the same strict type-checked rules plus `react-hooks` (recommended-latest) and browser globals for
    `apps/dashboard/src`.
  - **Tests:** Vitest `projects`: `node` (everything as before, plus `scripts/**/*.test.ts`) and `dashboard` (jsdom).
    `pnpm vitest run <path>` filters work as before.
- **Workspace source in the browser:** Vite resolves `@pulsegate/source`, so `@pulsegate/admin-contract` and
  `@pulsegate/shared` are bundled from TypeScript. No build step, and the contract is never duplicated.
  `MIN_ADMIN_TOKEN_LENGTH` moved into the contract, so the gateway and the token gate share it.
- **Build:** `base: '/admin/ui/'`, a manifest for the budget, `assetsInlineLimit: 0` (no `data:` scripts or styles,
  for the CSP), and source maps. `vite dev` proxies `/admin/api` to `127.0.0.1:9090`. The Dockerfile lists the new
  manifest; step 6 ships the `dist`.
- **API client (`src/api/client.ts`):**
  - Same origin, `Authorization: Bearer`, `cache: no-store`, `credentials: omit`, `redirect: error`, and a 10 s timeout.
  - Every response is validated with the shared Zod schemas.
  - Errors are typed: `unauthorized` (401), `unreachable` (no response or timeout), `invalid-response` (not JSON, or
    off-contract, naming up to 3 field paths), and `http`.
  - A caller's own abort propagates instead of being reported as a failure. Error messages never contain the token.
- **Token handling (ADR-0037):**
  - `sessionStorage` key `pulsegate.adminToken`. If storage is blocked, the token is kept in memory for the page.
    Never `localStorage`, cookies or URLs.
  - **The gate:** a password field without autocomplete. It checks the shared minimum length first, then verifies the
    token with `GET /admin/api/stats` before keeping it.
  - **Rejection:** a 401 anywhere clears the token and returns to the gate with a notice. An unreachable API is shown
    as an error on the screen and keeps the token.
- **Shell:** after the gate, a header with sign-out and a lazily loaded Overview (window KPIs only). Charts, polling,
  staleness and the other screens are step 5.
- **Design tokens (`src/design/tokens.css`):**
  - A cool neutral scale; semantic success/warning/danger/info, each with a tinted surface; an Okabe–Ito-derived
    series palette for p50/p95/p99 (the charts will also differ by line style).
  - A type scale on a 1.2 ratio from 14 px, using system fonts (nothing to download, nothing for the CSP to allow).
  - A 4/8 px spacing grid, radii, shadows, a focus ring, and `prefers-reduced-motion`.
  - **Contrast is tested, not assumed:** every text/surface pair is ≥ 4.5:1 (WCAG AA).
- **Formatting (`src/data/format.ts`):** `null` is always "—", never 0. Percentages are never rounded to a false 0 % or
  100 %. Every number carries its unit: req/s, ms (switching to s at 10 s), and retries as "/ req" (ADR-0039).
- **Budget script (`scripts/check-bundle.ts`, `pnpm bundle:check`, run in CI after the build):**
  - Initial = entries plus static imports, transitively. Total = every emitted `.js`. Both gzip -9, against 120 / 260 KB.
  - It prints a per-chunk table, and also fails on inline `<script>`, `<style>`, `style=` or `on*=` in the built
    `index.html`, which the CSP would block.

## Measured (2026-10-24, this build)
- **Initial JS: 93.6 KB gz** (budget 120). **Total: 94.8 KB gz** (budget 260). The lazy Overview chunk is 1.2 KB.
- React alone measured 66.2 KB (plan §3), so Zod, the contract and the app code add about 27 KB to the initial load.
  That is the price of validating responses before anything renders.
- Expected after step 5: about 95 + 106 (Recharts, lazy) ≈ 201 KB total, which leaves room within the total budget.
- **Real browser check:** the built UI was served by a locally running gateway (`PULSEGATE_ADMIN_UI_DIR`, a generated
  local test token).
  - Gate → token verification → lazy Overview chunk → `/admin/api/stats` all loaded under the strict CSP.
  - The console had no errors or CSP violations.

## Verified
- **44 dashboard tests:**
  - **Client (10):** headers, all five endpoints, contract pass and fail, 401 / other status / non-JSON / network /
    timeout / caller abort.
  - **Token store (4)**, **format (7)**.
  - **Gate (6):** masked field, length rule before any request, verification, trimming, rejected and unreachable
    messages, token never shown.
  - **Shell (6):** stored token → KPIs with a low-confidence note; 401 → gate with notice and token cleared;
    unreachable → error, token kept; sign out; accept and store.
  - **Contrast (11).**
- **Bundle script tests (11):** transitive initial set, dynamic imports excluded, both budgets, missing entry, and each
  inline-code pattern.
- Fixtures come from the gateway's real `StatsWindow`, then go through the shared schema.
- **Mutations:** 6 new (59 in total), all caught: token in `localStorage`, validation skipped, gate accepts an unverified
  token, 401 shown as an error, dynamic imports counted as initial, inline script allowed.

## Consequences
- Step 5 adds Recharts behind `React.lazy` and re-measures with `pnpm bundle:check`. If the total breaches 260 KB, follow
  plan §3: measure, fix eager imports first, and only then compare against uPlot in an ADR.
- Charts must keep all styling in CSS files or through the CSSOM: no `style=` in HTML and no injected `<style>`.

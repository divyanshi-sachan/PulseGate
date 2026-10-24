# ADR-0043: Dashboard in Docker, Playwright end to end, CI (dashboard step 6)

- **Status:** Accepted (implements the approved plan `docs/plans/dashboard.md` §5, §7, §8; details below to review)
- **Date:** 2026-10-24
- **Implements:** `Dockerfile`, `docker-compose.{dashboard,e2e}.yml`, `config/routes.{dashboard.example,e2e}.yaml`,
  `playwright.config.ts`, `tests/e2e/`, `scripts/e2e.sh`, the CI `e2e` job, `apps/dashboard/src/zod-config.ts`

## Decisions made while implementing *(Claude-chosen within the plan)*
- **Image:** the build stage builds the dashboard (already part of `pnpm build`). The gateway image ships only what is
  served, root-owned and read-only for the `node` user, and sets `PULSEGATE_ADMIN_UI_DIR=/app/ui`. Source maps and Vite's
  manifest are stripped (they were 3.6 MB of the 4.3 MB `dist`).
  - Runtime image measured with `docker image inspect --format '{{.Size}}'`: **90.07 MB before, 90.28 MB after
    (+0.21 MB)**. `/app/ui` is 732 KB on disk. No dev dependencies were added to the runtime image.
- **`pnpm dev:dashboard`:** `docker-compose.dashboard.yml` on top of the base stack.
  - It mounts `config/routes.dashboard.example.yaml`, with `admin.host: 0.0.0.0` inside the container.
  - It publishes `127.0.0.1:9090:9090` only.
  - `ADMIN_TOKEN` defaults to a local-only value (`pulsegate-local-dashboard-token-not-a-secret`, 44 characters) and
    can be overridden from the environment.
- **The e2e stack** layers `docker-compose.e2e.yml` (the e2e config and a fixed 38-character e2e token) on top of the
  dashboard override.
  - It runs as Compose project `pulsegate-e2e`, so it never touches a running dev stack, but it uses the same host ports.
  - `config/routes.e2e.yaml` has the plan's four single-purpose routes. `e2e-faulty` has its own upstream (`faulty-service`,
    threshold 2, open for 10 min).
  - Loader tests keep both new config files valid.
- **`pnpm test:e2e` (`scripts/e2e.sh`):**
  1. `compose down -v`, then `up --build --wait` (a fresh stack every run).
  2. **Docker boundary checks (plan §5):**
     - From the `orders-mock` container, `gateway:9090/admin/api/stats` answers 401 without the token and 200 with it,
       which proves the token is the real boundary inside the Compose network.
     - The host gets `/admin/ui/` with 200 and the strict CSP.
  3. Playwright.
  4. A `trap` always runs `compose down -v`. `E2E_KEEP_STACK=1` skips it, so CI can collect logs first.
- **Playwright (1.64.1, Chromium only), deterministic:**
  - One worker, `retries: 0`, `forbidOnly` in CI, web-first assertions, "Refresh now" before reading a screen, and no
    sleeps.
  - The traffic is sent by the tests themselves, sequentially, with exact status assertions:
    - 10 × `e2e-ok`;
    - 5 × `e2e-limited` → `[200, 200, 200, 429, 429]`;
    - 5 × `e2e-cached` → `X-Cache` `MISS, HIT, HIT, HIT, HIT`;
    - 3 × `e2e-faulty?_reset=1` → `[502, 502, 503]`.
  - **Assertions:**
    - total requests 23 (API) = KPI tile;
    - `e2e-limited` 40 % on Routes and Rate limits;
    - `e2e-cached` 80 % on Routes and Cache, and the API's `cacheHitRatio` is exactly 0.8;
    - `e2e-faulty` 100 % 5xx and 100 % attempt failures;
    - the `faulty-service` breaker is `open`, while `orders-service` stays `closed`.
  - **Also checked:**
    - a wrong token stays at the gate; reload keeps the screen and the session; a revoked token returns to the gate
      with the notice;
    - `/admin/*` is 404 on the public port;
    - the UI's CSP header is present;
    - **no `securitypolicyviolation` event and no console error** on any screen.
- **CI `e2e` job:** installs Chromium (`playwright install --with-deps chromium`) and runs `pnpm test:e2e`. On failure
  it uploads `playwright-report/` and `test-results/` (traces, screenshots; 7 days) and prints the Compose logs. It
  always tears the stack down.
- **TypeScript:** the e2e specs contain browser code (`page.evaluate`), so `tests/e2e` has its own tsconfig with DOM
  types, run by `pnpm typecheck`. Specs are `*.spec.ts`, so Vitest never picks them up.

## Found by the end-to-end test: Zod probes `eval` under the strict CSP
- The first run passed every numeric assertion but reported `script-src eval`. Zod 4 probes `new Function("")` to enable a
  JIT-compiled object parser. The probe is caught, but the browser still reports it as a CSP violation. The earlier
  manual browser-pane checks didn't surface it.
- **Fix:** `z.config({ jitless: true })` in `src/zod-config.ts`, which is the **first import of `main.tsx`**. Zod
  decides when each schema is constructed, and the contract's schemas are constructed as soon as their module is
  evaluated.
- `main.test.ts` guards the import order and the setting. A mutation (`zod-not-jitless`) proves the guard works.
- Cost: Zod's interpreted parser instead of the JIT one, which is irrelevant for a few responses every 5 seconds.
- **The CSP was not loosened**: no `'unsafe-eval'` anywhere.

## Verified (2026-10-24, Docker 29.6.1)
- `pnpm test:e2e` ran three times in a row:
  - all 4 Playwright tests passed each time (about 8 s for the tests);
  - the cross-container check gave 401 without the token and 200 with it;
  - no containers were left afterwards.
- One earlier run failed before starting, on a transient Docker Desktop proxy EOF while fetching
  `docker/dockerfile:1`. A retry a few seconds later succeeded; it was unrelated to the code.
- The CI `e2e` job is defined but **not yet run on GitHub**: it runs on the next push.

## Consequences
- **Phase 5's exit criterion is met:** the dashboard's numbers match traffic sent through the gateway, in socket-level
  API tests (ADR-0039) and in Playwright against the Docker stack.
- Next: Phase 6 (release and benchmarks).

# ADR-0040: Admin UI static serving and security headers (dashboard step 3)

- **Status:** Accepted (implements the approved plan `docs/plans/dashboard.md` §5 and ADR-0037; details below to review)
- **Date:** 2026-10-24
- **Implements:** `apps/gateway/src/admin/static-ui.ts`, UI routes in `admin-server.ts`, `apps/gateway/test/admin-ui.test.ts`

## Decisions made while implementing *(Claude-chosen within the plan)*
- **Where the build comes from:** `PULSEGATE_ADMIN_UI_DIR` (`createGateway({ adminUiDir })`), used only with the admin
  listener.
  - Unset or empty: `/admin/ui/*` is 404, and a startup line says the UI is not served. The API works as before.
  - Set but without an `index.html`: startup fails (`GatewayStartupError`), so a broken image can't come up half-working.
  - Step 6 sets it in the Docker image.
- **No `@fastify/static`:** a ~100-line resolver whose every rule is tested and explainable, with no new dependency.
- **The token exemption follows the matched route, not the URL.** UI routes are registered with `config.public`, and
  the auth hook skips only requests whose *matched route* carries it. A string prefix check could disagree with the
  router; this can't. Not-found requests, and methods other than GET/HEAD on UI paths, still need the token.
- **Routes:** `GET /admin/ui` → 308 to `/admin/ui/`; `GET|HEAD /admin/ui/*` → a file.
- **Path rules (fail closed, in order):**
  1. The raw path passes the proxy's ADR-0019 checks: no `\`, valid %-encoding, no `.`/`..` segments even encoded.
  2. Each **decoded** segment must be non-empty and contain no `/`, `\` or NUL, and must not start with `.`. This blocks
     encoded separators (`..%2f`), `//` absolute-path tricks, and hidden files such as `.env`.
  3. The real path, with symlinks followed, must stay inside the real root.
  4. Only allow-listed extensions are served (html, js, mjs, css, json, map, svg, png, ico, webp, woff2, txt). A
     `config.yaml` in the build is never served.
- **Fallback:** a path **without an extension** that matches no file gets `index.html` (client-side routes). A missing
  asset is a JSON 404, never the HTML page, so a broken deploy fails visibly.
- **Caching:** `assets/*` (Vite's content-hashed output) gets `public, max-age=31536000, immutable`. Everything else,
  `index.html` above all, gets `no-cache`, so a new build is picked up at once. UI error responses get `no-store`.
- **Headers on every UI response:**
  - CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self';
    connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
  - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
    `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.
  - API responses keep their stricter `default-src 'none'` CSP.
- **Risk to check in step 5:** `style-src 'self'` forbids `<style>` elements and `style="…"` attributes in the HTML.
  React's `style` prop and Recharts set styles through the CSSOM, which CSP allows, but this must be confirmed in the
  browser (Playwright asserts no CSP violations). If a library needs inline styles, record it in an ADR rather than
  loosening the policy silently.
- **HEAD:** Fastify's generated HEAD route keeps `content-length` and drains the file stream.

## Verified (2026-10-24)
- **32 socket tests** (`admin-ui.test.ts`), plus the route-enumeration test in `admin.test.ts`, which now asserts that
  the only public routes are `/admin/ui` and `/admin/ui/*`, while every other route returns 401 without a token.
  - **Serving:** `index.html` without a token, with every header; the 308 redirect; hashed assets immutable with the
    right content types; HEAD; client-route fallback; a missing asset → 404 JSON.
  - **20 attack paths:** `..` (raw, `%2e`, mixed, double-encoded), `..%2f` / `%5c` / `\`, `//etc/passwd`,
    `%2Fetc%2Fpasswd`, an encoded absolute path, `%00`, invalid %-encoding, `.env` (raw and `%2e`), a non-allow-listed
    file, a symlink to a file outside, and a symlinked parent directory.
    - Every one gets 400/404 JSON, and none leaks the secret marker or API data.
    - `/admin/ui/../api/stats` is 400, never the stats.
  - **Methods:** POST/PUT/DELETE on UI paths need the token.
  - **Startup:** 404 without a UI directory; startup fails for an empty or missing directory; the log line when unset;
    a normal `start()` serves the UI.
- **Mutations:** 6 new (53 in total), all caught: symlink escape, segment checks skipped, any file type served, a
  missing asset given `index.html`, everything immutable, and the exemption decided by URL prefix instead of the
  matched route.

## Consequences
- Step 4 builds `apps/dashboard` with `base: '/admin/ui/'` and must keep all scripts and styles in files (no inline
  ones), as required by the CSP above.
- Step 6 copies the dashboard `dist` into the gateway image and sets `PULSEGATE_ADMIN_UI_DIR`.

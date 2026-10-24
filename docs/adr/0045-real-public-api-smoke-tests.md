# ADR-0045: Real public API smoke tests (real-data testing, step 2)

- **Status:** Accepted
- **Date:** 2026-10-24
- **Source:** `docs/plans/real-data-testing.md` §1 (approved), user direction "test on real data"

## Decision
- **Opt-in suite** `tests/real/public-apis.real.ts`, run by `pnpm test:real` (`vitest.real.config.ts`).
  - The `.real.ts` suffix is never matched by the default test globs, so `pnpm test` and PR CI never touch the internet
    (checked: `vitest list` shows 40 files, none from `tests/real`).
  - CI runs it only on demand: `.github/workflows/real-apis.yml`, with a `workflow_dispatch` provider choice and the
    JSON report uploaded as an artifact.
- **Gateway in process** (`createGateway`, ephemeral ports), with the pinned `config/routes.real.yaml`, an API key
  generated per run, and a random admin token per run.
- **Providers:** Postman Echo (`https://postman-echo.com`) and httpbin (`https://httpbin.org`). JSONPlaceholder is
  excluded: its TLS connection was reset on every attempt from the development network (2026-10-24).
- **Etiquette, enforced in code:**
  - at most **30 provider requests per run** (gateway-forwarded + direct); the run fails before exceeding the budget;
  - sequential, at least 250 ms apart, with a descriptive `User-Agent` naming the project;
  - `maxAttempts: 1` (no retries towards a third party), and no load, ever.
- **Unavailable providers** are reported as **skipped with the reason** ("preflight answered 503", "preflight failed: …",
  "excluded by REAL_API_ONLY"), never as passed and never as a gateway failure. `REAL_API_ONLY=echo|httpbin` limits a
  run to one provider; an empty value means both (the workflow's default input).
- **Gateway errors vs provider errors:** a response counts as gateway-generated only if it has the normalized body
  (`error.code` + `error.requestId`). Assertions on provider responses are labelled "upstream status".

## Checks (R1–R9) and what they proved
| # | Check | Result (2026-10-24) |
|---|---|---|
| R1 | `/real/echo/get?a=1&b=two`: prefix stripped, query untouched | passed: `args` = `{a: "1", b: "two"}`, echoed URL `https://postman-echo.com/get?a=1&b=two` |
| R2 | End-to-end headers on Postman Echo: `User-Agent` and a custom header kept, `X-API-Key` absent | passed |
| R2b | `X-API-Key` never forwarded, checked **with a control**: sent directly, httpbin echoes `X-Api-Key`; through the gateway it is absent | passed |
| R3 | POST JSON body (non-ASCII included) forwarded byte for byte; `X-Cache: BYPASS`; 1 attempt | passed |
| R4 | httpbin `/base64/…` and `/json`: SHA-256 through the gateway = direct; `Content-Type` equal | passed |
| R5 | Missing or wrong key → 401 `AUTHENTICATION_FAILED`, 0 upstream attempts | passed |
| R6 | Capacity 3 → `[200, 200, 200, 429]`; the 429 is normalized, with `Retry-After`, `X-RateLimit-Limit: 3` and `Remaining: 0` | passed |
| R7 | httpbin `/cache/60` (`Cache-Control: public, max-age=60`): MISS, then HIT with `Age`, identical body | passed |
| R8 | Postman Echo sets cookies → never stored on a cache-enabled route: MISS twice, `notStorable` counted | passed |
| R9 | Per route, the admin API = the test's own tally: requests, status classes, codes, attempts (successes, 0 failures), cache hit/miss/bypass, `notStorable` | passed |

- **Runs:**
  - 10/10 passed twice, with 16 of 30 provider requests each time.
  - With `REAL_API_ONLY=httpbin`: 4 passed, 6 skipped with the reason "excluded by REAL_API_ONLY", 8 requests.

## Found while running
- **The first run failed R2 as originally written** (an `X-Request-ID` check). A direct probe showed that **both**
  providers' edges drop `X-Request-ID` and `X-Forwarded-For`, even on requests that don't go through PulseGate. Those
  headers therefore can't be verified through these providers. Their forwarding stays covered by
  `apps/gateway/test/proxy.test.ts` against a local upstream. R2 was rewritten to check what is observable, and R2b adds
  the control-backed `X-API-Key` check.
- A second bug was caught before it shipped: the workflow's empty provider input would have excluded both providers. An
  empty value now means both, verified by a run with `REAL_API_ONLY=` (10/10 passed).

## Consequences
- The real-network suite isn't in the mutation suite (it isn't routine CI). Its logic is exercised by the runs recorded
  above.
- Provider behaviour can change (headers, availability, rate limits). A failure on a provider response is labelled
  "upstream status" in the assertion message, so it can't be mistaken for a gateway regression.
- Next: step 3 of the plan, the k6 suite against the mocks.

# ADR-0044: Deterministic fault scenarios in Docker (real-data testing, step 1)

- **Status:** Accepted
- **Date:** 2026-10-24
- **Source:** `docs/plans/real-data-testing.md` §2 (approved with review tightening)

## Context
The in-process socket tests already cover every fault path (`reliability.test.ts`). What was missing was the same faults
in the Docker stack, through the real mock image, observed through the admin API, the dashboard and `/metrics`, in
particular breaker **recovery**.

The mock's `_failRate` is random, so it can't support exact assertions such as "retry, then success".

## Decision
- **Mock fault `_failTimes=<n>&_key=<k>`:** the first `n` requests carrying key `k` get 503, then normal answers.
  - Counters are per key and bounded: least recently used beyond `MAX_FAIL_KEYS` = 1,000.
  - It combines with `_status` for the eventual answer.
  - Tests use a fresh key per run, so there is no reset endpoint (the plan's `POST /_reset-keys` was dropped as
    unnecessary).
- **New e2e routes, each with its own upstream entry** so that each has its own breaker:
  - `e2e-slow`: `timeoutMs: 500` against `_delay=1500`;
  - `e2e-retry`: `maxAttempts: 3`, short backoff;
  - `e2e-recover`: `failureThreshold: 2`, `openDurationMs: 3000`.
- **Scenarios, asserted in the Playwright setup and test:**
  - **F1:** 3 × 504 `UPSTREAM_TIMEOUT`; the route's p50 is in [500, 1,000) ms; slow-service failure rate 100 %.
  - **F2:** 200 after 2 failures.
  - **F3:** the real 503 passes through after 3 attempts. Together with F2: attempts 1 success / 5 failures,
    retries 4, `retryRate` 2, "2.00 / req" in the UI, failure rate 83 %.
  - **F4:** 2 × 502, then 503 `CIRCUIT_OPEN` with `Retry-After`; the admin API shows `open`.
  - **F6:** `e2e-ok` still answers 200 while recover-service is open.
  - **F5:** polled with healthy requests (every request counted, no fixed sleep) until 200. Then:
    - the admin API shows `closed` with 0 consecutive failures;
    - the UI badge shows Closed;
    - failure rate 67 % (2 failures, 1 probe);
    - `scripts/e2e.sh` confirms closed → open → half-open → closed in `/metrics` on the operations listener.
- **Exact totals despite polling:** the spec counts every request it sends, and the Overview KPI and the admin API total
  must equal that count.

## Verified (2026-10-24)
- `pnpm test:e2e` ran twice in a row on a fresh stack: 4/4 Playwright tests passed (about 13.5 s), the cross-container
  401/200 check passed, the transitions were found in `/metrics`, and no containers were left afterwards.
- `REQUIRE_REDIS_TESTS=1 pnpm check`: 524 tests pass, including 2 new mock tests and the updated e2e config loader test.
- Mutations: 69/69 caught. The new one, an off-by-one in `_failTimes`, is caught by the mock's unit tests.
- **Not covered by the mutation suite:** the Playwright assertions themselves. Running e2e per mutation would be far too
  slow for routine CI.

## Consequences
- Normal CI's `e2e` job now covers F1–F6 and stays under 2 minutes. The only real wait is the 3 s open period of F5.
- Next step of the plan: the real public API smoke tests (R1–R9, opt-in).

# Plan: testing on real data (Phase 6, part A)

_Status: **approved with review tightening** (2026-10-24; §3a added). User direction: real public APIs for correctness, then realistic k6 load
against controlled mocks. No license or release work yet; that is part B in `phase6.md`, deferred._

## 0. What already exists (reused, not rebuilt)
| Area | Existing | Gap this plan fills |
|---|---|---|
| Fault behaviour (in process) | `apps/gateway/test/reliability.test.ts` (22 socket tests with fake-able clocks): retries, per-attempt timeout, deadline, breaker open / isolate / half-open recovery / re-open, 4xx not counted, oversized responses, client aborts, no socket leaks. Also `proxy`, `cache`, `auth-ratelimit`, `phase2-hardening`, `redis`, `lifecycle` and `metrics` tests | Nothing to duplicate in process. **The gap is the same faults in Docker**, against the real mock image, seen through the admin API and the dashboard |
| Mock upstream | `examples/mock-upstreams`: `_delay`, `_status`, `_failRate` (random), `_reset`, `_bytes` | No **deterministic** "fail N times, then succeed", which retry-then-success and breaker recovery need. `_failRate` is random, so it is unusable for exact assertions |
| Docker stacks | `docker-compose.yml` + `distributed` / `dashboard` / `e2e` overrides; `scripts/e2e.sh` (fresh stack, cross-container admin check, always torn down); `scripts/smoke-distributed.sh` | Reuse all of it. New: a `bench` override with fixed resource limits |
| Dashboard verification | Playwright (`tests/e2e`): exact traffic → KPIs, 40 % rejections, 80 % hits, breaker open, no CSP violations; admin API socket tests | Not yet covered: timeouts, retries, latency buckets, breaker **recovery**, and reconciliation at load |
| Benchmarks | `scripts/bench-stats-window.ts` (memory only); `benchmarks/reports/raw/` ignored in git | **No k6 at all.** The suite below is new, and it is Phase 6's benchmark deliverable (one suite, not two) |
| Public APIs | Nothing | New, opt-in suite |
| CI | `check` (format, lint, typecheck, tests with Redis, build, budget, stats bench, mutations), `docker` (distributed smoke), `e2e` | New opt-in workflows; routine CI only gains deterministic tests |

**Public API probe (2026-10-24, from this machine, 5 requests in total):**
- **Postman Echo:** 200, sets `Set-Cookie` (`sails.sid`, Cloudflare cookies), no `Cache-Control`. Our rules must therefore
  **never** store its responses (ADR-0036), which is a good negative test.
- **httpbin.org:** `/get` 200 with no caching headers. `/cache/60` returns `Cache-Control: public, max-age=60`, an
  upstream-permitted cache test.
- **JSONPlaceholder:** TLS connection reset on 3 tries from this network. It is **excluded** from the suite (documented);
  it can be added later if it is reachable where the suite runs.

## 1. Real public API smoke tests (opt-in, low volume)
- **Where:** `tests/real/*.real.ts`, run by `pnpm test:real` with `vitest.real.config.ts`. They never match the default
  test globs, so `pnpm test` and PR CI never touch the internet.
- **Setup:**
  - The gateway runs **in process** (`createGateway`, ephemeral ports, like the socket tests), with a pinned
    `config/routes.real.yaml` and an API key generated per run.
  - The admin API is used for the counter checks.
  - **Upstreams:** `https://postman-echo.com` and `https://httpbin.org`.
- **Etiquette and budget:**
  - **≤ 30 upstream requests per run in total**, sequential, at least 250 ms apart, with a descriptive `User-Agent`.
  - No retries towards public APIs (`maxAttempts: 1`) and no load.
  - A preflight sends **one** direct request per provider. If a provider is down, its tests are reported as
    **skipped: provider unavailable**, never as passed, and never as a gateway failure.
  - Gateway-generated errors (normalized JSON with `error.code`) are told apart from upstream errors in every assertion
    message.
- **Checks, with their acceptance criteria:**

| # | Check | Passes when |
|---|---|---|
| R1 | Routing, path rewrite, query | `GET /real/echo/get?a=1&b=two` → 200. The echoed `args` equal `{a: "1", b: "two"}` exactly, and the echoed URL is `https://postman-echo.com/get?a=1&b=two` (prefix stripped, query untouched) |
| R2 / R2b | Header forwarding | **Revised after the first run (ADR-0045):** both providers' edges drop `X-Request-ID` and `X-Forwarded-For` even on direct requests, so R2 checks `User-Agent` and a custom header pass and `x-api-key` is absent; R2b proves the absence against a control request on which httpbin does echo the key |
| R3 | Body forwarding (POST) | `POST /real/echo/post` with a JSON body → the echoed `json` is deep-equal to what was sent; exactly **1** upstream attempt (POST is never retried) |
| R4 | Response integrity | `GET /real/httpbin/base64/<fixed>` and `/json`: SHA-256 of the body via the gateway = a direct request; `Content-Type` preserved |
| R5 | Authentication | No key → 401 `AUTHENTICATION_FAILED`; a wrong key → 401. The admin API shows **0 upstream attempts** for both |
| R6 | Rate limiting | A route with capacity 3 (refill 0.001/s) → `[200, 200, 200, 429]`. The 429 has `Retry-After` and `X-RateLimit-Remaining: 0`, and makes 0 upstream attempts |
| R7 | Cache allowed by upstream | `/real/httpbin/cache/60` → `X-Cache: MISS`, then `HIT` with `Age` ≥ 0; one upstream attempt for both |
| R8 | Cache refused by upstream | Postman Echo (sets cookies) on a cache-enabled route → `MISS` twice; the admin API shows `store.notStorable = 2`, `hit = 0` |
| R9 | Admin API = what we sent | After the run, per route: requests, status classes, `AUTHENTICATION_FAILED` and `RATE_LIMIT_EXCEEDED` counts, cache hit/miss/notStorable and upstream attempts all equal the test's own tally |

## 2. Deterministic fault tests in Docker (routine CI)
- **Mock extension (tested):** `_failTimes=<n>&_key=<k>` answers 503 for the first `n` requests carrying key `k`, then
  200. Per-key counters are bounded (LRU of 1,000 keys). Tests use a fresh key per run, so no reset endpoint is needed
  (ADR-0044).
- **New routes in `config/routes.e2e.yaml`,** each with its own upstream entry where the breaker matters:
  - `e2e-slow`: `timeoutMs: 500` against `_delay=1500` → 504.
  - `e2e-retry`: `maxAttempts: 3`, `_failTimes=2` → 200 after 3 attempts.
  - `e2e-recover`: `failureThreshold: 2`, `openDurationMs: 3000`.
- **The scenarios run in Playwright's setup and are asserted through the admin API and the UI:**

| # | Scenario | Passes when |
|---|---|---|
| F1 | Timeout | 3 × `e2e-slow` → 3 × 504 `UPSTREAM_TIMEOUT`. The route's window p50 lies in [500, 1,000) ms. Upstreams screen: failure rate 100 % |
| F2 | Retry, then success | One request → 200, with 3 upstream attempts (2 failures + 1 success) and `retries = 2` in the admin API. The Routes detail shows "2.00 / req" |
| F3 | Retries exhausted | `_failTimes=5` → the final 503 passes through after 3 attempts |
| F4 | Breaker opens | 2 failing requests → the 3rd is `CIRCUIT_OPEN` (503) with `Retry-After`; badge Open |
| F5 | Breaker recovers | After `openDurationMs` (polled with `expect.poll` on healthy requests, never a fixed sleep), a probe succeeds → badge **Closed**, consecutive failures 0; the half-open → closed transition is in `/metrics` |
| F6 | Isolation | While `e2e-recover` is open, `e2e-ok` keeps answering 200 |

- **Budget:** F5 waits about 3 s in real time, the only wait in the suite. The e2e job stays under 2 minutes.

## 3. k6 performance suite (opt-in; mocks only, never third-party APIs)
- **Stack:** `docker-compose.bench.yml` on top of the base stack, with fixed limits: gateway 2 CPUs / 512 MiB, mocks
  1 CPU / 256 MiB each, Redis 1 CPU.
  - k6 (pinned image tag) runs **as a container on the Compose network**, so Docker Desktop's port forwarding isn't
    measured.
  - A pinned `config/routes.bench.yaml`.
- **Load model:** open model (`constant-arrival-rate` / `ramping-arrival-rate`), so latency isn't hidden by coordinated
  omission. 15 s warm-up excluded from the results; 60 s measured per step.
- **Scenarios** (each reports rps, p50/p90/p95/p99/max latency, error rate by status, and CPU and memory per container):

| ID | Scenario | Shape | Correctness gate (performance numbers are reported, **not** gated) |
|---|---|---|---|
| K0 | Baseline: k6 → mock directly | steady, 3 rates | none |
| K1 | Steady traffic through the gateway | the same 3 rates and windows as K0 (§3a) | all 200; overhead = K1 − K0 per percentile, only where both reached the offered rate |
| K2 | Burst | 50 → 10× → 50 rps spike | no gateway 5xx; the limiter keeps rejecting at the configured rate |
| K3 | Mixed routes | weighted: 60 % read (cached), 20 % auth read, 10 % write, 10 % public | status mix within ±2 pts of expected; 0 unexpected codes |
| K4 | Cache hits | one warm key | see §3a: k6 HIT/MISS = `/metrics` deltas = mock request counter; 0 bypass |
| K5 | Rate-limit rejections | 10 subjects × 20 rps for 30 s, C = 10, ρ = 2/s | accepted per subject within the derived interval of §3a |
| K6 | Slow upstream | `_delay` p50 300 ms, timeout 1 s | no 504 below the timeout; latency ≈ upstream + overhead |
| K7 | Failing upstream | `_failRate=0.2`, retries 2, breaker on | breaker transitions present in `/metrics`; the gateway stays up; error rate reported |
| K8 | Redis limiter, 1 vs 2 instances | steady | the shared budget holds (reuses the distributed stack) |

- **Thresholds are informational (review):** k6 thresholds gate only correctness (checks on status codes, cache
  headers and counts). Latency and throughput limits are recorded as "observed vs provisional" in the report and **never
  fail a run** until there is repeatable baseline data from several runs on the same machine.
- **Saturation (reported only):** `ramping-arrival-rate` until p99 > 100 ms or errors > 1 %. We report where that
  happened; we don't claim it as a capacity.
- **Reconciliation (also verifies the dashboard at load):** for each scenario, k6's request count and status counts =
  the delta of `pulsegate_requests_total` in `/metrics`. For runs under 5 minutes, also = the admin API window counters.

## 3a. Review tightening (2026-10-24)
**K0 vs K1: equivalent baselines.**
- Both request the same mock path with `_bytes=1024&_contentLength=1`, so the **response body is identical (1 KiB)**
  whatever headers the gateway adds. The echo body would grow with the forwarded headers, so it is not used.
- Same k6 options: the same `constant-arrival-rate` steps, `preAllocatedVUs` / `maxVUs`, 15 s warm-up (tagged and
  excluded from the summaries) and 60 s measured window. Keep-alive is on for both (k6 reuses connections per VU).
- The runs are sequential on the same stack and limits, with K0 run immediately before K1 at each rate.
- **Unavoidable differences, documented in the report:**
  - the gateway adds a second hop with its own undici keep-alive pool to the mock;
  - responses carry about 150 extra header bytes (`X-Request-ID`, `X-RateLimit-*`);
  - K1's route still runs the mandatory limiter check, with an effectively unlimited bucket. "No optional policies"
    means no auth, cache or retries.
- Overhead is reported as K1 − K0 per percentile at equal offered rate, **only for steps where both achieved the offered
  rate** (k6 `dropped_iterations` = 0). Otherwise the step is reported as saturated, with no overhead figure.

**K4: cache warm-up, key stability and reconciliation.**
- The cache key is route + method + raw path + raw query + partition + vary headers (ADR-0036). K4 therefore uses a
  `scope: shared` route with no vary headers, one fixed path and query, and requests that never send `Cache-Control`,
  `Pragma` or `Authorization` (which would bypass the cache).
- The TTL (600 s) is longer than the whole run, and the entry is far below `maxEntries` / `maxBytes`, so no expiry or
  eviction can happen inside the measured window.
- **Warm-up:** one request, then poll until `X-Cache: HIT` is seen. Then the measured window starts.
- **Measured, from three independent counters over the window:**
  1. k6's per-response `X-Cache` tally (HIT / MISS / BYPASS);
  2. the delta of `pulsegate_cache_requests_total{result=…}` in `/metrics`;
  3. the **mock's own request counter** (new `GET /_stats` on the mock, read before and after).
- **Correctness gates:**
  - k6 HITs = the `/metrics` hit delta;
  - k6 MISSes = the `/metrics` miss delta = the requests the mock received for that path (expected 0 after warm-up);
  - 0 BYPASS.
- The hit ratio is reported as measured: hits ÷ (hits + misses). It is never assumed.

**K5: the expected number of accepted requests, derived from the limiter.**
- **The limiter's semantics** (`packages/rate-limiter/src/token-bucket.ts`):
  - a new bucket starts **full**, with C tokens, at the subject's first decision t₀;
  - it refills continuously at ρ tokens/s, with fractional tokens, capped at C;
  - a request is accepted when tokens ≥ 1, and consumes 1.
  - Redis mode is the same, using the Redis server's clock.
- **Derivation:** with one subject offered a constant rate r > ρ from t₀ to its last decision tₙ, the bucket can never
  sit at the cap after the first request (consumption outpaces refill). So the number of accepted requests is
  **A = C + ⌊ρ·(tₙ − t₀)⌋**.
- **Timing tolerance:**
  - The gateway's span (tₙ − t₀) isn't observable from k6. It lies within k6's send span S, widened by the first
    request's duration L₀ and the last request's duration Lₙ, both measured by k6.
  - The pass interval is therefore
    **[C + ⌊ρ·(S − L₀)⌋, C + ⌊ρ·(S + Lₙ)⌋]**, computed per subject from the actual timings.
  - With ρ = 2/s and request durations of a few ms, the interval is usually one value, and at most two. No hard-coded
    ±1.
- **Shape:** 10 subjects (distinct API keys, so 10 buckets) at r = 20/s each for 30 s, with C = 10 and ρ = 2/s.
- **Cross-check:** the last accepted response's `X-RateLimit-Remaining` must be consistent with A. Total accepted and
  rejected must equal the `/metrics` `pulsegate_rate_limit_decisions_total` deltas.

**Public APIs:** correctness only, at most 30 requests per run (§1). They are never used by any k6 scenario; k6 targets
only the mocks on the Compose network.

## 4. Dashboard verification (summary of where each item is checked)
- **MISS → HIT:** R7 (real), the existing e2e (80 %), K4 (at load).
- **Rate-limit rejections:** R6, the existing e2e (40 %), K5.
- **Latency buckets:** F1 (p50 in the expected range), K6 (bucket p50 vs the injected delay).
- **Upstream failures:** F1/F3/F4, K7.
- **Breaker state and recovery:** F4/F5 in the UI, K7 in `/metrics`.
- **Totals at load:** reconciliation in §3.

## 5. Reproducibility
- **Pinned:** configs (`routes.real.yaml`, `routes.e2e.yaml`, `routes.bench.yaml`, with hashes in each report), the k6
  image tag, the gateway image digest, and the Node and Docker versions.
- **Each benchmark report** (`benchmarks/reports/<date>-<host>.md`, generated by `scripts/bench-report.ts` only from
  raw files) records:
  - hardware (CPU model and cores, RAM), OS, Docker Desktop CPUs and memory, and the container limits;
  - per scenario, its duration, request mix and arrival rates;
  - the checksums of the raw files.
- **Raw results:** k6 `--out json` (gzipped) plus summary JSON, `docker stats` samples, and `/metrics` snapshots.
  - Locally: `benchmarks/reports/raw/<run-id>/`, ignored by git.
  - In CI: uploaded as artifacts.
  - The per-run summary JSON is committed with its report.
- **Honesty rules:** the generator refuses to write a report with a missing value. No number appears in the README or
  docs unless it is copied from a committed report. No pass/fail claim is made about performance, only about the
  correctness gates.

## 6. CI split
| Workflow | When | Contents |
|---|---|---|
| `ci.yml` (existing) | every push / PR | everything as today, plus the F1–F6 e2e scenarios, the mock's unit tests, and `k6 inspect` of every script (syntax and options only, no load) |
| `real-apis.yml` (new) | `workflow_dispatch` only | `pnpm test:real` (≤ 30 public requests); report as an artifact |
| `bench.yml` (new) | `workflow_dispatch` only | the k6 suite at reduced duration; raw results as artifacts. Shared-runner numbers are labelled **CI, not comparable** and never committed |

## 7. Order of work (each is a commit point; you commit)
1. **Done (ADR-0044).** Mock `_failTimes` + unit tests; e2e routes F1–F6 + Playwright and admin API assertions (routine CI).
2. **Done (ADR-0045; 10/10 passed against Postman Echo and httpbin, 16 requests per run).** Real API suite R1–R9, `routes.real.yaml`, `pnpm test:real`, `real-apis.yml`. Run it once here and report the result.
3. k6 suite K0–K8: bench override, scripts, `scripts/bench.sh`, stats sampler, report generator (with tests),
   `bench.yml`, and `k6 inspect` in CI.
4. Run the full suite on this Mac (Apple M5, 10 cores, 16 GB; Docker Desktop with 10 CPUs and 7.7 GiB) and commit the
   generated report. Then an ADR covering results and findings (including the deferred request-deduplication question,
   Q13, if K4/K7 show stampedes).

## 8. Not in this part
License, image publishing, release docs, hosted demo (part B, deferred). Performance tuning, unless the measurements
show a defect.

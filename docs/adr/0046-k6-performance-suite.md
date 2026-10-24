# ADR-0046: k6 performance suite against the mock upstreams (real-data testing, step 3)

- **Status:** Accepted
- **Date:** 2026-10-24
- **Source:** `docs/plans/real-data-testing.md` §3 and §3a (the review tightening), §5 and §6

## Decision
- **Tooling:**
  - k6 **2.3.0** pinned by digest (`grafana/k6:2.3.0@sha256:9c2dee7f…`).
  - k6 runs **as a container on the Compose network** (`docker compose run k6`), so Docker Desktop's host port forwarding
    is not part of any measurement.
  - **Mocks only:** no third-party API is ever a k6 target.
- **Stacks and limits (`docker-compose.bench.yml`, `docker-compose.bench-redis.yml`):**
  - gateway 2 CPUs / 512 MiB, each mock 1 CPU / 256 MiB, Redis 1 CPU / 256 MiB, k6 2 CPUs / 1 GiB;
  - `LOG_LEVEL=warn` (per-request info logs would dominate);
  - the admin listener is on, so the stats window's recording cost is included;
  - pinned configs `config/routes.bench.yaml` and `config/routes.bench-redis.yaml`, with loader tests;
  - per-run API keys from `scripts/bench-keys.ts`: raw keys only in the git-ignored run directory, digests in the
    generated clients file.
- **Scenarios (`benchmarks/k6/`):**
  - K0/K1: same path and fixed 1 KiB body (`_bytes=1024&_contentLength=1`), same rates, VUs and windows, run back to back.
  - K2 burst (50 → 500 → 50 rps against capacity 100, refill 50/s).
  - K3 mixed routes (60/20/10/10 %).
  - K4 one warm cache key.
  - K5: 10 subjects × 20 rps against C = 10, ρ = 2/s.
  - K6 slow upstream (300 ms) under a 1 s timeout.
  - K7: 20 % upstream failures with retries and a breaker.
  - K8 Redis: a shared subject alternating between 2 instances (C = 20, ρ = 4/s), and throughput through 1 vs 2 instances.
  - K9 saturation ramp (full profile only, informational).
  - **Load model:** open (arrival-rate executors). A 15 s warm-up (5 s quick), tagged and excluded from latency
    statistics, then 60 s measured (10 s quick). K5 and K8-shared have no warm-up: it would spend tokens.
- **Runner (`pnpm bench` = `scripts/bench.sh`, opt-in):**
  - Generates the keys and metadata (`scripts/bench-meta.ts`: hardware, OS, Docker and its CPUs/memory, limits,
    versions, git commit and dirty count, SHA-256 of every workload file).
  - Brings up a fresh stack.
  - Per scenario: snapshots of `/metrics`, the admin API and the mocks' new `GET /_stats` request counters before and
    after; `docker stats` sampled about once a second; k6 run with `--out json` (gzipped raw).
  - K4: the key is warmed until `X-Cache: HIT` before the snapshots.
  - K7: `/health` is checked afterwards.
  - Then the Redis stack for K8, and always `down -v`.
  - `BENCH_ONLY=K4,K5` runs a subset.
- **Report (`scripts/bench-report.ts`):**
  - Built only from the raw files. It **refuses** to write if a raw file or a measured statistic is missing; it never
    renders a blank or "n/a" number.
  - **Correctness gates** decide the exit code:
    - k6's own checks;
    - per-route request and status-class counts = `/metrics` deltas;
    - K0/K1 mock counts;
    - K2/K5/K8 allowed/rejected = limiter decision deltas (summed across both instances for K8);
    - K3 route shares within ±2 points;
    - K4: k6 HIT = `/metrics` hit delta = admin API hit delta, and k6 MISS = `/metrics` miss delta = requests the mock
      received for the key, with 0 bypasses;
    - K5/K8: per subject, accepted within the **derived interval** [C + ⌊ρ(S − L₀)⌋, C + ⌊ρ(S + Lₙ)⌋];
    - K7: only 200/503, and healthy afterwards.
  - **Latency and throughput are informational** (k6 thresholds use `>= 0`), until there is repeatable baseline data.
  - **Gateway overhead** (K1 − K0) is reported only where neither run dropped iterations.
  - Quick and CI reports carry explicit warnings and are **never written to `benchmarks/reports/`**. Only a full local
    run publishes `benchmarks/reports/<run-id>.md` + `.json`. Raw files (with SHA-256 checksums in the report) stay in
    `benchmarks/reports/raw/<run-id>/` (git-ignored) or CI artifacts.
- **CI:**
  - The routine `docker` job runs `scripts/k6-inspect.sh` (syntax and options of every script, both profiles, no load).
  - The full load runs only through `.github/workflows/bench.yml` (`workflow_dispatch`, profile and subset inputs, raw
    results as artifacts).
- **Mock addition:** `GET /_stats` counts received requests in total and per path, excluding itself and `/healthz`,
  bounded at 1,000 paths. It is the independent upstream-side counter for reconciliation.

## Verified (2026-10-24)
- **Two full quick-profile runs** of all 13 scenarios on this machine: **84/84 correctness gates passed** in both, and
  the stacks were removed afterwards.
  - K4: 1,501 HITs agree across k6, `/metrics` and the admin API; 0 misses; 0 requests reached the mock for the key.
  - K5: every subject's accepted count was inside its derived interval (e.g. 29 in [29, 30]).
  - K8-shared: 59 accepted against an interval of [59, 59], across two instances sharing Redis.
- `scripts/k6-inspect.sh`: 18/18 (9 scripts × 2 profiles).
- **Report generator:** 16 unit tests (parsing, deltas, the derived interval on and off a token boundary, K4 gates
  passing and failing, refusals). `pnpm check`: 543 passed. Mutations: 72/72, including 3 new ones (no timing
  tolerance, bypass ignored, missing value rendered).
- **No performance numbers are published by this step.** Quick-profile tail latencies are not stable (a 10 s window at
  50 rps has 500 samples, so p99 is the 5th-slowest response); the report says so.

## Found while building
- The achieved rate for scenarios without a fixed window was first computed from whole one-second buckets, which
  undercounted (182.5 rps for 200 offered). It now uses the measured span from the first request's start to the last
  response (200.8 rps).
- Docker Desktop's registry proxy intermittently dropped connections (EOF) while pulling images. Retries succeeded;
  it was unrelated to the suite.

## Consequences
- Step 4: one full-profile run on this Mac, with the generated report and summary committed, plus findings (including
  request deduplication, Q13, if K4/K7 show a reason).
- Performance thresholds become gates only after several full runs establish a repeatable baseline (review point 6).

## Amendment (2026-10-24): run k6 as the calling user
- CI's `k6-inspect.sh` step failed on Linux (`stat /out/keys.json: permission denied`), because the k6 image's own user
  can't read a 0700 `mktemp` directory or the 0600 `keys.json`. The same problem would also have blocked `bench.sh`
  from writing results. Docker Desktop on macOS hides file permissions, so local runs passed.
- Both scripts now run k6 with `--user "$(id -u):$(id -g)"`. The failure and the fix were reproduced with a Docker
  volume that has real Linux permissions (as the image user: permission denied; as the owner: reads and writes).

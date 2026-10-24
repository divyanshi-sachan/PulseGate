# Plan: Phase 6, release and benchmarks

_Status: **draft** (2026-10-24). **Re-sequenced by the user:** part A, testing on real data, comes first and has its own
plan, `docs/plans/real-data-testing.md`, which also absorbs §2 (k6 benchmarks) below. Part B (license, publishing,
release docs, demo, D1–D3) is deferred._

**Exit criterion (tech_impl §14 Phase 6):** a new developer can clone, configure, run, test and benchmark the project
using documented instructions.

**Definition of Done for v1.0 (tech_impl §15).** Already met:
- MVP features, unit, integration and e2e tests;
- local and Redis rate limiting, verified across 2 instances;
- no credentials in metrics or logs;
- Docker setup with no paid APIs;
- CI on every pull request.

Still open, and covered by this plan: **reproducible benchmarks**, **documented trade-offs for reviewers**, plus the
release deliverables (license, API docs, demo, walkthrough).

## 1. Decisions needed (asked separately)
| # | Topic | Proposed default | Why it matters |
|---|---|---|---|
| D1 | License | MIT | `package.json` says `UNLICENSED`; a public repo without a license isn't open source |
| D2 | Live demo | A local one-command demo plus a written and recorded walkthrough; no hosted instance | Hosting needs an account, costs, and a public admin surface |
| D3 | Image publishing | GHCR on `v*` tags, multi-arch (amd64 + arm64), from CI | Lets `docker run` work without a build; outward-facing, so your call |
| D4 | Benchmark machine | This Mac (Apple M5, 10 cores, 16 GB; Docker Desktop with 10 CPUs and 7.7 GiB) with fixed container CPU/memory limits, labelled "local, not a production claim" | Numbers are only comparable on the hardware they were measured on |

## 2. Benchmarks: a reproducible k6 suite (PRD §10, tech_impl §13)
- **Tooling:**
  - k6, pinned by image tag, running **as a container on the Compose network**, so Docker Desktop's host port forwarding
    isn't part of what we measure.
  - `docker-compose.bench.yml` gives fixed limits: gateway 2 CPUs / 512 MiB, each mock 1 CPU, k6 2 CPUs, Redis 1 CPU.
  - The same limits on every run make runs comparable on the same machine.
- **Load model:**
  - **Open model** (`constant-arrival-rate`) at fixed rates, so latency isn't hidden by coordinated omission.
  - 15 s warm-up, then 60 s measured, per step.
  - A `ramping-arrival-rate` run finds saturation: the highest rate where p99 stays under 50 ms and errors under 0.1 %
    (proposed; thresholds recorded in the report).
- **Scenarios:**

| ID | What | Compared with | Also checks correctness |
|---|---|---|---|
| B0 | k6 → mock directly | — (baseline) | — |
| B1 | Gateway, no optional policies (huge bucket, no auth/cache/retries) | B0: the gateway's overhead at equal rate | every response 200 |
| B2 | + API-key auth + local rate limiting | B1 | 429 count = rate − refill, exactly, under a fixed arrival rate |
| B3 | Redis rate limiting, 1 instance, then 2 instances | B2 | the shared budget holds across instances |
| B4 | Cache hit vs miss (warm key vs unique keys) | B1 | hit ratio from `/metrics` ≥ 99 % / = 0 % |
| B5 | Upstream latency spike and failures (`_delay`, `_failRate`) | B1 | latency bounded by the timeout; the breaker opens; no crash |
| B6 | Cold-cache stampede: N concurrent misses on one key, slow upstream | — | number of upstream calls (evidence for **Q13**, request deduplication, deferred in ADR-0035) |

- **Recorded per scenario:**
  - rps, p50/p95/p99/max latency and error rate (k6 summary JSON);
  - CPU and memory per container (`docker stats`, sampled every second);
  - the gateway's `/metrics` before and after, reconciled against k6's counts.
- **Reports:**
  - `scripts/bench.sh` runs everything. `scripts/bench-report.ts` writes `benchmarks/reports/<date>-<host>.md` **only
    from the raw measurements**, and refuses to write if a value is missing.
  - The report records hardware, OS, Docker, Node and k6 versions, the image digest, config hashes, the parameters,
    durations and the raw-file checksums.
  - Raw JSON stays out of git (`benchmarks/reports/raw/` is already ignored). The summary JSON next to the report is
    committed.
  - The README only links to the report, or quotes numbers copied from it.
- **CI:** a `bench-smoke` job runs every scenario for 10 s at a low rate, and checks the correctness assertions and that
  the report generator works. **No numbers from CI are published**, because shared runners are noisy.
- **After measuring:** an ADR settles Q13 (implement single-flight or not) from B6's numbers, and records anything the
  benchmarks reveal.

## 3. Release deliverables
- **License and repo hygiene:** `LICENSE` (D1) and the `license` field in every package; `SECURITY.md` (private
  reporting, scope); `CONTRIBUTING.md` (setup, `pnpm check`, ADR workflow, commit style); `CHANGELOG.md` (v1.0.0).
- **API documentation (`docs/api.md`), generated or checked so it can't drift:**
  - **Data plane:** routing, forwarding, headers (`X-Request-ID`, `X-RateLimit-*`, `Retry-After`, `X-Cache`, `Age`). The
    error table is generated from `GATEWAY_ERRORS`, and a test fails if the doc and the registry differ.
  - **Admin API:** JSON Schemas generated from the shared Zod contracts (`z.toJSONSchema`) into `docs/api/admin/`, with
    a test that the committed schemas are current. Auth, headers and examples.
  - **Operations:** `/health`, `/ready` (each body variant), `/metrics` (metric table from ADR-0036).
  - **Environment variables:** a table (`PULSEGATE_CONFIG`, `PULSEGATE_CLIENTS`, `REDIS_URL`, `ADMIN_TOKEN`,
    `PULSEGATE_ADMIN_UI_DIR`, `LOG_LEVEL`), with a test that every variable `main.ts` reads is documented.
  - **Configuration:** `config/routes.example.yaml` stays the reference (every option and default is already there).
- **Production-oriented image:**
  - OCI labels (source, version, license);
  - a `HEALTHCHECK` in the image (the Compose files already have one);
  - the base image pinned by digest;
  - a test that the gateway runs with a read-only root filesystem (`docker run --read-only --tmpfs /tmp`);
  - a documented `docker run` example;
  - CI image scanning (Trivy, pinned) that fails on fixable HIGH/CRITICAL issues;
  - GHCR publishing on tags (D3).
- **Walkthrough (`docs/walkthrough.md`):** an architecture tour, the request lifecycle through each stage, and each
  failure scenario as a command with its expected output and the ADR that explains it. Scenarios: auth, 429 with
  headers, timeout, retry, breaker open and recovery, Redis outage under both policies, cache hit/bypass, graceful
  shutdown. Plus the reviewer-facing trade-offs: what was chosen, what was rejected, and why. A recording follows D2.
- **Traceability (`docs/traceability.md`):** FR-01…FR-08 and the NFRs → code, tests and ADRs, plus the §15 checklist
  with evidence links. Built from the specs, so gaps show up before the release, not after.
- **Fresh-clone check:** follow the README literally in a fresh clone in a temporary directory (install, check, quickstart,
  dashboard, e2e, benchmark smoke) and record the result in the release ADR. CI already covers most of this on every
  push.
- **Housekeeping:** STATE's "blockers" line is stale (Q3/Q6/Q8/Q9/Q11 are all resolved); fix it.

## 4. Order of work (each step is a commit point, with tests, mutations where a guarantee is added, and docs)
1. Repo hygiene: LICENSE, SECURITY, CONTRIBUTING, CHANGELOG skeleton, STATE fix, traceability matrix (gaps listed).
2. API and environment docs with drift tests (error table, admin JSON Schemas, environment variables).
3. Image hardening, scan in CI, and GHCR publishing workflow (D3).
4. k6 suite: bench Compose override, scenarios B0–B6, runner, report generator, CI smoke.
5. Run the benchmarks on D4's machine, publish the report and a README section, Q13 ADR.
6. Walkthrough, demo per D2, fresh-clone check, CHANGELOG v1.0.0. You tag `v1.0.0`; CI publishes the image (D3).

## 5. Out of scope
Kubernetes, multi-region, SSO, billing and ML (PRD §5); a persistent control plane or route editing (tech_impl §9.3);
performance tuning beyond fixing what the benchmarks show to be broken.

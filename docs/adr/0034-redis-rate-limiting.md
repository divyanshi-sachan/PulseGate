# ADR-0034: Redis-backed distributed rate limiting (Phase 4)

- **Status:** Accepted. Reviewed by the user on 2026-10-23: all four decisions approved, with the amendments below.
- **Date:** 2026-10-23
- **Source:** Phase 4 design questions; ADR-0005 (Lua, server time, failure policy); ADR-0030 (readiness); tech_impl §5.3–5.4
- **Builds on:** ADR-0032 (RateLimiter interface, keys, headers)

## Decisions (user)
1. **Connection:** the secret **`REDIS_URL`** comes only from env (`redis://` or `rediss://` for TLS) and is required when
   `rateLimit.mode: "redis"`. Non-secret tuning goes in config: `rateLimit.redis.commandTimeoutMs` (default **50**) and
   `connectTimeoutMs` (default **2000**). The URL is never logged; logs show `host:port` only.
2. **Fail-open = local fallback:** when Redis can't answer, the request is checked against a **per-instance local token
   bucket** with the same policy, so the effective limit becomes N × capacity rather than none. Responses carry
   **`X-RateLimit-Mode: degraded`**. The gateway returns to Redis automatically.
3. **Fail-closed = 503 + not ready:** the new error code **`RATE_LIMITER_UNAVAILABLE`** (503, `Retry-After: 1`), and `/ready`
   returns 503 while Redis is unreachable. With fail-open, readiness ignores Redis.
4. **Tests:** Testcontainers starts a pinned `redis:7.4.11-alpine`. Without Docker the Redis suites are **skipped with a
   warning**; `REQUIRE_REDIS_TESTS=1` turns the skip into a failure, e.g. in CI.

## Behavior

### Lua script (atomic, ADR-0005)
In a single `EVALSHA`: read `TIME` (Redis server clock, so gateway clocks don't matter), `HMGET tokens ts`, refill
`min(C, T + r·Δt)`, consume one token if `T ≥ 1`, `HSET` (tokens stored as a string so fractions survive), `PEXPIRE`. It
returns `[allowed, tokens]`. The gateway computes `remaining`, `retryAfterMs` and `resetAfterMs` exactly as the local limiter does.
- **Key:** `pulsegate:rl:v1:{<routeId>:<subject>}`. The whole id sits in a Redis Cluster hash tag, so the bucket stays on
  one slot. The ids can't contain `}` (ADR-0032).
- **Expiry** *(Claude-chosen)*: `PEXPIRE` = time to refill to capacity + 1 s. An expired bucket is identical to a new full
  one, so expiry loses nothing, and idle keys can't pile up in Redis.

### Client and failure detection *(Claude-chosen)*
- ioredis with `commandTimeout = commandTimeoutMs`, `connectTimeout`, **`enableOfflineQueue: false`** (commands fail
  immediately while disconnected instead of queueing), `maxRetriesPerRequest: 1`, and background reconnect with
  capped exponential backoff.
- "Redis unavailable" means any command error: timeout, refused or reset connection, or not connected. The
  `ResilientRateLimiter` wrapper applies the failure policy. It logs **once per health change** (`redis rate limiter
  unavailable` / `recovered`), never per request.
- Readiness reads the client's connection status. Shutdown closes the client after the public listener drains.

## Alternatives considered
See the question options: host/port config, unlimited fail-open, 429 for fail-closed, and an external `REDIS_URL` for tests.

## Review amendments (2026-10-23, user)
1. **TTL:** keep the 1 s margin. Tests now also assert the **lower** bound: TTL ≥ time-to-full + margin. A drained bucket
   stays drained inside its refill window, so expiry or rounding can never hand out a full bucket early.
2. **Credential redaction:** `REDIS_URL` is validated by `parseRedisUrl`, which never echoes the value. Node's URL
   `TypeError` carries the full input, password included, in `input`, so it must not escape. Every Redis error string is
   scrubbed of the URL and the password (raw, URL-encoded and decoded) before logging, and only `host:port` is logged. Tests:
   malformed URL, wrong scheme, a wrong password against real Redis, and debug-level logs during an outage.
3. **Startup fails** if Redis isn't reachable within `connectTimeoutMs`, in **both** policies. The gateway doesn't start in
   local mode: `start()` throws `GatewayStartupError`, binds no ports, and `main.ts` exits 1 so the orchestrator restarts it.
   *Supersedes the "startup continues with a warning" note below.*
4. **Readiness:** an active `PING` on each probe, bounded by `commandTimeoutMs`. **Single-flight**: concurrent probes share
   one ping. `/ready` reflects Redis in its body. Fail-closed returns 503 `{status:"not_ready", redis:"unavailable"}`. Fail-open
   returns 200 `{status:"ready", redis:"unavailable", rateLimit:"degraded"}` (user choice: don't drain every instance at
   once). `/health` stays 200 whenever the process is alive.
5. **CI:** `.github/workflows/ci.yml` runs the full suite with `REQUIRE_REDIS_TESTS=1`, the curated mutation suite
   (`pnpm test:mutations`, 16 mutations across ADRs 0019–0034), the production build, and the two-instance smoke test
   (`scripts/smoke-distributed.sh`).

## Implementation notes (found while building)
- *(Superseded by review amendment 3: startup now fails instead of continuing.)* **Startup waits for Redis**, bounded by `connectTimeoutMs`. Without this, a fresh instance rejected its first requests
  in fail-closed mode while the client was still connecting; in the first test run, six of 60 requests got 503. If Redis
  isn't up in time, startup continues with a warning, and the failure policy and readiness take over.
- **Readiness actively `PING`s Redis** on each probe in fail-closed mode. Request-driven health alone could deadlock:
  a drained instance gets no traffic, so it would never notice recovery.
- Gateway-side 503s (`RATE_LIMITER_UNAVAILABLE`) aren't logged per request; only health changes are.
- **Dependencies:**
  - pnpm 11 rejects unapproved install scripts, so `allowBuilds` in `pnpm-workspace.yaml` **denies** them for
    `ssh2`/`cpu-features` (used only for SSH Docker hosts) and `protobufjs` (its script is a version-scheme warning).
  - Testcontainers lives only in dev dependencies and is absent from the runtime image.
- The skip warning is written straight to stderr: Vitest drops `console` output from files whose tests are all skipped.

## Consequences
- **Verified (2026-10-23):**
  - Real Redis via Testcontainers: script parity with the local limiter, fractional refill, exactly 100 of 1,000 concurrent
    calls allowed over 5 connections, TTL ≤ refill time + 1 s, NOSCRIPT reload.
  - Gateway against real Redis: two instances share one budget; fail-closed gives 503 + `Retry-After: 1` + not ready, a stall
    is detected within the command timeout, and the gateway recovers; fail-open falls back to degraded local buckets and stays
    ready; boot without Redis completes within `connectTimeoutMs`.
  - Skip and require switch: no Docker → skipped with a warning; with `REQUIRE_REDIS_TESTS=1` → fails.
  - Mutation checks, each caught:
    - Replacing the Lua script with a non-atomic read-modify-write in JS fails both concurrency tests.
    - Fail-open without the local fallback fails the suite.
    - Readiness ignoring Redis fails the suite.
  - Docker (`pnpm dev:distributed`): 100 concurrent requests across two instances → exactly 30 × 200 (15 each) for capacity
    30. Stopping Redis → both instances 503 and not ready; starting it → both recover. One health log line per change per
    instance. The Redis password never appears in logs.
- Exit criterion (tech_impl §14 Phase 4): two gateway instances sharing one Redis enforce **one** budget under
  concurrent traffic, tested over sockets and in Docker Compose.
- Tests:
  - Script parity with the local limiter, including fractional refill and capacity caps.
  - Atomicity: exactly `capacity` allowed out of 1,000 concurrent calls over several connections.
  - TTL bounds and the key format.
  - Both failure policies, through a controllable TCP proxy that can *cut* (connection refused) or *stall* (command
    timeout) Redis traffic, plus recovery and readiness transitions.
- Integration tests against Redis use the server clock, so they can't use fake time. They use high refill rates and short
  real waits, documented as an exception to the no-sleeps rule.

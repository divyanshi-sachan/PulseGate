# ADR-0033: Retry executor and circuit breakers (Phase 3)

- **Status:** Accepted (the four questions answered by the user; the "Claude-chosen details" below to review)
- **Date:** 2026-10-23
- **Source:** Phase 3 design questions; OPEN_QUESTIONS Q3, Q11; ADRs 0007, 0008, 0015, 0016, 0024
- **Implements:** `packages/reliability` and the upstream executor in `apps/gateway`

## Decisions (user)
1. **Q11:** new `circuitBreaker.halfOpenSuccessThreshold` (default **1**, must be ≤ `halfOpenMaxRequests`). It can be set
   globally and overridden per upstream, like ADR-0015. That many successful probes close the breaker; any failed probe re-opens it.
2. **Q3:** states are the lowercase strings **`"closed" | "open" | "half-open"`** everywhere: code, logs, and later metrics.
3. **Retry scope:** only **GET, HEAD and OPTIONS with no request body** are retried. Bodies are streamed and never
   buffered for replay. PUT/DELETE/POST are never retried, whatever `maxAttempts` says.
4. **Attempt timeout:** optional route setting **`attemptTimeoutMs`** (1 to `timeoutMs`, no default). A hung attempt is cut at that
   point and retried while the overall `timeoutMs` deadline lasts. The overall deadline always wins.

## Behavior

### Circuit breaker (State pattern, one per upstream, in memory)
- **closed:** every attempt is allowed. After `failureThreshold` consecutive failed attempts → **open** (ADR-0024).
- **open:** attempts are rejected until `openDurationMs` has passed, then the next attempt moves the breaker to
  **half-open**.
- **half-open:** at most `halfOpenMaxRequests` probes may be in flight. `halfOpenSuccessThreshold` successes → **closed**;
  any failure → **open** (a new open period starts).
- All transitions go through one method, are logged at warn (`upstreamId`, `from`, `to`), and have tests.
- An attempt holds a **permit** that settles exactly once, as success, failure or neutral. Neutral means the client
  disconnected, which doesn't count but releases a half-open slot.

### Executor (per request)
1. Check the breaker. If it is open (or half-open with no free slot) → **503 `CIRCUIT_OPEN`**. *Claude-chosen:* the 503 carries
   `Retry-After` set to the seconds until the breaker can probe again (at least 1), and the rate-limit headers, because it is
   decided after the limit check.
2. Run the attempt. Its abort signal combines the overall deadline, `attemptTimeoutMs` when set, and a client disconnect.
3. Classify the result (ADR-0024). **Failure:** connection error, attempt or overall timeout, a status in `failureStatuses`,
   `UPSTREAM_RESPONSE_TOO_LARGE`, or an unexpected `101`. **Success:** anything else, including upstream 4xx. **Neutral:** client abort.
4. Retry only if all of these hold: the request is eligible (decision 3), attempts remain, the failure is retryable (a
   connection error, an attempt timeout, or an **upstream-returned** status in `retryableStatuses`; never
   `UPSTREAM_RESPONSE_TOO_LARGE`, never the overall deadline), the backoff fits before the deadline, and the breaker
   issues a new permit.
5. **Backoff:** full jitter, `delay = random() × min(maxDelayMs, baseDelayMs × 2^(retry − 1))`, with injected randomness.
6. *Claude-chosen:* a response with a retryable status is **held, not discarded,** until the next attempt has a permit. If
   no retry happens (breaker opened, deadline, attempts used up), that real upstream response goes to the client, as ADR-0024
   requires ("the last attempt's error"). Otherwise its body is discarded.
7. *Claude-chosen:* the breaker outcome of a successful-status attempt is settled **when the response body finishes**. A clean
   end is a success. A mid-stream `UPSTREAM_RESPONSE_TOO_LARGE`, upstream error or deadline is a failure, counted once. A
   client abort is neutral.

### Observability
The request log line gains `attempts` (upstream attempts made), and `errorCode` covers `CIRCUIT_OPEN`. Breaker
transitions are logged. Metrics come in Phase 5 and hook into the same points.

## Consequences
- **Verified (2026-10-23):**
  - 20 breaker and retry unit tests and 16 socket-level fault-injection tests.
  - `pnpm check` (223 tests) passed three times in a row.
  - Mutation checks: retrying POST, ignoring the breaker between retries, counting upstream 4xx, and dropping the
    deadline pre-check each fail the suite. The last one only after adding a fail-fast latency test: without the
    pre-check the outcome is the same, but the client waits out the whole deadline.
  - Docker:
    - At a 30% upstream fail rate, 24/30 requests succeeded first time, 4 were rescued by a retry, and 2 failed both attempts.
    - Three resets opened the payments breaker (503 with `Retry-After: 10`) while orders kept serving.
    - After the open period, the probe succeeded: open → half-open → closed.
- **Found and fixed while testing:**
  - Requests rejected by Node's HTTP parser got Fastify's own 400 body. They now get the normalized shape via
    `clientErrorHandler`.
  - `CIRCUIT_OPEN` rejections were logged as "upstream request failed" warnings; they no longer are.
- **Retained-response contract (review, 2026-10-23):**
  - Once a real upstream response exists, it is never replaced by a gateway-invented error. If the breaker opens, or the
    deadline leaves no room before the retry, the client gets that retained response.
  - **503 `CIRCUIT_OPEN`** (normalized JSON, `Retry-After`) is returned **only when the breaker refuses before any upstream
    attempt**. Paired tests check both halves.
- **Retained bodies are released, not drained:**
  - Before the next attempt, a held body is destroyed rather than read to the end. A retryable error body may be large,
    and reading it only to keep one connection alive isn't worth it; undici opens new connections as needed.
  - If the client leaves during backoff, the held body is released immediately, by two independent mechanisms. The
    attempt's abort signal includes the client disconnect and undici applies it to the body, and the executor also
    discards the held body explicitly (defense in depth).
  - A streaming-503 test fails only when **both** mechanisms are removed. Socket-count tests also show that discarded
    attempts are closed and that open upstream connections stay ≤ 1 across 30 retried requests.
  - An earlier suspicion of a leak on this path was disproved by those experiments.
- The breaker counts **consecutive** failed attempts across all requests, including retries (ADR-0024). Several always-failing
  calls with retries can open it quickly; that is intended, and it's why `failureThreshold` is per upstream.
- Config: `circuitBreaker.halfOpenSuccessThreshold` and `routes[].attemptTimeoutMs`, validated (ADR-0026 table updated).
- Tests:
  - Unit tests with fake clocks and randomness for every transition, probe limits, permit settlement, backoff bounds and
    the eligibility rules.
  - Socket-level fault injection: resets, 503s, slow attempts, `_failRate` flapping, breaker isolation between upstreams,
    recovery through half-open, POST never retried, and the deadline stopping retries.

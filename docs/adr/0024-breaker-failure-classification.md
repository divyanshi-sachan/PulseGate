# ADR-0024: Circuit-breaker failure classification and counting

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** OPEN_QUESTIONS Q12; tech_impl §6 ("failure classification must be configurable"); ADR-0018 amendment
- **Builds on:** ADR-0008, ADR-0015, ADR-0016

## Context
The breaker needs a precise rule for what counts as a failure and how failures add up, and in particular
how the gateway-generated `UPSTREAM_RESPONSE_TOO_LARGE` interacts with breakers and retries.
The rule must separate "this upstream is unhealthy" from "the client or the gateway refused the request".

## Decision

### Counting model
- **Consecutive failures, counted per upstream attempt.** Every attempt, including retries, is classified. A failure
  increments the upstream's counter; any non-failure outcome resets it to 0. Reaching `failureThreshold`
  (ADR-0015) opens the breaker.
- In half-open, any failed probe re-opens the breaker; the success threshold to close is still open (Q11).
- The breaker is checked **before every attempt**, retries included. If it opened during a retry sequence,
  the remaining retries are skipped and the client gets the last attempt's error.

### Counts as a failure (one per attempt)
| Outcome | Client sees |
|---|---|
| Connection error / reset / refused | 502 `UPSTREAM_UNAVAILABLE` |
| Attempt timeout | 504 `UPSTREAM_TIMEOUT` |
| Upstream status in `circuitBreaker.failureStatuses` (default `[500, 502, 503, 504]`) | upstream response or final error |
| **`UPSTREAM_RESPONSE_TOO_LARGE`** (counted **exactly once**) | 502, or aborted stream (ADR-0018) |
| Unexpected upstream `101` (ADR-0023) | 502 `UPSTREAM_UNAVAILABLE` |

### Never counts as a failure
- Gateway-decided client errors: 400, 401, 404, 405, 413, 429 (ADR-0018). They never contact the upstream.
- `CIRCUIT_OPEN` rejections themselves.
- Upstream 4xx responses (passed through, and they reset the counter as non-failures).
- **The client disconnecting first** (the upstream request is cancelled, but the upstream did nothing wrong).

### Retries
- `UPSTREAM_RESPONSE_TOO_LARGE` is **never retried by default**: the same oversized response would come back
  and multiply resource use. `retries.retryableStatuses` (ADR-0016) applies only to status codes **returned by
  the upstream**, never to gateway-generated errors with the same HTTP status.

### Streaming enforcement
The response-size limit is enforced **while streaming**: bytes are counted as they flow, and the full body is never
buffered to measure it. Before headers are sent the gateway returns the 502. After the response has started it stops
reading from the upstream (destroys that request) and aborts the client response.
In both cases the internal code goes to structured logs and metrics, and response contents are never logged.

## Alternatives considered
- **Rolling window or failure ratio** — handles mixed traffic better, but adds `windowMs`/`minRequests` config and
  time-dependent tests. Can be revisited with benchmark evidence.
- **Count per client request** — the breaker reacts more slowly while retries are hitting a failing upstream.
- **Don't count `UPSTREAM_RESPONSE_TOO_LARGE`** — an upstream that keeps producing oversized responses would keep using up
  gateway resources with nothing to stop it.

## Consequences
- `circuitBreaker.failureStatuses` joins the ADR-0015 config (global default, per-upstream override).
- Tests: N consecutive failed attempts open the breaker; a success in between resets; a retry sequence counts
  each failed attempt; the breaker opening mid-retry stops further attempts; a too-large response increments the
  count exactly once and causes no retry; client abort, upstream 4xx and gateway 4xx don't count; a streamed oversized
  response is cut off without buffering the whole body (assert peak memory/bytes read stays bounded).

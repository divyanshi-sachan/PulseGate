# ADR-0016: `maxAttempts` counts total attempts; optional backoff fields

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** OPEN_QUESTIONS Q5; system_design §11 `RetryPolicy`; tech_impl §8; builds on ADR-0007

## Context
The config only had `retries.maxAttempts` and didn't say whether it counted the first attempt; `RetryPolicy`
also listed `baseDelayMs`, `maxDelayMs` and `retryableStatuses`.

## Decision
- `maxAttempts` = **total upstream attempts including the first**. `maxAttempts: 1` means no retries;
  `maxAttempts: 2` means one original plus one retry. Must be ≥ 1.
- Optional fields, with documented defaults:

```yaml
retries:
  maxAttempts: 2
  baseDelayMs: 50                      # default
  maxDelayMs: 1000                     # default; must be ≥ baseDelayMs
  retryableStatuses: [502, 503, 504]   # default
```

- Connection errors are always retryable, in addition to `retryableStatuses`.
- All ADR-0007 limits still apply: only idempotent methods (unless an explicit idempotency mechanism is
  configured), exponential backoff with jitter capped at `maxDelayMs`, and never past the request deadline (`timeoutMs`).

## Alternatives considered
- **`maxAttempts` only, other values fixed in code** — less config surface, but the backoff can't be tuned per route.
- **`maxAttempts` = retries after the first** — `maxAttempts: 2` producing 3 calls is easy to misread and
  makes the "attempts" name misleading.

## Consequences
- Tests: `maxAttempts: 1` makes exactly one call; `2` makes at most two; delays stay within
  [0, maxDelayMs]; statuses outside `retryableStatuses` aren't retried; POST isn't retried; the deadline stops retries early.
- Metrics count upstream attempts separately from the single client-visible request.

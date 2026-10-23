# ADR-0030: Bounded graceful shutdown and readiness scope

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** user review of ADR-0029 (shutdown and health-check points); PRD NFR Reliability; tech_impl §9.2, §12.9
- **Refines:** ADR-0022 (`/ready`), ADR-0028 (process lifecycle)

## Context
`close()` waited for in-flight requests with no limit. Route timeouts can be up to 300 s, so a slow upstream could
hold shutdown until the orchestrator sent SIGKILL. What `/ready` reflects was also never written down.

## Decision

### Shutdown (`Gateway.close()`, triggered by SIGTERM/SIGINT)
1. `/ready` returns 503 immediately, so load balancers stop sending traffic.
2. The public listener stops accepting new connections; idle keep-alive connections are closed.
3. In-flight requests **drain** for up to **`server.shutdownTimeoutMs`** (default **10000**, range 0–120000).
4. When the deadline passes, every remaining client connection is force-closed. That aborts its upstream call through
   the client signal (ADR-0024: not counted as an upstream failure), and the upstream pools are destroyed instead of closed.
5. The operations listener closes last. `close()` resolves `{ forced: boolean }`, is logged as `shutdown complete`,
   and is idempotent.
- The deadline must be shorter than the orchestrator's grace period. Compose uses `stop_grace_period: 15s` (ADR-0029).

### Readiness scope
- `/ready` = the process is started and not shutting down, **plus required dependencies**. In Phase 1 there are none.
  With `rateLimit.mode: "redis"` and fail-closed, `/ready` also pings Redis (ADR-0034). Fail-open ignores Redis,
  because the instance can still serve with degraded local limits.
- **Upstream health is deliberately not part of readiness.** An unreachable upstream is a per-request error (502/504)
  and, from Phase 3, a circuit-breaker concern. Making readiness depend on upstreams would take the gateway out of
  rotation for *all* routes when one upstream fails, which is the cascading failure ADR-0008 exists to prevent.
- Startup ordering in Compose comes from `depends_on: condition: service_healthy` on the mocks, not from gateway readiness.

## Consequences
- Tests (`apps/gateway/test/lifecycle.test.ts`):
  - `/ready` is 503 before `start()` and 200 after it.
  - `/ready` stays 200 while an upstream is down.
  - An in-flight request drains with a 200 while new connections are refused.
  - Past the deadline, `close()` resolves `{ forced: true }` within the bound and the client connection is closed.
  - `close()` is idempotent.
- Verified in Docker:
  - SIGTERM during a 2.5 s request: the request drained with a 200 and the container stopped in about 2 s.
  - With a 30 s route timeout and a 2 s drain deadline: forced close at exactly 2 s, the client got an empty reply,
    `forced: true` was logged, and the exit code was 0.
  - One earlier attempt was SIGKILLed by Docker after 1.2 s, cause not determined. It did not happen with an explicit
    `docker stop -t 10` or under Compose, whose grace period is set explicitly.
- Known gap: requests arriving on an already-open keep-alive connection during the drain get Fastify's own 503 body,
  not the normalized error shape.

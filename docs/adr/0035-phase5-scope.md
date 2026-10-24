# ADR-0035: Phase 5 scope: cache partitioning, deduplication, observability

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** Phase 5 questions (user chose all recommended options); OPEN_QUESTIONS Q6, Q13; ADR-0009; tech_impl §7, §11, §14

## Decisions
1. **Q6, caching on authenticated routes:**
   - On `auth.required` routes the cache key **includes the `clientId` by default**, so one client never sees another
     client's cached data.
   - A route may opt in to **`cache.scope: "shared"`** for public data.
   - Requests whose `Authorization` header is forwarded (`forwarding.authorization: true`) **always bypass** the cache (ADR-0009).
2. **Q13, request deduplication:** **deferred.** Single-flight coalescing of concurrent misses waits until Phase 6 k6
   benchmarks show a stampede problem; it would get its own ADR.
3. **Observability:** Phase 5 delivers the **bounded in-memory response cache** and Prometheus **`/metrics`** on the
   operations listener (tech_impl §11 names, bounded labels), tested against real traffic. The **React dashboard comes
   next, as a separate step** built on those metrics.

## Consequences
- The cache key and eligibility rules are finalized in the Phase 5 implementation ADR. Tests must show client isolation
  on auth routes, sharing only with `scope: "shared"`, and the bypass on forwarded `Authorization`.

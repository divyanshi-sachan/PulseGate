# ADR-0019: Upstream URL joining and query forwarding

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** ADR-0017 follow-up (base-path joining); tech_impl §8, §12.4
- **Refines:** ADR-0013 rule 3 (`baseUrl` validation), ADR-0017 rules 4–5

## Context
ADR-0017 says the forwarded path is appended to the `baseUrl` path and the query is forwarded verbatim,
but not exactly how. Matching on the raw path while an upstream resolves dot segments would let
`/api/orders/../payments` match the orders route and reach `/api/payments`, bypassing routing.

## Decision

**`baseUrl` validation (startup):** scheme `http`/`https`, host, optional port and optional path only.
Startup fails if there is a query, a fragment or `user:pass@` credentials. Trailing `/` is dropped from the base
path (root base path becomes `""`).

**Per-request algorithm:**
1. Take the **raw** request target from the request line (Node `req.url`), without decoding it.
2. Split at the first `?` into `rawPath` and `rawQuery` (which may be absent or empty).
3. Validate `rawPath`: it must start with `/`; it must have valid percent-encoding; no segment may be `.` or `..`,
   raw or percent-encoded (`%2e`, `%2E`, `.%2e`, …). Any violation → **400 `BAD_REQUEST`** (ADR-0018), before route matching.
4. Match routes against `rawPath` byte-for-byte using ADR-0017's segment rules. A percent-encoded
   spelling of a prefix (e.g. `/api/%6Frders`) does not match it.
5. Forwarded path: `rawPath`, or, with `stripPrefix: true`, `rawPath` with the matched prefix removed (empty → `/`).
6. Upstream target = `basePath + forwardedPath`, plus `"?" + rawQuery` **only if `rawQuery` is non-empty**
   (a bare trailing `?` is dropped).
7. No other rewriting: percent-encoding, duplicate slashes, trailing slashes and query parameter order are
   preserved byte-for-byte.

| baseUrl | Route | Request | Upstream receives |
|---|---|---|---|
| `http://orders:4001` | `/api/orders` | `/api/orders/123?x=1&x=2` | `/api/orders/123?x=1&x=2` |
| `http://orders:4001/v1/` | `/api/orders` | `/api/orders/123` | `/v1/api/orders/123` |
| `http://orders:4001/v1` | `/api/orders`, strip | `/api/orders/123` | `/v1/123` |
| `http://orders:4001` | `/api/orders`, strip | `/api/orders?` | `/` |
| `http://orders:4001` | `/api/orders` | `/api/orders//a%2Fb/` | `/api/orders//a%2Fb/` |
| any | any | `/api/orders/../payments` | — 400 `BAD_REQUEST` |
| any | any | `/api/orders/%2e%2e/payments` | — 400 `BAD_REQUEST` |

## Alternatives considered
- **Normalize dot segments, then match** — more permissive, but the gateway would rewrite client paths, and
  the normalization would have to match every upstream's parser exactly to be safe.
- **Allow a query on `baseUrl` and merge it** — needs merge and ordering rules for no Phase 1 need.
- **Canonicalize paths and queries** — gives cleaner cache keys, but upstreams wouldn't see the original request.
  Cache-key normalization (ADR-0009) is a separate step and doesn't change what is forwarded.

## Consequences
- The proxy must give Undici the joined path string as-is, and a test must show that neither Undici nor
  Fastify re-normalizes it.
- Tests: every row of the table above; `baseUrl` with a query, fragment or credentials fails startup;
  mixed-case `%2E%2e`; invalid percent-encoding (`%zz`) gets 400; a multi-byte UTF-8 percent-encoded path is preserved.

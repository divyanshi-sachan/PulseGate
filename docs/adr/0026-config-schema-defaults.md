# ADR-0026: Config schema defaults, bounds and validation behavior

- **Status:** Accepted (values chosen by Claude during implementation; user to review)
- **Date:** 2026-10-23
- **Source:** Phase 1 `packages/config`; PRD FR-08 ("defaults are documented"); ADRs 0003, 0013–0024
- **Implements:** ADR-0013 to ADR-0024 in `packages/config/src/schema.ts`

## Context
ADRs 0013–0024 fix the shape of the config but left concrete defaults, bounds and some key names open,
including the request and response size-limit keys ADR-0018 deferred.

## Decision

### Top-level sections and defaults
| Key | Default | Notes |
|---|---|---|
| `server.host` / `server.port` | `0.0.0.0` / `8080` | Public listener |
| `server.trustedProxies` | `[]` | IPs or CIDRs (ADR-0021) |
| `server.limits.maxRequestBodyBytes` | `1048576` (1 MiB) | Over the limit → 413 (ADR-0018) |
| `server.limits.maxResponseBodyBytes` | `10485760` (10 MiB) | Over the limit → 502 `UPSTREAM_RESPONSE_TOO_LARGE` |
| `admin.host` / `admin.port` | **`127.0.0.1`** / `9090` | ADR-0020 didn't specify a bind address; loopback chosen for safety |
| `operations.host` / `operations.port` | `127.0.0.1` / `9091` | ADR-0022 |
| `rateLimit.mode` | `local` | `redis` **requires** `redisFailurePolicy: open \| closed` (no default, per ADR-0005) |
| `circuitBreaker.*` | `5` / `10000` / `1` / `[500,502,503,504]` | Merged field by field into each upstream (ADR-0015) |

### Route defaults
| Key | Default | Why |
|---|---|---|
| `auth.required` | **`true`** | Secure by default |
| `rateLimit` | **required** | Every route has an explicit budget |
| `stripPrefix` | `false` | ADR-0017 |
| `timeoutMs` | `3000` | tech_impl §8 example; total deadline including retries |
| `retries.maxAttempts` | **`1`** (no retries) | Retries are opt-in; the others default to 50 / 1000 / `[502,503,504]` (ADR-0016) |
| `cache.enabled` | `false` | Conservative (ADR-0009); `ttlSeconds` is required when enabled, `maxResponseBytes` defaults to `262144` |
| `forwarding.authorization` / `.forwardedHost` | `false` / `false` | ADR-0021 |

### Value rules
- **Identifiers** (route and upstream ids): 1–64 characters `[A-Za-z0-9._-]`, starting with a letter or digit. Safe as
  bounded metric labels.
- **Methods:** `GET HEAD POST PUT PATCH DELETE OPTIONS`, uppercase, no duplicates. `CONNECT`/`TRACE` aren't
  routable (ADR-0023). `GET` does not imply `HEAD`.
- **`pathPrefix`:** `/`, or `/seg(/seg)*` with no trailing `/`, no empty, `.` or `..` segments, and only unreserved
  path characters (no percent-encoding, `?` or `#`), because matching is byte-for-byte on the raw path (ADR-0019).
- **Status lists:** `retryableStatuses` ⊆ {408, 429, 5xx}; `failureStatuses` ⊆ 5xx. No duplicates.
- **Bounds:** `maxAttempts` 1–10; `timeoutMs` 1–300000; backoff delays 0–60000 with `maxDelayMs ≥ baseDelayMs`;
  `ttlSeconds` 1–86400; ports 1–65535 and distinct across the three listeners; counts ≥ 1; refill rate > 0.
- **Not in the config yet:** API clients and keys (Phase 2: secrets via env, design pending) and Redis connection
  settings (Phase 4).

### Validation behavior
- Every object is **strict**: unknown keys are errors. Keys from older spec drafts get a hint
  (`routes[].upstream` → ADR-0013, `routes[].authRequired` → ADR-0014, `routes[].circuitBreaker` → ADR-0015).
- Errors are collected and reported **all at once** as `ConfigError`, one line per problem:
  `routes[1] ("create-orders").upstreamId: unknown upstream "x"; known upstreams: "a" (ADR-0013)`.
  `baseUrl` values are never echoed, because they might contain credentials.
- Rules that compare fields (duplicate ids, unknown `upstreamId`, overlapping prefix + method, port clashes)
  run only **after every individual field passes**, a property of Zod refinements. A broken file may need two
  rounds of fixes.
- Files: `.yaml`/`.yml` or `.json`, chosen by extension. Duplicate YAML keys and syntax errors are reported with
  their position. A missing file points to `config/routes.example.yaml`.
- The resolved config is **deeply frozen** (static at runtime, ADR-0003). Upstreams expose the normalized `baseUrl`,
  `origin`, `basePath` and fully resolved `circuitBreaker` settings.

## Consequences
- `config/routes.example.yaml` documents every default inline, and a test loads it, so it can't drift.
- Changing any default above means updating this ADR, the example file and the defaults test together.

# ADR-0021: Header forwarding and trusted-proxy rules

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** OPEN_QUESTIONS Q16; PRD FR-01 ("forwarded according to documented rules"), NFR Security
  (trusted-proxy assumptions); tech_impl §12.10
- **Relates to:** ADR-0009 (cache), ADR-0014 (auth), ADR-0019 (raw query), Q8 (rate-limit identity)

## Context
FR-01 requires documented header forwarding, and the security requirements ask for documented trusted-proxy
and client-IP handling. Without explicit rules, the client's API key would leak to upstreams and clients
could spoof the IP used for rate limiting.

## Decision

### Request headers (client → upstream)

| Header | Gateway behavior |
|---|---|
| `Host` | Set to the configured upstream host and port (from `baseUrl`). |
| `Connection` | Strip it, **and every header named in its value**. |
| `Keep-Alive`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`, `Proxy-Connection`, `Proxy-Authorization` | Strip. (No WebSocket/upgrade support in v1; it would need its own ADR.) |
| `X-API-Key` (the configured auth header) | Used for gateway authentication, then **always stripped**. |
| `Authorization` | **Stripped by default.** Forwarded only when the route opts in with `forwarding.authorization: true`. Never logged. |
| `X-Forwarded-For` | Rebuilt by the gateway using the trusted-proxy rules below. |
| `X-Forwarded-Proto` | From the actual connection, or from a trusted proxy's value if it is `http` or `https`. |
| `X-Forwarded-Host` | Added only when the route sets `forwarding.forwardedHost: true`, using the validated original `Host`. |
| Other end-to-end headers | Passed through unchanged unless a policy explicitly removes them. |

Route config (all optional, defaults shown):

```yaml
forwarding:
  authorization: false
  forwardedHost: false
```

### Response headers (upstream → client)
Hop-by-hop headers (`Connection` and the headers it names, `Keep-Alive`, `Transfer-Encoding`, `Trailer`, `Upgrade`,
`Proxy-*`) are also stripped from upstream responses. Node manages framing for the client connection. Other headers
are passed through.

### Trusted proxies and client IP
- Top-level `server.trustedProxies`: a list of IPs/CIDRs, empty by default.
- If the direct peer is **not** trusted: ignore every incoming `X-Forwarded-*` value. Client IP = peer address;
  outgoing `X-Forwarded-For` = peer address.
- If the direct peer **is** trusted: read the incoming `X-Forwarded-For` from right to left, skipping trusted addresses. The first
  untrusted address is the client IP. Outgoing `X-Forwarded-For` = incoming chain + peer address. Malformed entries
  are treated as untrusted, and walking stops there.
- This client IP is the only IP used for any IP-based identity (e.g. rate limiting on unauthenticated routes, Q8),
  so clients can't spoof it.

## Alternatives considered
- **Forward `X-API-Key` / `Authorization` by default** — leaks gateway credentials to every upstream and widens the
  blast radius of a compromised upstream.
- **Trust `X-Forwarded-For` unconditionally** — any client could pick its own rate-limit identity.

## Consequences
- The two `forwarding` flags and `server.trustedProxies` join the Zod schema.
- Routes with `forwarding.authorization: true` still bypass the cache by default (ADR-0009).
- Tests: every row in both tables (stripped and preserved); headers named in `Connection` are stripped; spoofed
  `X-Forwarded-For` from an untrusted peer is ignored; a trusted chain picks the right client IP; an invalid
  `X-Forwarded-Proto` is ignored; `Host` is rewritten; the raw query is unchanged (ADR-0019).

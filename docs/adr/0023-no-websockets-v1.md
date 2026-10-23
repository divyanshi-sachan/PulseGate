# ADR-0023: No WebSocket or protocol-upgrade support in v1

- **Status:** Accepted
- **Date:** 2026-10-23
- **Source:** ADR-0021 follow-up (`Upgrade` stripped); PRD §5 scope
- **Relates to:** ADR-0018 (`BAD_REQUEST`), ADR-0021 (hop-by-hop stripping)

## Context
ADR-0021 strips `Upgrade`, which rules out WebSockets. Node's HTTP server doesn't pass requests carrying
`Connection: Upgrade` to normal handlers: it emits an `upgrade` event and, with no listener, destroys
the socket without a response. The same happens for the `CONNECT` method (`connect` event).

## Decision
- WebSocket, h2c and any other HTTP/1.1 protocol upgrade is **unsupported in v1**. The gateway never answers `101`
  and never forwards `Upgrade`.
- The public listener registers `upgrade` and `connect` handlers that write a normalized
  **400 `BAD_REQUEST`** response (message: protocol upgrade / CONNECT not supported) with `Connection: close`,
  then close the socket. Nothing is silently dropped.
- These rejections happen before route matching, auth and rate limiting. They get a request ID, are logged
  and counted under the client-error outcome, and never touch a circuit breaker.
- If an upstream still answers `101` (it shouldn't, since `Upgrade` is stripped), it is treated as a protocol error:
  **502 `UPSTREAM_UNAVAILABLE`**, no upgraded connection, logged.

## Alternatives considered
- **Let Node drop the socket** — no response, nothing logged or counted, and clients can't tell why.
- **New `UPGRADE_NOT_SUPPORTED` / 501 code** — clearer for clients, but adds a code for an out-of-scope feature.
- **Support WebSockets** — needs its own design (auth on upgrade, rate limiting long-lived connections,
  idle timeouts, breaker semantics). Out of scope for v1, and would get its own ADR.

## Consequences
- Tests: a WebSocket upgrade request gets 400 and the connection closes without upgrading; an h2c upgrade
  likewise; `CONNECT` gets 400; nothing reaches the upstream; a mocked upstream `101` gets 502 with no upgrade.

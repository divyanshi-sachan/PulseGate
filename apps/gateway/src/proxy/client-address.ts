import { BlockList, isIP } from 'node:net';

export interface ClientAddress {
  /** Address used for IP-based identity (e.g. rate limiting); never taken from an untrusted header. */
  clientIp: string;
  /** Outgoing X-Forwarded-For chain, ending with the direct peer. */
  forwardedFor: string[];
  /** True when the direct peer is a configured trusted proxy. */
  viaTrustedProxy: boolean;
}

/** Strips the IPv4-mapped IPv6 prefix Node reports for IPv4 peers on dual-stack sockets. */
export function normalizeIp(address: string): string {
  const unmapped = address.startsWith('::ffff:') ? address.slice(7) : address;
  return isIP(unmapped) === 4 ? unmapped : address;
}

export class TrustedProxies {
  readonly #list = new BlockList();
  readonly #empty: boolean;

  constructor(entries: readonly string[]) {
    for (const entry of entries) {
      const [address = '', prefix] = entry.split('/');
      const type = isIP(address) === 6 ? 'ipv6' : 'ipv4';
      if (prefix === undefined) this.#list.addAddress(address, type);
      else this.#list.addSubnet(address, Number(prefix), type);
    }
    this.#empty = entries.length === 0;
  }

  has(address: string): boolean {
    if (this.#empty) return false;
    const family = isIP(address);
    if (family === 0) return false;
    return this.#list.check(address, family === 6 ? 'ipv6' : 'ipv4');
  }
}

/**
 * Resolves the client address per ADR-0021. Incoming X-Forwarded-For is only honored when the
 * direct peer is trusted; the chain is walked right to left, skipping trusted hops, and the
 * first untrusted (or malformed) entry is the client.
 */
export function resolveClientAddress(
  peerAddress: string,
  forwardedForHeader: string | undefined,
  trusted: TrustedProxies,
): ClientAddress {
  const peer = normalizeIp(peerAddress);
  if (!trusted.has(peer) || forwardedForHeader === undefined || forwardedForHeader.trim() === '') {
    return { clientIp: peer, forwardedFor: [peer], viaTrustedProxy: trusted.has(peer) };
  }

  const chain = forwardedForHeader
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  let clientIp = peer;
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = normalizeIp(chain[i] ?? '');
    clientIp = hop;
    if (isIP(hop) === 0 || !trusted.has(hop)) break;
  }
  return { clientIp, forwardedFor: [...chain, peer], viaTrustedProxy: true };
}

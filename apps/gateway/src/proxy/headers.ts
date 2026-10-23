import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import type { RouteConfig } from '@pulsegate/config';

/** Connection-level headers that are never forwarded in either direction (ADR-0021). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
]);

/** Request headers the gateway consumes or rebuilds itself. */
const GATEWAY_OWNED_REQUEST_HEADERS = new Set([
  'host',
  'x-api-key',
  'x-request-id',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  // undici rejects Expect; Node already answered any 100-continue.
  'expect',
]);

const VALID_HOST = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

function connectionListed(value: string | string[] | number | undefined): Set<string> {
  if (value === undefined) return new Set();
  const joined = Array.isArray(value) ? value.join(',') : String(value);
  return new Set(
    joined
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ''),
  );
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export interface UpstreamRequestContext {
  route: RouteConfig;
  requestId: string;
  forwardedFor: readonly string[];
  viaTrustedProxy: boolean;
  /** Protocol of the client connection to the gateway. */
  connectionProto: 'http' | 'https';
}

/** Builds headers for the upstream request (ADR-0021 request table). */
export function buildUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  context: UpstreamRequestContext,
): Record<string, string | string[]> {
  const listed = connectionListed(incoming.connection);
  const out: Record<string, string | string[]> = {};

  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name) || listed.has(name) || GATEWAY_OWNED_REQUEST_HEADERS.has(name)) {
      continue;
    }
    if (name === 'authorization' && !context.route.forwarding.authorization) continue;
    out[name] = value;
  }

  out['x-request-id'] = context.requestId;
  out['x-forwarded-for'] = context.forwardedFor.join(', ');

  const incomingProto = firstValue(incoming['x-forwarded-proto'])?.split(',').at(-1)?.trim();
  out['x-forwarded-proto'] =
    context.viaTrustedProxy && (incomingProto === 'http' || incomingProto === 'https')
      ? incomingProto
      : context.connectionProto;

  if (context.route.forwarding.forwardedHost) {
    const host = incoming.host;
    if (host !== undefined && VALID_HOST.test(host)) out['x-forwarded-host'] = host;
  }
  return out;
}

/** Copies upstream response headers, dropping hop-by-hop ones (ADR-0021 response rules). */
export function filterResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
): OutgoingHttpHeaders {
  const entries = Object.entries(headers).map(
    ([name, value]) => [name.toLowerCase(), value] as const,
  );
  const connection = entries.find(([name]) => name === 'connection')?.[1];
  const listed = connectionListed(connection);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of entries) {
    if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name)) continue;
    out[name] = value;
  }
  return out;
}

import type { HeaderValues, RouteCachePolicy } from './types.ts';

type IncomingHeaders = Record<string, string | string[] | undefined>;

/** Request headers that must never be used to vary or key the cache (they carry credentials). */
export const FORBIDDEN_VARY_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
]);

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

/** Parses a Cache-Control header into lowercase directives (value-less directives map to ''). */
export function parseCacheControl(value: string | string[] | undefined): Map<string, string> {
  const directives = new Map<string, string>();
  for (const part of (first(value) ?? '').split(',')) {
    const [rawName = '', ...rest] = part.split('=');
    const name = rawName.trim().toLowerCase();
    if (name !== '') directives.set(name, rest.join('=').trim().replace(/^"|"$/g, ''));
  }
  return directives;
}

export type BypassReason = 'method' | 'authorization-forwarded' | 'client-no-cache';

/** Why a request must skip the cache entirely, or undefined if it may use it (ADR-0036). */
export function requestBypassReason(
  method: string,
  headers: IncomingHeaders,
  forwardsAuthorization: boolean,
): BypassReason | undefined {
  if (method !== 'GET') return 'method';
  if (forwardsAuthorization && headers['authorization'] !== undefined)
    return 'authorization-forwarded';
  const cacheControl = parseCacheControl(headers['cache-control']);
  if (cacheControl.has('no-cache') || cacheControl.has('no-store')) return 'client-no-cache';
  if (/no-cache/i.test(first(headers['pragma']) ?? '')) return 'client-no-cache';
  return undefined;
}

/** `client:<id>` on authenticated routes unless the route opted into shared caching (ADR-0035). */
export function cachePartition(policy: RouteCachePolicy, clientId: string | undefined): string {
  return policy.scope === 'shared' || clientId === undefined ? 'shared' : `client:${clientId}`;
}

export interface CacheKeyInput {
  routeId: string;
  method: string;
  rawPath: string;
  rawQuery: string;
  partition: string;
  varyHeaders: readonly string[];
  requestHeaders: IncomingHeaders;
}

/** Unambiguous key: a JSON array of all parts; never includes credentials (FORBIDDEN_VARY_HEADERS). */
export function cacheKey(input: CacheKeyInput): string {
  const vary = input.varyHeaders.map((name) => [name, first(input.requestHeaders[name]) ?? null]);
  return JSON.stringify([
    'v1',
    input.routeId,
    input.method,
    input.partition,
    input.rawPath,
    input.rawQuery,
    vary,
  ]);
}

export type Storability =
  | { storable: true; ttlMs: number }
  | { storable: false; reason: 'status' | 'set-cookie' | 'cache-control' | 'vary' };

/** Whether an upstream response may be stored, and for how long (ADR-0009, ADR-0036). */
export function storability(
  statusCode: number,
  headers: HeaderValues | Record<string, string | string[] | undefined>,
  policy: RouteCachePolicy,
): Storability {
  if (statusCode !== 200) return { storable: false, reason: 'status' };
  if (headers['set-cookie'] !== undefined) return { storable: false, reason: 'set-cookie' };

  const cacheControl = parseCacheControl(headers['cache-control']);
  if (['no-store', 'no-cache', 'private'].some((directive) => cacheControl.has(directive))) {
    return { storable: false, reason: 'cache-control' };
  }

  const vary = (first(headers['vary']) ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');
  if (vary.some((name) => name === '*' || !policy.varyHeaders.includes(name))) {
    return { storable: false, reason: 'vary' };
  }

  let ttlSeconds = policy.ttlSeconds;
  for (const directive of ['s-maxage', 'max-age']) {
    const raw = cacheControl.get(directive);
    if (raw === undefined) continue;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) ttlSeconds = Math.min(ttlSeconds, seconds);
    break;
  }
  if (ttlSeconds <= 0) return { storable: false, reason: 'cache-control' };
  return { storable: true, ttlMs: ttlSeconds * 1000 };
}

/** Headers safe to replay from cache: no cookies, no per-request ids (ADR-0036). */
export function cacheableHeaders(
  headers: Record<string, string | string[] | number | undefined>,
): HeaderValues {
  const out: HeaderValues = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === 'set-cookie' || lower === 'x-request-id' || lower === 'age') continue;
    out[lower] = typeof value === 'number' ? String(value) : value;
  }
  return out;
}

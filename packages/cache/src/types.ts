export type HeaderValues = Record<string, string | string[]>;

export interface CachedResponse {
  statusCode: number;
  /** Lowercase names; already stripped of hop-by-hop, Set-Cookie and X-Request-ID. */
  headers: HeaderValues;
  body: Buffer;
  storedAtMs: number;
  expiresAtMs: number;
}

/** Strategy interface (system_design §12): a Redis implementation could replace the memory one. */
export interface ResponseCache {
  get(key: string): Promise<CachedResponse | undefined>;
  set(key: string, value: CachedResponse): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Per-route cache settings the rules need (mirrors the validated route config). */
export interface RouteCachePolicy {
  ttlSeconds: number;
  maxResponseBytes: number;
  scope: 'client' | 'shared';
  /** Lowercase request header names that partition entries and may appear in a response's Vary. */
  varyHeaders: readonly string[];
}

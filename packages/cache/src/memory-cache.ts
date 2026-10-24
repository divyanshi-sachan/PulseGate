import type { CachedResponse, ResponseCache } from './types.ts';

export interface MemoryCacheOptions {
  maxEntries: number;
  maxBytes: number;
  /** Wall-clock-like milliseconds; injectable for tests (default Date.now). */
  now?: () => number;
  onEvict?: (reason: 'capacity' | 'expired') => void;
}

export interface MemoryCacheStats {
  entries: number;
  bytes: number;
  evictedCapacity: number;
  evictedExpired: number;
}

function sizeOf(value: CachedResponse): number {
  let headerBytes = 0;
  for (const [name, header] of Object.entries(value.headers)) {
    headerBytes += name.length + (Array.isArray(header) ? header.join('').length : header.length);
  }
  return value.body.length + headerBytes;
}

/**
 * Bounded in-memory response cache (ADR-0009, ADR-0036): least-recently-used eviction until both the
 * entry and byte bounds hold; expired entries are dropped on access and by sweep(). The Map is kept in
 * recency order, so the first key is always the LRU entry.
 */
export class MemoryResponseCache implements ResponseCache {
  readonly #entries = new Map<string, { value: CachedResponse; size: number }>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #now: () => number;
  readonly #onEvict: ((reason: 'capacity' | 'expired') => void) | undefined;
  #bytes = 0;
  #evictedCapacity = 0;
  #evictedExpired = 0;

  constructor(options: MemoryCacheOptions) {
    this.#maxEntries = options.maxEntries;
    this.#maxBytes = options.maxBytes;
    this.#now = options.now ?? Date.now;
    this.#onEvict = options.onEvict;
  }

  get(key: string): Promise<CachedResponse | undefined> {
    const entry = this.#entries.get(key);
    if (entry === undefined) return Promise.resolve(undefined);
    if (entry.value.expiresAtMs <= this.#now()) {
      this.#remove(key, 'expired');
      return Promise.resolve(undefined);
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return Promise.resolve(entry.value);
  }

  set(key: string, value: CachedResponse): Promise<void> {
    const size = sizeOf(value);
    this.#remove(key);
    if (size > this.#maxBytes || value.expiresAtMs <= this.#now()) return Promise.resolve();
    while (
      this.#entries.size > 0 &&
      (this.#entries.size >= this.#maxEntries || this.#bytes + size > this.#maxBytes)
    ) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#remove(oldest.value, 'capacity');
    }
    this.#entries.set(key, { value, size });
    this.#bytes += size;
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.#remove(key);
    return Promise.resolve();
  }

  /** Drops expired entries; returns how many were removed. */
  sweep(): number {
    const now = this.#now();
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.value.expiresAtMs <= now) {
        this.#remove(key, 'expired');
        removed++;
      }
    }
    return removed;
  }

  stats(): MemoryCacheStats {
    return {
      entries: this.#entries.size,
      bytes: this.#bytes,
      evictedCapacity: this.#evictedCapacity,
      evictedExpired: this.#evictedExpired,
    };
  }

  #remove(key: string, reason?: 'capacity' | 'expired'): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    this.#bytes -= entry.size;
    if (reason === 'capacity') this.#evictedCapacity++;
    if (reason === 'expired') this.#evictedExpired++;
    if (reason !== undefined) this.#onEvict?.(reason);
  }
}

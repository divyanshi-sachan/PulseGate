import type { CachedResponse } from './types.ts';

/**
 * How a leader's fill ended (ADR-0050).
 * - `stored`: the entry every waiter is served from.
 * - `not_storable` / `too_large`: the response must not be shared, so waiters fetch for themselves.
 * - `failed` / `aborted`: the upstream call failed or the leader's client left; waiters hand off (one becomes leader).
 */
export type FillOutcome =
  | { stored: true; entry: CachedResponse }
  | { stored: false; reason: 'not_storable' | 'too_large' | 'failed' | 'aborted' };

/** What a waiter gets: the leader's outcome, or `cancelled` when its own signal (deadline or client) aborted first. */
export type WaitResult = FillOutcome | { stored: false; reason: 'cancelled' };

export type Join =
  | { role: 'leader'; settle: (outcome: FillOutcome) => void }
  | { role: 'waiter'; wait: (signal: AbortSignal) => Promise<WaitResult> }
  | { role: 'none'; reason: 'waiter_limit' | 'key_limit' };

export interface InflightFillsOptions {
  /** Waiters allowed on one key; beyond it, requests go upstream themselves (default 1,000). */
  maxWaitersPerKey?: number;
  /** Keys being filled at once; beyond it, no coalescing (default 10,000). */
  maxPendingKeys?: number;
}

interface Fill {
  waiters: Set<(result: WaitResult) => void>;
}

/**
 * Single-flight registry for cache misses (ADR-0050). The first miss on a key leads; concurrent misses wait for the
 * leader's outcome. Bounded per key and in keys. Settling removes the key **before** resolving the waiters, so a
 * hand-off join finds it free and a fill can never outlive its leader's settle.
 */
export class InflightFills {
  readonly #fills = new Map<string, Fill>();
  readonly #maxWaitersPerKey: number;
  readonly #maxPendingKeys: number;

  constructor(options: InflightFillsOptions = {}) {
    this.#maxWaitersPerKey = options.maxWaitersPerKey ?? 1000;
    this.#maxPendingKeys = options.maxPendingKeys ?? 10_000;
  }

  join(key: string): Join {
    const fill = this.#fills.get(key);
    if (fill === undefined) {
      if (this.#fills.size >= this.#maxPendingKeys) return { role: 'none', reason: 'key_limit' };
      const created: Fill = { waiters: new Set() };
      this.#fills.set(key, created);
      return { role: 'leader', settle: this.#settler(key, created) };
    }
    if (fill.waiters.size >= this.#maxWaitersPerKey)
      return { role: 'none', reason: 'waiter_limit' };
    return { role: 'waiter', wait: (signal) => this.#wait(fill, signal) };
  }

  /** For gauges and tests: keys being filled and waiters attached. */
  stats(): { pendingKeys: number; waiters: number } {
    let waiters = 0;
    for (const fill of this.#fills.values()) waiters += fill.waiters.size;
    return { pendingKeys: this.#fills.size, waiters };
  }

  #settler(key: string, fill: Fill): (outcome: FillOutcome) => void {
    let settled = false;
    return (outcome) => {
      if (settled) return;
      settled = true;
      // Remove first: waiters that hand off must find the key free. Only this fill can be registered under the key
      // until now (a key is freed only here, and this runs once), so the delete can't touch a newer fill.
      this.#fills.delete(key);
      const waiters = [...fill.waiters];
      fill.waiters.clear();
      for (const resolve of waiters) resolve(outcome);
    };
  }

  #wait(fill: Fill, signal: AbortSignal): Promise<WaitResult> {
    if (signal.aborted) return Promise.resolve({ stored: false, reason: 'cancelled' });
    return new Promise((resolve) => {
      const done = (result: WaitResult) => {
        fill.waiters.delete(done);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => {
        done({ stored: false, reason: 'cancelled' });
      };
      fill.waiters.add(done);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

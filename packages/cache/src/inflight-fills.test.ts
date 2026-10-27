import { describe, expect, it } from 'vitest';
import { InflightFills, type FillOutcome, type Join, type WaitResult } from './inflight-fills.ts';
import type { CachedResponse } from './types.ts';

const entry: CachedResponse = {
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from('{"ok":true}'),
  storedAtMs: 1000,
  expiresAtMs: 61_000,
};

function leader(join: Join): (outcome: FillOutcome) => void {
  if (join.role !== 'leader') throw new Error(`expected leader, got ${join.role}`);
  return join.settle;
}

function waiter(join: Join, signal = new AbortController().signal): Promise<WaitResult> {
  if (join.role !== 'waiter') throw new Error(`expected waiter, got ${join.role}`);
  return join.wait(signal);
}

describe('InflightFills (ADR-0050)', () => {
  it('makes the first miss the leader and later misses on the same key waiters', () => {
    const fills = new InflightFills();
    expect(fills.join('k').role).toBe('leader');
    expect(fills.join('k').role).toBe('waiter');
    expect(fills.join('other').role).toBe('leader');
  });

  it('delivers the stored entry to every waiter, then frees the key', async () => {
    const fills = new InflightFills();
    const settle = leader(fills.join('k'));
    const waits = [waiter(fills.join('k')), waiter(fills.join('k')), waiter(fills.join('k'))];
    expect(fills.stats()).toEqual({ pendingKeys: 1, waiters: 3 });
    settle({ stored: true, entry });
    const results = await Promise.all(waits);
    for (const result of results) expect(result).toEqual({ stored: true, entry });
    // The very same entry object (and body buffer) is shared, not copied.
    expect(results.every((r) => r.stored && r.entry === entry)).toBe(true);
    expect(fills.stats()).toEqual({ pendingKeys: 0, waiters: 0 });
    expect(fills.join('k').role).toBe('leader');
  });

  it.each(['not_storable', 'too_large', 'failed', 'aborted'] as const)(
    'passes a "not stored" outcome (%s) to every waiter',
    async (reason) => {
      const fills = new InflightFills();
      const settle = leader(fills.join('k'));
      const wait = waiter(fills.join('k'));
      settle({ stored: false, reason });
      expect(await wait).toEqual({ stored: false, reason });
    },
  );

  it('lets a waiter hand off: after a failed fill, the next join on the key leads', async () => {
    const fills = new InflightFills();
    const settle = leader(fills.join('k'));
    const first = waiter(fills.join('k'));
    const second = waiter(fills.join('k'));
    settle({ stored: false, reason: 'aborted' });
    expect(await first).toEqual({ stored: false, reason: 'aborted' });
    await second;
    // Both waiters re-join: exactly one becomes the new leader, the other waits on it.
    const roles = [fills.join('k').role, fills.join('k').role];
    expect(roles).toEqual(['leader', 'waiter']);
  });

  it('settles only once: a late second settle from the same leader changes nothing', async () => {
    const fills = new InflightFills();
    const settle = leader(fills.join('k'));
    const wait = waiter(fills.join('k'));
    settle({ stored: true, entry });
    settle({ stored: false, reason: 'failed' });
    expect(await wait).toEqual({ stored: true, entry });
    // Even after a new leader registered the key, the old settler is spent and can't remove the new fill.
    const newSettle = leader(fills.join('k'));
    settle({ stored: false, reason: 'failed' });
    expect(fills.stats().pendingKeys).toBe(1);
    newSettle({ stored: true, entry });
    expect(fills.stats().pendingKeys).toBe(0);
  });

  it('bounds waiters per key; a cancelled waiter frees its slot', async () => {
    const fills = new InflightFills({ maxWaitersPerKey: 2 });
    leader(fills.join('k'));
    const controller = new AbortController();
    const cancelled = waiter(fills.join('k'), controller.signal);
    void waiter(fills.join('k'));
    expect(fills.join('k')).toEqual({ role: 'none', reason: 'waiter_limit' });
    controller.abort();
    expect(await cancelled).toEqual({ stored: false, reason: 'cancelled' });
    expect(fills.join('k').role).toBe('waiter');
  });

  it('bounds the number of keys being filled', () => {
    const fills = new InflightFills({ maxPendingKeys: 2 });
    leader(fills.join('a'));
    leader(fills.join('b'));
    expect(fills.join('c')).toEqual({ role: 'none', reason: 'key_limit' });
    // Waiters on keys already being filled are still accepted.
    expect(fills.join('a').role).toBe('waiter');
  });

  it('resolves a waiter whose signal is already aborted at once, without attaching it', async () => {
    const fills = new InflightFills();
    leader(fills.join('k'));
    expect(await waiter(fills.join('k'), AbortSignal.abort())).toEqual({
      stored: false,
      reason: 'cancelled',
    });
    expect(fills.stats().waiters).toBe(0);
  });

  it('never leaks a fill when the leader settles from a finally after an exception', () => {
    const fills = new InflightFills();
    const settle = leader(fills.join('k'));
    expect(() => {
      try {
        throw new Error('upstream exploded');
      } finally {
        settle({ stored: false, reason: 'failed' });
      }
    }).toThrow('upstream exploded');
    expect(fills.stats()).toEqual({ pendingKeys: 0, waiters: 0 });
  });

  it('ignores a cancelled waiter when the leader later settles', async () => {
    const fills = new InflightFills();
    const settle = leader(fills.join('k'));
    const controller = new AbortController();
    const cancelled = waiter(fills.join('k'), controller.signal);
    const kept = waiter(fills.join('k'));
    controller.abort();
    settle({ stored: true, entry });
    expect(await cancelled).toEqual({ stored: false, reason: 'cancelled' });
    expect(await kept).toEqual({ stored: true, entry });
  });
});

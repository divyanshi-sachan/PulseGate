import { describe, expect, it } from 'vitest';
import { TargetSet, type AttemptOutcome, type LoadBalancing } from './target-set.ts';

function make(
  count: number,
  options: {
    algorithm?: LoadBalancing;
    consecutiveFailures?: number;
    ejectionMs?: number;
    maxEjectedPercent?: number;
  } = {},
) {
  let now = 0;
  const changes: string[] = [];
  const set = new TargetSet({
    ids: Array.from({ length: count }, (_, i) => `t${String(i)}`),
    algorithm: options.algorithm ?? 'round-robin',
    ejection: {
      consecutiveFailures: options.consecutiveFailures ?? 3,
      ejectionMs: options.ejectionMs ?? 1000,
      maxEjectedPercent: options.maxEjectedPercent ?? 50,
    },
    now: () => now,
    onStateChange: ({ id, from, to }) => changes.push(`${id}:${from}->${to}`),
  });
  return {
    set,
    changes,
    advance: (ms: number) => {
      now += ms;
    },
    /** Acquires and immediately settles; returns the target id. */
    use: (outcome: AttemptOutcome, exclude?: number) => {
      const lease = set.acquire(exclude);
      lease.settle(outcome);
      return lease.id;
    },
    states: () => set.snapshot().map((t) => t.state),
  };
}

describe('TargetSet selection (ADR-0051)', () => {
  it('round-robins over healthy targets, in order, forever', () => {
    const { use } = make(3);
    expect(Array.from({ length: 7 }, () => use('success'))).toEqual([
      't0',
      't1',
      't2',
      't0',
      't1',
      't2',
      't0',
    ]);
  });

  it('least-connections picks the target with the fewest in-flight attempts, ties in rotation order', () => {
    const { set } = make(3, { algorithm: 'least-connections' });
    const a = set.acquire(); // all 0: t0
    const b = set.acquire(); // t0 has 1: t1
    const c = set.acquire(); // t2
    expect([a.id, b.id, c.id]).toEqual(['t0', 't1', 't2']);
    a.settle('success'); // t0 now 0, t1 and t2 still 1
    expect(set.acquire().id).toBe('t0');
    b.settle('success');
    c.settle('success');
  });

  it('least-connections follows skewed in-flight counts', () => {
    const { set } = make(2, { algorithm: 'least-connections' });
    const held = [set.acquire(), set.acquire(), set.acquire()]; // t0, t1, t0 → in-flight 2 and 1
    expect(set.snapshot().map((t) => t.inFlight)).toEqual([2, 1]);
    expect(set.acquire().id).toBe('t1'); // 1 < 2
    for (const lease of held) lease.settle('neutral');
  });

  it('avoids the excluded target (a retry lands elsewhere) when another target can serve', () => {
    const { set } = make(3);
    for (let i = 0; i < 6; i++) {
      const lease = set.acquire(1);
      expect(lease.index).not.toBe(1);
      lease.settle('success');
    }
  });

  it('uses the excluded target when it is the only one', () => {
    const { set } = make(1);
    expect(set.acquire(0).id).toBe('t0');
  });

  it('settles exactly once: a second settle changes nothing, and in-flight never goes negative', () => {
    const { set } = make(1);
    const lease = set.acquire();
    lease.settle('success');
    lease.settle('failure');
    lease.settle('failure');
    expect(set.snapshot()[0]).toMatchObject({
      inFlight: 0,
      consecutiveFailures: 0,
      state: 'healthy',
    });
  });
});

describe('TargetSet passive ejection (ADR-0051)', () => {
  it('ejects a target after the configured consecutive failures and stops sending it traffic', () => {
    const { set, use, changes } = make(3, { consecutiveFailures: 3 });
    // Fail t1 three times (round-robin visits it every third pick).
    const seen: string[] = [];
    for (let i = 0; i < 9; i++) {
      const lease = set.acquire();
      seen.push(lease.id);
      lease.settle(lease.id === 't1' ? 'failure' : 'success');
    }
    expect(changes).toEqual(['t1:healthy->ejected']);
    const after = Array.from({ length: 6 }, () => use('success'));
    expect(after).not.toContain('t1');
    expect(new Set(after)).toEqual(new Set(['t0', 't2']));
  });

  it('resets the count on a success: only consecutive failures eject', () => {
    const { set, changes } = make(2, { consecutiveFailures: 3 });
    const use = (id: 't0' | 't1', outcome: AttemptOutcome) => {
      // Select t0 or t1 deterministically through exclusion.
      const lease = set.acquire(id === 't0' ? 1 : 0);
      lease.settle(outcome);
    };
    use('t0', 'failure');
    use('t0', 'failure');
    use('t0', 'success');
    use('t0', 'failure');
    use('t0', 'failure');
    expect(changes).toEqual([]);
    use('t0', 'failure');
    expect(changes).toEqual(['t0:healthy->ejected']);
  });

  it('neutral outcomes (client left, gateway 4xx) count neither way', () => {
    const { set, changes } = make(2, { consecutiveFailures: 2 });
    for (let i = 0; i < 10; i++) set.acquire(1).settle('neutral');
    expect(changes).toEqual([]);
    set.acquire(1).settle('failure');
    for (let i = 0; i < 10; i++) set.acquire(1).settle('neutral');
    set.acquire(1).settle('failure');
    expect(changes).toEqual(['t0:healthy->ejected']); // neutrals in between neither reset nor added
  });

  it('never ejects more than maxEjectedPercent of the targets, and never the last one', () => {
    const { set, states } = make(4, { consecutiveFailures: 1, maxEjectedPercent: 50 });
    for (let i = 0; i < 20; i++) set.acquire().settle('failure');
    expect(states().filter((s) => s === 'ejected')).toHaveLength(2); // floor(4 × 50 %)
    const single = make(1, { consecutiveFailures: 1, maxEjectedPercent: 100 });
    for (let i = 0; i < 5; i++) single.set.acquire().settle('failure');
    expect(single.states()).toEqual(['healthy']);
    const two = make(2, { consecutiveFailures: 1, maxEjectedPercent: 100 });
    for (let i = 0; i < 6; i++) two.set.acquire().settle('failure');
    expect(two.states().filter((s) => s === 'ejected')).toHaveLength(1); // 100 % still leaves one
  });
});

describe('TargetSet re-admission (ADR-0051)', () => {
  function ejectT1() {
    const ctx = make(3, { consecutiveFailures: 2, ejectionMs: 1000 });
    for (let i = 0; i < 6; i++) {
      const lease = ctx.set.acquire();
      lease.settle(lease.id === 't1' ? 'failure' : 'success');
    }
    expect(ctx.states()).toEqual(['healthy', 'ejected', 'healthy']);
    return ctx;
  }

  it('keeps the target out until ejectionMs has passed, then probes with exactly one request', () => {
    const { set, advance, states } = ejectT1();
    advance(999);
    expect(states()[1]).toBe('ejected');
    advance(1);
    expect(states()[1]).toBe('probing');
    // The next rotation reaches t1 and takes the single probe; a second concurrent pick must avoid it.
    const probes: string[] = [];
    const held = Array.from({ length: 4 }, () => {
      const lease = set.acquire();
      probes.push(lease.id);
      return lease;
    });
    expect(probes.filter((id) => id === 't1')).toHaveLength(1);
    for (const lease of held) lease.settle('neutral');
  });

  it('a successful probe makes the target healthy again', () => {
    const { set, advance, states, changes } = ejectT1();
    advance(1000);
    let probe;
    for (let i = 0; i < 3 && probe === undefined; i++) {
      const lease = set.acquire();
      if (lease.id === 't1') probe = lease;
      else lease.settle('success');
    }
    probe?.settle('success');
    expect(states()).toEqual(['healthy', 'healthy', 'healthy']);
    expect(changes.slice(-2)).toEqual(['t1:ejected->probing', 't1:probing->healthy']);
  });

  it('a failed probe ejects again for a full period', () => {
    const { set, advance, states, changes } = ejectT1();
    advance(1000);
    let probe;
    for (let i = 0; i < 3 && probe === undefined; i++) {
      const lease = set.acquire();
      if (lease.id === 't1') probe = lease;
      else lease.settle('success');
    }
    probe?.settle('failure');
    expect(states()[1]).toBe('ejected');
    advance(999);
    expect(states()[1]).toBe('ejected');
    advance(1);
    expect(states()[1]).toBe('probing');
    expect(changes.filter((c) => c.startsWith('t1:'))).toEqual([
      't1:healthy->ejected',
      't1:ejected->probing',
      't1:probing->ejected',
      't1:ejected->probing',
    ]);
  });

  it('a probe that ends neutral frees the probe slot without deciding anything', () => {
    const { set, advance, states } = ejectT1();
    advance(1000);
    let probe;
    for (let i = 0; i < 3 && probe === undefined; i++) {
      const lease = set.acquire();
      if (lease.id === 't1') probe = lease;
      else lease.settle('success');
    }
    probe?.settle('neutral');
    expect(states()[1]).toBe('probing');
    const next = Array.from({ length: 3 }, () => set.acquire());
    expect(next.map((l) => l.id)).toContain('t1');
    for (const lease of next) lease.settle('neutral');
  });
});

describe('TargetSet when nothing can serve normally (ADR-0051)', () => {
  /** t0 probing with its probe busy, t1 just ejected: no target may take traffic the normal way. */
  function stuck() {
    const ctx = make(2, { consecutiveFailures: 1, ejectionMs: 1000, maxEjectedPercent: 100 });
    ctx.set.acquire().settle('failure'); // t0 ejected at 0 (t1 stays: never the last one)
    ctx.advance(1000);
    const probe = ctx.set.acquire(1); // t0 is probing and takes the single probe
    expect(probe.id).toBe('t0');
    ctx.set.acquire(0).settle('failure'); // t1 fails too; t0 is only probing, so t1 may be ejected
    expect(ctx.states()).toEqual(['probing', 'ejected']);
    return { ...ctx, probe };
  }

  it('forces the target ejected longest ago instead of refusing to serve', () => {
    const { set, probe } = stuck();
    const forced = set.acquire();
    expect(forced).toMatchObject({ id: 't0', forced: true }); // ejected at 0, before t1 at 1000
    forced.settle('neutral');
    probe.settle('neutral');
  });

  it('a successful forced request makes the target healthy again', () => {
    const { set, states, probe } = stuck();
    set.acquire().settle('success');
    expect(states()[0]).toBe('healthy');
    probe.settle('neutral');
  });

  it('a forced pick avoids the excluded target when it can', () => {
    const { set, probe } = stuck();
    const forced = set.acquire(0);
    expect(forced).toMatchObject({ id: 't1', forced: true });
    forced.settle('neutral');
    probe.settle('neutral');
  });
});

describe('TargetSet reporting', () => {
  it('reports one state change per transition and a snapshot of every target', () => {
    const { set, changes, advance } = make(2, { consecutiveFailures: 1, ejectionMs: 500 });
    set.acquire().settle('failure');
    advance(500);
    const snapshot = set.snapshot();
    expect(snapshot.map((t) => [t.id, t.state, t.ejections])).toEqual([
      ['t0', 'probing', 1],
      ['t1', 'healthy', 0],
    ]);
    expect(changes).toEqual(['t0:healthy->ejected', 't0:ejected->probing']);
    expect(set.snapshot()[0]?.ejectedUntilMs).toBeUndefined();
  });

  it('exposes when an ejection ends', () => {
    const { set, advance } = make(2, { consecutiveFailures: 1, ejectionMs: 500 });
    advance(100);
    set.acquire().settle('failure');
    expect(set.snapshot()[0]?.ejectedUntilMs).toBe(600);
  });

  it('rejects an empty target list', () => {
    expect(
      () =>
        new TargetSet({
          ids: [],
          algorithm: 'round-robin',
          ejection: { consecutiveFailures: 1, ejectionMs: 1, maxEjectedPercent: 50 },
        }),
    ).toThrow('at least one target');
  });
});

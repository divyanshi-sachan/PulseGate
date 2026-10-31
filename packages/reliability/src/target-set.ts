/**
 * Target selection and passive outlier ejection for one upstream with several interchangeable targets (ADR-0051).
 *
 * - **Selection:** round-robin or least-connections over targets that may take traffic, optionally excluding the
 *   target that just failed (so a retry lands elsewhere).
 * - **Passive ejection:** `consecutiveFailures` failed attempts in a row eject a target for `ejectionMs`. Never more
 *   than `maxEjectedPercent` of the targets, and never the last one that isn't ejected.
 * - **Re-admission:** when the ejection time is over, a target is `probing`: exactly one request at a time may use it.
 *   A success makes it healthy again; a failure ejects it again for a full `ejectionMs`.
 * - **All ejected:** the target ejected longest ago is used anyway (a forced probe), instead of refusing every request.
 *   The service-level circuit breaker (ADR-0024) decides when the whole upstream is unusable.
 *
 * Pure and deterministic: time comes from the injected clock. All state is bounded by the target count.
 */
export type LoadBalancing = 'round-robin' | 'least-connections';

export type TargetState = 'healthy' | 'ejected' | 'probing';

export interface TargetSetOptions {
  /** Stable ids in configuration order (`t0`, `t1`, ...). */
  ids: readonly string[];
  algorithm: LoadBalancing;
  ejection: {
    consecutiveFailures: number;
    ejectionMs: number;
    maxEjectedPercent: number;
  };
  /** Monotonic milliseconds (default `performance.now`). */
  now?: () => number;
  onStateChange?: (change: { id: string; from: TargetState; to: TargetState }) => void;
}

/** What an attempt turned out to be, for ejection accounting. */
export type AttemptOutcome = 'success' | 'failure' | 'neutral';

export interface TargetLease {
  index: number;
  id: string;
  /** True when every target was ejected and this one was chosen anyway. */
  forced: boolean;
  /**
   * Ends the attempt, exactly once (later calls are ignored). `neutral` (client left, gateway-decided 4xx) counts
   * neither way: it only frees the in-flight slot and a probe.
   */
  settle: (outcome: AttemptOutcome) => void;
}

export interface TargetSnapshot {
  id: string;
  state: TargetState;
  inFlight: number;
  consecutiveFailures: number;
  /** Monotonic time the ejection ends, or undefined when not ejected. */
  ejectedUntilMs: number | undefined;
  ejections: number;
}

interface Target {
  id: string;
  state: TargetState;
  inFlight: number;
  consecutiveFailures: number;
  ejectedAtMs: number;
  ejectedUntilMs: number;
  probeInFlight: boolean;
  ejections: number;
}

export class TargetSet {
  readonly #targets: Target[];
  readonly #algorithm: LoadBalancing;
  readonly #ejection: TargetSetOptions['ejection'];
  readonly #now: () => number;
  readonly #onStateChange: TargetSetOptions['onStateChange'];
  #cursor = 0;

  constructor(options: TargetSetOptions) {
    if (options.ids.length === 0) throw new Error('A target set needs at least one target');
    this.#algorithm = options.algorithm;
    this.#ejection = options.ejection;
    this.#now = options.now ?? (() => performance.now());
    this.#onStateChange = options.onStateChange;
    this.#targets = options.ids.map((id) => ({
      id,
      state: 'healthy',
      inFlight: 0,
      consecutiveFailures: 0,
      ejectedAtMs: 0,
      ejectedUntilMs: 0,
      probeInFlight: false,
      ejections: 0,
    }));
  }

  get size(): number {
    return this.#targets.length;
  }

  /** Picks a target and counts the attempt in flight. `excludeIndex` is avoided when another target can serve. */
  acquire(excludeIndex?: number): TargetLease {
    this.#readmitElapsed();
    const usable = this.#targets
      .map((target, index) => ({ target, index }))
      .filter(
        ({ target }) =>
          target.state === 'healthy' || (target.state === 'probing' && !target.probeInFlight),
      );
    const preferred = usable.filter(({ index }) => index !== excludeIndex);
    const candidates = preferred.length > 0 ? preferred : usable;

    let chosen: { target: Target; index: number } | undefined;
    let forced = false;
    if (candidates.length > 0) {
      chosen = this.#choose(candidates);
    } else {
      // Everything is ejected (or probing with the probe busy): use the one ejected longest ago.
      forced = true;
      const pool = this.#targets
        .map((target, index) => ({ target, index }))
        .filter(({ index }) => index !== excludeIndex || this.#targets.length === 1);
      const [first, ...rest] = pool;
      if (first === undefined) throw new Error('Invariant: a target set is never empty');
      chosen = rest.reduce(
        (best, entry) => (entry.target.ejectedAtMs < best.target.ejectedAtMs ? entry : best),
        first,
      );
    }

    const { target, index } = chosen;
    target.inFlight++;
    const isProbe = target.state === 'probing' && !target.probeInFlight;
    if (isProbe) target.probeInFlight = true;
    let settled = false;
    return {
      index,
      id: target.id,
      forced,
      settle: (outcome) => {
        if (settled) return;
        settled = true;
        target.inFlight = Math.max(0, target.inFlight - 1);
        if (isProbe) target.probeInFlight = false;
        this.#record(target, outcome);
      },
    };
  }

  snapshot(): TargetSnapshot[] {
    this.#readmitElapsed();
    return this.#targets.map((target) => ({
      id: target.id,
      state: target.state,
      inFlight: target.inFlight,
      consecutiveFailures: target.consecutiveFailures,
      ejectedUntilMs: target.state === 'ejected' ? target.ejectedUntilMs : undefined,
      ejections: target.ejections,
    }));
  }

  #choose(candidates: { target: Target; index: number }[]): { target: Target; index: number } {
    const n = this.#targets.length;
    // Candidates in rotation order starting at the cursor, so ties and round-robin both walk the ring.
    const ordered = [...candidates].sort(
      (a, b) => ((a.index - this.#cursor + n) % n) - ((b.index - this.#cursor + n) % n),
    );
    const pick =
      this.#algorithm === 'least-connections'
        ? ordered.reduce((best, entry) =>
            entry.target.inFlight < best.target.inFlight ? entry : best,
          )
        : (ordered[0] as { target: Target; index: number });
    this.#cursor = (pick.index + 1) % n;
    return pick;
  }

  /** Ejected targets whose time is over become probing (checked lazily, so no timers are needed). */
  #readmitElapsed(): void {
    const now = this.#now();
    for (const target of this.#targets) {
      if (target.state === 'ejected' && now >= target.ejectedUntilMs)
        this.#transition(target, 'probing');
    }
  }

  #record(target: Target, outcome: AttemptOutcome): void {
    if (outcome === 'neutral') return;
    if (outcome === 'success') {
      target.consecutiveFailures = 0;
      if (target.state !== 'healthy') this.#transition(target, 'healthy');
      return;
    }
    target.consecutiveFailures++;
    if (target.state === 'probing' || target.state === 'ejected') {
      // A failed probe (or a failed forced request) ejects again for a full period.
      this.#eject(target);
    } else if (target.consecutiveFailures >= this.#ejection.consecutiveFailures) {
      this.#eject(target);
    }
  }

  #eject(target: Target): void {
    if (target.state === 'healthy' && !this.#mayEject()) return;
    const now = this.#now();
    target.ejectedAtMs = now;
    target.ejectedUntilMs = now + this.#ejection.ejectionMs;
    target.ejections++;
    if (target.state !== 'ejected') this.#transition(target, 'ejected');
  }

  /** At most maxEjectedPercent of the targets, and never the last one that isn't ejected. */
  #mayEject(): boolean {
    const total = this.#targets.length;
    const ejected = this.#targets.filter((t) => t.state === 'ejected').length;
    const limit = Math.floor((total * this.#ejection.maxEjectedPercent) / 100);
    return ejected < limit && ejected < total - 1;
  }

  #transition(target: Target, to: TargetState): void {
    const from = target.state;
    target.state = to;
    if (to === 'healthy') target.consecutiveFailures = 0;
    this.#onStateChange?.({ id: target.id, from, to });
  }
}

/** Breaker states (Q3, ADR-0033). */
export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerSettings {
  failureThreshold: number;
  openDurationMs: number;
  halfOpenMaxRequests: number;
  halfOpenSuccessThreshold: number;
}

export interface BreakerTransition {
  from: BreakerState;
  to: BreakerState;
  /** Consecutive failures (closed→open) or the probe outcome that caused the change. */
  reason: 'failure-threshold' | 'open-period-elapsed' | 'probe-succeeded' | 'probe-failed';
}

export interface CircuitBreakerOptions {
  /** Monotonic milliseconds (default `performance.now`). */
  now?: () => number;
  onTransition?: (transition: BreakerTransition) => void;
}

/** One attempt's right to call the upstream. Settles exactly once; later calls are ignored. */
export interface BreakerPermit {
  success(): void;
  failure(): void;
  /** Neither success nor failure (e.g. client disconnect, ADR-0024); frees a half-open slot. */
  release(): void;
}

export type AcquireResult =
  { allowed: true; permit: BreakerPermit } | { allowed: false; retryAfterMs: number };

export interface BreakerSnapshot {
  state: BreakerState;
  consecutiveFailures: number;
  halfOpenInFlight: number;
  halfOpenSuccesses: number;
}

/**
 * Circuit breaker for one upstream (State pattern, ADR-0008, ADR-0024, ADR-0033). Every state change goes
 * through `#transition`, so each one is observable and tested.
 */
export class CircuitBreaker {
  readonly #settings: CircuitBreakerSettings;
  readonly #now: () => number;
  readonly #onTransition: ((transition: BreakerTransition) => void) | undefined;
  #state: BreakerState = 'closed';
  #consecutiveFailures = 0;
  #openedAtMs = 0;
  #halfOpenInFlight = 0;
  #halfOpenSuccesses = 0;
  /** Bumped on every transition so permits from an earlier state can't affect the current one. */
  #generation = 0;

  constructor(settings: CircuitBreakerSettings, options: CircuitBreakerOptions = {}) {
    this.#settings = settings;
    this.#now = options.now ?? (() => performance.now());
    this.#onTransition = options.onTransition;
  }

  get state(): BreakerState {
    return this.#state;
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.#state,
      consecutiveFailures: this.#consecutiveFailures,
      halfOpenInFlight: this.#halfOpenInFlight,
      halfOpenSuccesses: this.#halfOpenSuccesses,
    };
  }

  tryAcquire(): AcquireResult {
    if (this.#state === 'open') {
      const remaining = this.#openedAtMs + this.#settings.openDurationMs - this.#now();
      if (remaining > 0) return { allowed: false, retryAfterMs: remaining };
      this.#transition('half-open', 'open-period-elapsed');
    }
    if (this.#state === 'half-open') {
      if (this.#halfOpenInFlight >= this.#settings.halfOpenMaxRequests) {
        // Probes are in flight; the outcome is unknown, so suggest waiting one open period at most.
        return { allowed: false, retryAfterMs: this.#settings.openDurationMs };
      }
      this.#halfOpenInFlight++;
      return { allowed: true, permit: this.#permit(this.#generation, true) };
    }
    return { allowed: true, permit: this.#permit(this.#generation, false) };
  }

  #permit(generation: number, probe: boolean): BreakerPermit {
    let settled = false;
    const settle = (outcome: 'success' | 'failure' | 'release'): void => {
      if (settled) return;
      settled = true;
      // A permit issued before the last transition (e.g. while closed, finishing after the breaker
      // opened) is ignored: the state it would have affected no longer exists.
      if (generation !== this.#generation) return;
      if (probe) this.#settleProbe(outcome);
      else this.#settleClosed(outcome);
    };
    return {
      success: () => {
        settle('success');
      },
      failure: () => {
        settle('failure');
      },
      release: () => {
        settle('release');
      },
    };
  }

  #settleClosed(outcome: 'success' | 'failure' | 'release'): void {
    if (outcome === 'success') this.#consecutiveFailures = 0;
    if (outcome !== 'failure') return;
    this.#consecutiveFailures++;
    if (this.#consecutiveFailures >= this.#settings.failureThreshold) {
      this.#transition('open', 'failure-threshold');
    }
  }

  #settleProbe(outcome: 'success' | 'failure' | 'release'): void {
    this.#halfOpenInFlight--;
    if (outcome === 'failure') {
      this.#transition('open', 'probe-failed');
      return;
    }
    if (outcome === 'success') {
      this.#halfOpenSuccesses++;
      if (this.#halfOpenSuccesses >= this.#settings.halfOpenSuccessThreshold) {
        this.#transition('closed', 'probe-succeeded');
      }
    }
  }

  #transition(to: BreakerState, reason: BreakerTransition['reason']): void {
    const from = this.#state;
    this.#state = to;
    this.#generation++;
    this.#consecutiveFailures = 0;
    this.#halfOpenInFlight = 0;
    this.#halfOpenSuccesses = 0;
    if (to === 'open') this.#openedAtMs = this.#now();
    this.#onTransition?.({ from, to, reason });
  }
}

/** One breaker per upstream id, created from resolved settings (ADR-0008, ADR-0015). */
export class CircuitBreakerRegistry {
  readonly #breakers = new Map<string, CircuitBreaker>();

  constructor(
    upstreams: readonly { id: string; circuitBreaker: CircuitBreakerSettings }[],
    options: {
      now?: () => number;
      onTransition?: (upstreamId: string, transition: BreakerTransition) => void;
    } = {},
  ) {
    for (const upstream of upstreams) {
      this.#breakers.set(
        upstream.id,
        new CircuitBreaker(upstream.circuitBreaker, {
          ...(options.now === undefined ? {} : { now: options.now }),
          onTransition: (transition) => options.onTransition?.(upstream.id, transition),
        }),
      );
    }
  }

  get(upstreamId: string): CircuitBreaker {
    const breaker = this.#breakers.get(upstreamId);
    if (breaker === undefined) throw new Error(`No circuit breaker for upstream "${upstreamId}"`);
    return breaker;
  }

  snapshot(): Record<string, BreakerSnapshot> {
    return Object.fromEntries([...this.#breakers].map(([id, breaker]) => [id, breaker.snapshot()]));
  }
}

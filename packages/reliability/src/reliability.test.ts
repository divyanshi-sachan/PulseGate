import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  CircuitBreaker,
  CircuitBreakerRegistry,
  isRetryEligible,
  type BreakerPermit,
  type BreakerTransition,
  type CircuitBreakerSettings,
} from './index.ts';

const settings: CircuitBreakerSettings = {
  failureThreshold: 3,
  openDurationMs: 1000,
  halfOpenMaxRequests: 2,
  halfOpenSuccessThreshold: 2,
};

function setup(overrides: Partial<CircuitBreakerSettings> = {}) {
  let now = 0;
  const transitions: BreakerTransition[] = [];
  const breaker = new CircuitBreaker(
    { ...settings, ...overrides },
    { now: () => now, onTransition: (t) => transitions.push(t) },
  );
  const acquire = (): BreakerPermit => {
    const result = breaker.tryAcquire();
    if (!result.allowed) throw new Error('expected a permit');
    return result.permit;
  };
  const tripOpen = () => {
    for (let i = 0; i < 3; i++) acquire().failure();
  };
  return {
    breaker,
    transitions,
    acquire,
    tripOpen,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('CircuitBreaker (ADR-0024, ADR-0033)', () => {
  it('opens after failureThreshold consecutive failures; a success resets the count', () => {
    const { breaker, acquire, transitions } = setup();
    acquire().failure();
    acquire().failure();
    acquire().success();
    acquire().failure();
    acquire().failure();
    expect(breaker.state).toBe('closed');
    acquire().failure();
    expect(breaker.state).toBe('open');
    expect(transitions).toEqual([{ from: 'closed', to: 'open', reason: 'failure-threshold' }]);
  });

  it('rejects while open with the time left, then lets a probe through as half-open', () => {
    const { breaker, tripOpen, advance, transitions } = setup();
    tripOpen();
    advance(400);
    expect(breaker.tryAcquire()).toEqual({ allowed: false, retryAfterMs: 600 });
    advance(600);
    expect(breaker.tryAcquire().allowed).toBe(true);
    expect(breaker.state).toBe('half-open');
    expect(transitions.at(-1)).toEqual({
      from: 'open',
      to: 'half-open',
      reason: 'open-period-elapsed',
    });
  });

  it('limits concurrent half-open probes to halfOpenMaxRequests', () => {
    const { breaker, tripOpen, advance, acquire } = setup();
    tripOpen();
    advance(1000);
    acquire();
    acquire();
    expect(breaker.tryAcquire()).toEqual({ allowed: false, retryAfterMs: 1000 });
    expect(breaker.snapshot().halfOpenInFlight).toBe(2);
  });

  it('closes after halfOpenSuccessThreshold successful probes', () => {
    const { breaker, tripOpen, advance, acquire, transitions } = setup();
    tripOpen();
    advance(1000);
    acquire().success();
    expect(breaker.state).toBe('half-open');
    acquire().success();
    expect(breaker.state).toBe('closed');
    expect(transitions.at(-1)).toEqual({
      from: 'half-open',
      to: 'closed',
      reason: 'probe-succeeded',
    });
  });

  it('re-opens on any failed probe, starting a new open period', () => {
    const { breaker, tripOpen, advance, acquire, transitions } = setup();
    tripOpen();
    advance(1000);
    acquire().success();
    acquire().failure();
    expect(breaker.state).toBe('open');
    expect(transitions.at(-1)).toEqual({ from: 'half-open', to: 'open', reason: 'probe-failed' });
    advance(999);
    expect(breaker.tryAcquire().allowed).toBe(false);
  });

  it('a released probe (client abort) frees its slot without counting', () => {
    const { breaker, tripOpen, advance, acquire } = setup({ halfOpenMaxRequests: 1 });
    tripOpen();
    advance(1000);
    acquire().release();
    expect(breaker.state).toBe('half-open');
    expect(breaker.snapshot()).toMatchObject({ halfOpenInFlight: 0, halfOpenSuccesses: 0 });
    expect(breaker.tryAcquire().allowed).toBe(true);
  });

  it('settles each permit at most once', () => {
    const { breaker, acquire } = setup();
    const permit = acquire();
    permit.failure();
    permit.failure();
    permit.failure();
    expect(breaker.snapshot().consecutiveFailures).toBe(1);
  });

  it('ignores permits that outlive the state they were issued in', () => {
    const { breaker, acquire, tripOpen, advance } = setup();
    const lingering = acquire(); // issued while closed
    tripOpen();
    advance(1000);
    breaker.tryAcquire(); // now half-open with one probe in flight
    lingering.failure();
    expect(breaker.state).toBe('half-open');
    expect(breaker.snapshot().halfOpenInFlight).toBe(1);
  });

  it('keeps breakers isolated per upstream in the registry', () => {
    const registry = new CircuitBreakerRegistry([
      { id: 'orders', circuitBreaker: { ...settings, failureThreshold: 1 } },
      { id: 'payments', circuitBreaker: settings },
    ]);
    const result = registry.get('orders').tryAcquire();
    if (result.allowed) result.permit.failure();
    expect(registry.snapshot()['orders']?.state).toBe('open');
    expect(registry.snapshot()['payments']?.state).toBe('closed');
    expect(() => registry.get('missing')).toThrow(/No circuit breaker/);
  });
});

describe('retry policy (ADR-0007, ADR-0016, ADR-0033)', () => {
  const retries = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, retryableStatuses: [503] };

  it.each([
    ['GET', false, true],
    ['HEAD', false, true],
    ['OPTIONS', false, true],
    ['get', false, true],
    ['GET', true, false],
    ['POST', false, false],
    ['PUT', false, false],
    ['DELETE', false, false],
    ['PATCH', false, false],
  ] as const)('%s with body=%s is eligible: %s', (method, hasBody, expected) => {
    expect(isRetryEligible(method, hasBody, retries)).toBe(expected);
  });

  it('never retries when maxAttempts is 1', () => {
    expect(isRetryEligible('GET', false, { ...retries, maxAttempts: 1 })).toBe(false);
  });

  it('uses full jitter under an exponentially growing, capped ceiling', () => {
    expect([1, 2, 3, 4, 5].map((retry) => backoffDelayMs(retry, retries, () => 0.999999))).toEqual([
      99, 199, 399, 799, 999,
    ]);
    expect(backoffDelayMs(3, retries, () => 0)).toBe(0);
    expect(backoffDelayMs(2, retries, () => 0.5)).toBe(100);
  });
});

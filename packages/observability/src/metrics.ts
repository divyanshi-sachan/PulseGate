import { GATEWAY_ERRORS } from '@pulsegate/shared';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export type BreakerStateName = 'closed' | 'open' | 'half-open';
const BREAKER_STATES: readonly BreakerStateName[] = ['closed', 'open', 'half-open'];

/** Codes beyond the error registry that may appear as the `code` label. */
const EXTRA_CODES = ['none', 'CLIENT_ABORTED'] as const;

export interface MetricsOptions {
  /** Configured route ids; anything else is recorded as "unmatched". */
  routes: readonly string[];
  /** Configured upstream ids; anything else is recorded as "unknown". */
  upstreams: readonly string[];
  /** Read on every scrape for the cache gauges. */
  cacheStats?: () => { entries: number; bytes: number };
  /** Process metrics (CPU, memory, event loop); off in tests that compare exact output. */
  defaultMetrics?: boolean;
}

/**
 * Gateway metrics (ADR-0036, tech_impl §11). Every label value is mapped onto a bounded set: route and
 * upstream ids from config, error codes from the registry, fixed enums. Never paths, ids, clients or IPs.
 */
export class GatewayMetrics {
  readonly registry = new Registry();
  readonly #routes: ReadonlySet<string>;
  readonly #upstreams: ReadonlySet<string>;
  readonly #codes: ReadonlySet<string>;

  readonly #requests: Counter<'route' | 'status_class' | 'code'>;
  readonly #requestDuration: Histogram<'route'>;
  readonly #active: Gauge;
  readonly #upstreamRequests: Counter<'upstream' | 'outcome'>;
  readonly #upstreamDuration: Histogram<'upstream'>;
  readonly #retries: Counter<'route'>;
  readonly #rateLimit: Counter<'route' | 'decision' | 'mode'>;
  readonly #limiterUnavailable: Counter<'route'>;
  readonly #cacheRequests: Counter<'route' | 'result'>;
  readonly #cacheStores: Counter<'route' | 'result'>;
  readonly #cacheEvictions: Counter<'reason'>;
  readonly #breakerTransitions: Counter<'upstream' | 'from' | 'to'>;
  readonly #breakerState: Gauge<'upstream' | 'state'>;

  constructor(options: MetricsOptions) {
    this.#routes = new Set(options.routes);
    this.#upstreams = new Set(options.upstreams);
    this.#codes = new Set([...Object.keys(GATEWAY_ERRORS), ...EXTRA_CODES]);
    const registers = [this.registry];
    if (options.defaultMetrics !== false) {
      collectDefaultMetrics({ register: this.registry, prefix: 'pulsegate_' });
    }

    this.#requests = new Counter({
      name: 'pulsegate_requests_total',
      help: 'Client requests completed, by route, status class and gateway error code.',
      labelNames: ['route', 'status_class', 'code'],
      registers,
    });
    this.#requestDuration = new Histogram({
      name: 'pulsegate_request_duration_seconds',
      help: 'Time from request receipt to response completion.',
      labelNames: ['route'],
      registers,
    });
    this.#active = new Gauge({
      name: 'pulsegate_active_requests',
      help: 'Requests currently in progress.',
      registers,
    });
    this.#upstreamRequests = new Counter({
      name: 'pulsegate_upstream_requests_total',
      help: 'Upstream attempts (including retries) by breaker outcome.',
      labelNames: ['upstream', 'outcome'],
      registers,
    });
    this.#upstreamDuration = new Histogram({
      name: 'pulsegate_upstream_duration_seconds',
      help: 'Upstream attempt duration, including the response body.',
      labelNames: ['upstream'],
      registers,
    });
    this.#retries = new Counter({
      name: 'pulsegate_retries_total',
      help: 'Upstream attempts beyond the first.',
      labelNames: ['route'],
      registers,
    });
    this.#rateLimit = new Counter({
      name: 'pulsegate_rate_limit_decisions_total',
      help: 'Rate-limit decisions by result and backend mode.',
      labelNames: ['route', 'decision', 'mode'],
      registers,
    });
    this.#limiterUnavailable = new Counter({
      name: 'pulsegate_rate_limiter_unavailable_total',
      help: 'Requests rejected because the shared rate limiter was unavailable (fail-closed).',
      labelNames: ['route'],
      registers,
    });
    this.#cacheRequests = new Counter({
      name: 'pulsegate_cache_requests_total',
      help: 'Cache lookups on cache-enabled routes.',
      labelNames: ['route', 'result'],
      registers,
    });
    this.#cacheStores = new Counter({
      name: 'pulsegate_cache_stores_total',
      help: 'What happened to cache misses: stored, not storable, too large.',
      labelNames: ['route', 'result'],
      registers,
    });
    this.#cacheEvictions = new Counter({
      name: 'pulsegate_cache_evictions_total',
      help: 'Cache entries removed for capacity or expiry.',
      labelNames: ['reason'],
      registers,
    });
    const cacheStats = options.cacheStats;
    new Gauge({
      name: 'pulsegate_cache_entries',
      help: 'Entries currently in the response cache.',
      registers,
      collect() {
        if (cacheStats !== undefined) this.set(cacheStats().entries);
      },
    });
    new Gauge({
      name: 'pulsegate_cache_bytes',
      help: 'Approximate bytes held by the response cache.',
      registers,
      collect() {
        if (cacheStats !== undefined) this.set(cacheStats().bytes);
      },
    });
    this.#breakerTransitions = new Counter({
      name: 'pulsegate_circuit_breaker_transitions_total',
      help: 'Circuit-breaker state changes.',
      labelNames: ['upstream', 'from', 'to'],
      registers,
    });
    this.#breakerState = new Gauge({
      name: 'pulsegate_circuit_breaker_state',
      help: 'Current breaker state per upstream (1 for the current state, else 0).',
      labelNames: ['upstream', 'state'],
      registers,
    });
    for (const upstream of options.upstreams) this.#setBreakerState(upstream, 'closed');
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  text(): Promise<string> {
    return this.registry.metrics();
  }

  #route(id: string | undefined): string {
    return id !== undefined && this.#routes.has(id) ? id : 'unmatched';
  }

  #upstream(id: string): string {
    return this.#upstreams.has(id) ? id : 'unknown';
  }

  /** Returns a function that ends the in-flight count; safe to call more than once. */
  requestStarted(): () => void {
    this.#active.inc();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#active.dec();
    };
  }

  requestCompleted(input: {
    routeId: string | undefined;
    statusCode: number;
    code: string | undefined;
    durationSeconds: number;
  }): void {
    const route = this.#route(input.routeId);
    const klass = Math.floor(input.statusCode / 100);
    const code = input.code ?? 'none';
    this.#requests.inc({
      route,
      status_class: klass >= 1 && klass <= 5 ? `${String(klass)}xx` : 'unknown',
      code: this.#codes.has(code) ? code : 'other',
    });
    this.#requestDuration.observe({ route }, input.durationSeconds);
  }

  upstreamAttempt(
    upstreamId: string,
    outcome: 'success' | 'failure' | 'aborted',
    seconds: number,
  ): void {
    const upstream = this.#upstream(upstreamId);
    this.#upstreamRequests.inc({ upstream, outcome });
    this.#upstreamDuration.observe({ upstream }, seconds);
  }

  retries(routeId: string | undefined, count: number): void {
    if (count > 0) this.#retries.inc({ route: this.#route(routeId) }, count);
  }

  rateLimitDecision(routeId: string, allowed: boolean, mode: 'local' | 'redis' | 'degraded'): void {
    this.#rateLimit.inc({
      route: this.#route(routeId),
      decision: allowed ? 'allowed' : 'rejected',
      mode,
    });
  }

  rateLimiterUnavailable(routeId: string): void {
    this.#limiterUnavailable.inc({ route: this.#route(routeId) });
  }

  cacheLookup(routeId: string, result: 'hit' | 'miss' | 'bypass'): void {
    this.#cacheRequests.inc({ route: this.#route(routeId), result });
  }

  cacheStore(routeId: string, result: 'stored' | 'not_storable' | 'too_large'): void {
    this.#cacheStores.inc({ route: this.#route(routeId), result });
  }

  cacheEviction(reason: 'capacity' | 'expired'): void {
    this.#cacheEvictions.inc({ reason });
  }

  breakerTransition(upstreamId: string, from: BreakerStateName, to: BreakerStateName): void {
    const upstream = this.#upstream(upstreamId);
    this.#breakerTransitions.inc({ upstream, from, to });
    this.#setBreakerState(upstream, to);
  }

  #setBreakerState(upstream: string, current: BreakerStateName): void {
    for (const state of BREAKER_STATES) {
      this.#breakerState.set({ upstream, state }, state === current ? 1 : 0);
    }
  }
}

import { z } from 'zod';
import { COUNTED_CODES } from './constants.ts';

/**
 * Admin API contracts (plan §5.1). The gateway validates its responses against these in tests; the
 * dashboard validates every response it receives. Rates and percentiles are defined in plan §2.1/§2.3.
 */

const count = z.int().min(0);
/** A ratio in [0, 1], or null when its denominator is 0 (never a fabricated 0). */
const rate = z.number().min(0).max(1).nullable();

export const percentileSchema = z.strictObject({
  value: z.number().min(0).nullable(),
  method: z.enum(['exact', 'sampled']),
  observations: count,
  /** Retained samples (bucket) or effective sample size, rounded down (window). */
  samples: count,
  tailSamples: count,
  confidence: z.enum(['none', 'low', 'ok']),
});

export const latencySchema = z.strictObject({
  p50: percentileSchema,
  p95: percentileSchema,
  p99: percentileSchema,
});

const statusSchema = z.strictObject({
  '1xx': count,
  '2xx': count,
  '3xx': count,
  '4xx': count,
  '5xx': count,
});
const codesSchema = z.strictObject(Object.fromEntries(COUNTED_CODES.map((code) => [code, count])));
const attemptsSchema = z.strictObject({ success: count, failure: count, aborted: count });

export const routeCountersSchema = z.strictObject({
  requests: count,
  aborted: count,
  status: statusSchema,
  codes: codesSchema,
  rl: z.strictObject({ allowed: count, rejected: count, degraded: count }),
  rlUnavailable: count,
  cache: z.strictObject({ hit: count, miss: count, bypass: count }),
  store: z.strictObject({ stored: count, notStorable: count, tooLarge: count }),
  attempts: attemptsSchema,
  retries: count,
});

export const routeRatesSchema = z.strictObject({
  rps: z.number().min(0).nullable(),
  successRate: rate,
  clientErrorRate: rate,
  errorRate: rate,
  abortRate: rate,
  rateLimitRejectionRate: rate,
  rateLimiterUnavailableRate: rate,
  cacheHitRatio: rate,
  cacheBypassRate: rate,
  cacheStoreRate: rate,
  upstreamFailureRate: rate,
  retryRate: rate,
});

export const upstreamCountersSchema = z.strictObject({ attempts: attemptsSchema, retries: count });
export const upstreamRatesSchema = z.strictObject({
  attemptsPerSecond: z.number().min(0).nullable(),
  upstreamFailureRate: rate,
});

/** One 10 s bucket (or the whole window) of a time series. */
function slice<C extends z.ZodType, R extends z.ZodType>(counters: C, rates: R) {
  return z.strictObject({
    start: z.number(),
    durationMs: z.number().min(0),
    partial: z.boolean(),
    counters,
    rates,
    latency: latencySchema,
  });
}

function timeSeries<C extends z.ZodType, R extends z.ZodType>(counters: C, rates: R) {
  return z.strictObject({
    window: slice(counters, rates),
    buckets: z.array(slice(counters, rates)).max(30),
  });
}

export const routeSeriesSchema = timeSeries(routeCountersSchema, routeRatesSchema);
export const upstreamSeriesSchema = timeSeries(upstreamCountersSchema, upstreamRatesSchema);

export const envelopeSchema = z.strictObject({
  instance: z.strictObject({ id: z.string().min(1), startedAt: z.number() }),
  generatedAt: z.number(),
  window: z.strictObject({
    seconds: z.literal(300),
    bucketSeconds: z.literal(10),
    collectingSince: z.number(),
  }),
});

const routeId = z.string().min(1).max(64);

export const statsResponseSchema = z.strictObject({
  ...envelopeSchema.shape,
  total: routeSeriesSchema,
  routes: z.array(z.strictObject({ id: routeId, series: routeSeriesSchema })),
});

export const breakerSchema = z.strictObject({
  state: z.enum(['closed', 'open', 'half-open']),
  consecutiveFailures: count,
  halfOpenInFlight: count,
  settings: z.strictObject({
    failureThreshold: count,
    openDurationMs: count,
    halfOpenMaxRequests: count,
    halfOpenSuccessThreshold: count,
    failureStatuses: z.array(z.int()),
  }),
});

export const upstreamsResponseSchema = z.strictObject({
  ...envelopeSchema.shape,
  upstreams: z.array(
    z.strictObject({
      id: routeId,
      baseUrl: z.string(),
      breaker: breakerSchema,
      series: upstreamSeriesSchema,
    }),
  ),
});

export const routesResponseSchema = z.strictObject({
  ...envelopeSchema.shape,
  routes: z.array(
    z.strictObject({
      id: routeId,
      pathPrefix: z.string(),
      methods: z.array(z.string()),
      upstreamId: routeId,
      stripPrefix: z.boolean(),
      authRequired: z.boolean(),
      rateLimit: z.strictObject({ capacity: count, refillRatePerSecond: z.number().positive() }),
      timeoutMs: count,
      attemptTimeoutMs: count.nullable(),
      retries: z.strictObject({
        maxAttempts: count,
        baseDelayMs: count,
        maxDelayMs: count,
        retryableStatuses: z.array(z.int()),
      }),
      cache: z.strictObject({
        enabled: z.boolean(),
        ttlSeconds: count.nullable(),
        scope: z.enum(['client', 'shared']).nullable(),
        varyHeaders: z.array(z.string()),
        maxResponseBytes: count.nullable(),
      }),
      forwarding: z.strictObject({ authorization: z.boolean(), forwardedHost: z.boolean() }),
    }),
  ),
});

export const rateLimitsResponseSchema = z.strictObject({
  ...envelopeSchema.shape,
  mode: z.enum(['local', 'redis']),
  redisFailurePolicy: z.enum(['open', 'closed']).nullable(),
  backend: z.strictObject({
    kind: z.enum(['local', 'redis']),
    healthy: z.boolean(),
    /** host:port only, never a URL or credentials (ADR-0034). */
    target: z
      .string()
      .regex(/^[^/@\s]+$/)
      .nullable(),
    degraded: z.boolean(),
  }),
  maxBuckets: count,
  routes: z.array(
    z.strictObject({
      id: routeId,
      policy: z.strictObject({ capacity: count, refillRatePerSecond: z.number().positive() }),
      series: routeSeriesSchema,
    }),
  ),
});

export const cacheResponseSchema = z.strictObject({
  ...envelopeSchema.shape,
  limits: z.strictObject({ maxEntries: count, maxBytes: count }),
  usage: z.strictObject({ entries: count, bytes: count }),
  evictions: z.strictObject({
    lifetime: z.strictObject({ capacity: count, expired: count }),
  }),
  routes: z.array(
    z.strictObject({
      id: routeId,
      scope: z.enum(['client', 'shared']),
      ttlSeconds: count,
      series: routeSeriesSchema,
    }),
  ),
});

export type Percentile = z.infer<typeof percentileSchema>;
export type Latency = z.infer<typeof latencySchema>;
export type RouteCounters = z.infer<typeof routeCountersSchema>;
export type RouteRates = z.infer<typeof routeRatesSchema>;
export type UpstreamCounters = z.infer<typeof upstreamCountersSchema>;
export type UpstreamRates = z.infer<typeof upstreamRatesSchema>;
export type RouteSeries = z.infer<typeof routeSeriesSchema>;
export type UpstreamSeries = z.infer<typeof upstreamSeriesSchema>;
export type RouteSlice = RouteSeries['window'];
export type UpstreamSlice = UpstreamSeries['window'];
export type Envelope = z.infer<typeof envelopeSchema>;
export type StatsResponse = z.infer<typeof statsResponseSchema>;
export type UpstreamsResponse = z.infer<typeof upstreamsResponseSchema>;
export type RoutesResponse = z.infer<typeof routesResponseSchema>;
export type RateLimitsResponse = z.infer<typeof rateLimitsResponseSchema>;
export type CacheResponse = z.infer<typeof cacheResponseSchema>;

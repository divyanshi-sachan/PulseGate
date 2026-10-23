import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * Gateway configuration schema (ADR-0003). Zod is the runtime source of truth; the
 * TypeScript types below are inferred from it. Defaults are listed in ADR-0026 and
 * config/routes.example.yaml.
 */

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

export const CIRCUIT_BREAKER_DEFAULTS = {
  failureThreshold: 5,
  openDurationMs: 10_000,
  halfOpenMaxRequests: 1,
  halfOpenSuccessThreshold: 1,
  failureStatuses: [500, 502, 503, 504],
} as const;

const port = z.int().min(1).max(65_535);
const positiveInt = z.int().min(1);
const identifier = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    'must be 1-64 characters: letters, digits, ".", "_" or "-", starting with a letter or digit',
  );

const hasNoDuplicates = (values: readonly unknown[]): boolean =>
  new Set(values).size === values.length;

// ---------------------------------------------------------------------------------------------
// Value validators
// ---------------------------------------------------------------------------------------------

const PATH_SEGMENT = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]+$/;

/** Returns a reason the prefix is invalid, or undefined (ADR-0017, ADR-0019). */
function pathPrefixProblem(prefix: string): string | undefined {
  if (prefix === '/') return undefined;
  if (!prefix.startsWith('/')) return 'must start with "/"';
  if (prefix.endsWith('/'))
    return 'must not end with "/" (write "/api/orders", not "/api/orders/")';
  for (const segment of prefix.slice(1).split('/')) {
    if (segment === '') return 'must not contain empty segments ("//")';
    if (segment === '.' || segment === '..') {
      return 'must not contain "." or ".." segments (ADR-0019)';
    }
    if (!PATH_SEGMENT.test(segment)) {
      return `segment "${segment}" may only contain unreserved URL characters; percent-encoding, "?" and "#" are not allowed`;
    }
  }
  return undefined;
}

const pathPrefix = z.string().superRefine((value, ctx) => {
  const problem = pathPrefixProblem(value);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
});

function isIpOrCidr(value: string): boolean {
  const parts = value.split('/');
  const [address, prefixLength] = parts;
  if (address === undefined || parts.length > 2) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefixLength === undefined) return true;
  if (!/^\d{1,3}$/.test(prefixLength)) return false;
  return Number(prefixLength) <= (family === 4 ? 32 : 128);
}

/**
 * Upstream base URL (ADR-0013, ADR-0019): http/https, host, optional port and path only.
 * The original value is never echoed in messages because it may contain credentials.
 */
const baseUrl = z.string().transform((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({
      code: 'custom',
      message: 'must be an absolute URL such as "http://orders:4001"',
    });
    return z.NEVER;
  }
  const problems: string[] = [];
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    problems.push(`protocol "${url.protocol}" is not allowed; use http or https (ADR-0013)`);
  }
  if (url.username !== '' || url.password !== '') {
    problems.push('must not contain credentials (user:pass@); supply secrets via env (ADR-0019)');
  }
  if (url.search !== '' || value.includes('?')) {
    problems.push('must not contain a query string (ADR-0019)');
  }
  if (url.hash !== '' || value.includes('#')) {
    problems.push('must not contain a fragment (ADR-0019)');
  }
  for (const message of problems) ctx.addIssue({ code: 'custom', message });
  if (problems.length > 0) return z.NEVER;

  const basePath = url.pathname.replace(/\/+$/, '');
  return { href: `${url.origin}${basePath}`, origin: url.origin, basePath };
});

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

const listener = (defaults: { host: string; port: number }) =>
  z
    .strictObject({
      host: z.string().min(1).default(defaults.host),
      port: port.default(defaults.port),
    })
    .prefault({});

const serverSchema = z
  .strictObject({
    host: z.string().min(1).default('0.0.0.0'),
    port: port.default(8080),
    trustedProxies: z
      .array(
        z
          .string()
          .refine(isIpOrCidr, 'must be an IP address or CIDR range, e.g. "10.0.0.0/8" (ADR-0021)'),
      )
      .default(() => []),
    limits: z
      .strictObject({
        maxRequestBodyBytes: positiveInt.default(1_048_576),
        maxResponseBodyBytes: positiveInt.default(10_485_760),
      })
      .prefault({}),
    /** Drain deadline on SIGTERM before remaining connections are force-closed (ADR-0030). */
    shutdownTimeoutMs: z.int().min(0).max(120_000).default(10_000),
  })
  .prefault({});

const rateLimitSchema = z
  .strictObject({
    mode: z.enum(['local', 'redis']).default('local'),
    redisFailurePolicy: z.enum(['open', 'closed']).optional(),
    /** Local mode: max in-memory buckets before LRU eviction (ADR-0032). */
    maxBuckets: positiveInt.max(10_000_000).default(100_000),
  })
  .transform((value, ctx) => {
    if (value.mode === 'local') return { mode: 'local' as const, maxBuckets: value.maxBuckets };
    if (value.redisFailurePolicy === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['redisFailurePolicy'],
        message:
          'is required when mode is "redis"; choose "open" (allow traffic) or "closed" (reject traffic) when Redis is unavailable (ADR-0005)',
      });
      return z.NEVER;
    }
    return {
      mode: 'redis' as const,
      redisFailurePolicy: value.redisFailurePolicy,
      maxBuckets: value.maxBuckets,
    };
  })
  .prefault({});

const failureStatuses = z
  .array(
    z
      .int()
      .refine(
        (status) => status >= 500 && status <= 599,
        'must be a 5xx status; 4xx never count as failures (ADR-0024)',
      ),
  )
  .min(1)
  .refine(hasNoDuplicates, 'must not contain duplicates');

const circuitBreakerSchema = z
  .strictObject({
    failureThreshold: positiveInt.default(CIRCUIT_BREAKER_DEFAULTS.failureThreshold),
    openDurationMs: positiveInt.default(CIRCUIT_BREAKER_DEFAULTS.openDurationMs),
    halfOpenMaxRequests: positiveInt.default(CIRCUIT_BREAKER_DEFAULTS.halfOpenMaxRequests),
    halfOpenSuccessThreshold: positiveInt.default(
      CIRCUIT_BREAKER_DEFAULTS.halfOpenSuccessThreshold,
    ),
    failureStatuses: failureStatuses.default(() => [...CIRCUIT_BREAKER_DEFAULTS.failureStatuses]),
  })
  .prefault({});

const circuitBreakerOverrideSchema = z.strictObject({
  failureThreshold: positiveInt.optional(),
  openDurationMs: positiveInt.optional(),
  halfOpenMaxRequests: positiveInt.optional(),
  halfOpenSuccessThreshold: positiveInt.optional(),
  failureStatuses: failureStatuses.optional(),
});

const upstreamSchema = z.strictObject({
  id: identifier,
  baseUrl,
  circuitBreaker: circuitBreakerOverrideSchema.optional(),
});

const retryableStatus = z
  .int()
  .refine(
    (status) => status === 408 || status === 429 || (status >= 500 && status <= 599),
    'must be 408, 429 or a 5xx status (ADR-0016)',
  );

const retriesSchema = z
  .strictObject({
    maxAttempts: z.int().min(1).max(10).default(1),
    baseDelayMs: z.int().min(0).max(60_000).default(50),
    maxDelayMs: z.int().min(0).max(60_000).default(1000),
    retryableStatuses: z
      .array(retryableStatus)
      .refine(hasNoDuplicates, 'must not contain duplicates')
      .default(() => [502, 503, 504]),
  })
  .refine((retries) => retries.maxDelayMs >= retries.baseDelayMs, {
    message: 'must be greater than or equal to baseDelayMs (ADR-0016)',
    path: ['maxDelayMs'],
  })
  .prefault({});

const cacheSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    ttlSeconds: z.int().min(1).max(86_400).optional(),
    maxResponseBytes: positiveInt.default(262_144),
  })
  .transform((cache, ctx) => {
    if (!cache.enabled) return { enabled: false as const };
    if (cache.ttlSeconds === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['ttlSeconds'],
        message: 'is required when cache.enabled is true',
      });
      return z.NEVER;
    }
    return {
      enabled: true as const,
      ttlSeconds: cache.ttlSeconds,
      maxResponseBytes: cache.maxResponseBytes,
    };
  })
  .prefault({});

const routeSchema = z.strictObject({
  id: identifier,
  pathPrefix,
  methods: z
    .array(z.enum(HTTP_METHODS))
    .min(1)
    .refine(hasNoDuplicates, 'must not contain duplicates'),
  upstreamId: identifier,
  stripPrefix: z.boolean().default(false),
  auth: z.strictObject({ required: z.boolean().default(true) }).prefault({}),
  rateLimit: z.strictObject({
    capacity: positiveInt,
    refillRatePerSecond: z.number().positive(),
  }),
  timeoutMs: z.int().min(1).max(300_000).default(3000),
  /** Optional per-attempt cut-off within timeoutMs; enables retrying hung attempts (ADR-0033). */
  attemptTimeoutMs: z.int().min(1).max(300_000).optional(),
  retries: retriesSchema,
  cache: cacheSchema,
  forwarding: z
    .strictObject({
      authorization: z.boolean().default(false),
      forwardedHost: z.boolean().default(false),
    })
    .prefault({}),
});

// ---------------------------------------------------------------------------------------------
// Whole config: cross-field rules and resolution
// ---------------------------------------------------------------------------------------------

const baseConfigSchema = z.strictObject({
  server: serverSchema,
  admin: listener({ host: '127.0.0.1', port: 9090 }),
  operations: listener({ host: '127.0.0.1', port: 9091 }),
  rateLimit: rateLimitSchema,
  circuitBreaker: circuitBreakerSchema,
  upstreams: z.array(upstreamSchema).min(1, 'must define at least one upstream'),
  routes: z.array(routeSchema).min(1, 'must define at least one route'),
});

type BaseConfig = z.output<typeof baseConfigSchema>;

function checkCrossFieldRules(config: BaseConfig, ctx: z.RefinementCtx): void {
  const upstreamIndex = new Map<string, number>();
  config.upstreams.forEach((upstream, i) => {
    const first = upstreamIndex.get(upstream.id);
    if (first === undefined) {
      upstreamIndex.set(upstream.id, i);
      return;
    }
    ctx.addIssue({
      code: 'custom',
      path: ['upstreams', i, 'id'],
      message: `duplicate upstream id "${upstream.id}" (first defined at upstreams[${String(first)}]) (ADR-0013)`,
    });
  });

  const routeIndex = new Map<string, number>();
  const prefixMethodOwner = new Map<string, number>();
  config.routes.forEach((route, i) => {
    const firstRoute = routeIndex.get(route.id);
    if (firstRoute === undefined) {
      routeIndex.set(route.id, i);
    } else {
      ctx.addIssue({
        code: 'custom',
        path: ['routes', i, 'id'],
        message: `duplicate route id "${route.id}" (first defined at routes[${String(firstRoute)}])`,
      });
    }

    if (!upstreamIndex.has(route.upstreamId)) {
      const known = [...upstreamIndex.keys()].map((id) => `"${id}"`).join(', ');
      ctx.addIssue({
        code: 'custom',
        path: ['routes', i, 'upstreamId'],
        message: `unknown upstream "${route.upstreamId}"; known upstreams: ${known} (ADR-0013)`,
      });
    }

    for (const method of route.methods) {
      const key = `${method} ${route.pathPrefix}`;
      const owner = prefixMethodOwner.get(key);
      if (owner === undefined) {
        prefixMethodOwner.set(key, i);
        continue;
      }
      const ownerId = config.routes[owner]?.id ?? '?';
      ctx.addIssue({
        code: 'custom',
        path: ['routes', i, 'methods'],
        message: `${key} is already handled by route "${ownerId}" (routes[${String(owner)}]); each pathPrefix + method pair must be unique (ADR-0017)`,
      });
    }
  });

  // Breaker settings must be coherent after merging defaults and overrides (ADR-0033).
  config.upstreams.forEach((upstream, i) => {
    const maxProbes =
      upstream.circuitBreaker?.halfOpenMaxRequests ?? config.circuitBreaker.halfOpenMaxRequests;
    const threshold =
      upstream.circuitBreaker?.halfOpenSuccessThreshold ??
      config.circuitBreaker.halfOpenSuccessThreshold;
    if (threshold <= maxProbes) return;
    ctx.addIssue({
      code: 'custom',
      path:
        upstream.circuitBreaker?.halfOpenSuccessThreshold === undefined
          ? ['circuitBreaker', 'halfOpenSuccessThreshold']
          : ['upstreams', i, 'circuitBreaker', 'halfOpenSuccessThreshold'],
      message: `${String(threshold)} exceeds halfOpenMaxRequests (${String(maxProbes)}) for upstream "${upstream.id}"; the breaker could never close (ADR-0033)`,
    });
  });

  config.routes.forEach((route, i) => {
    if (route.attemptTimeoutMs === undefined || route.attemptTimeoutMs <= route.timeoutMs) return;
    ctx.addIssue({
      code: 'custom',
      path: ['routes', i, 'attemptTimeoutMs'],
      message: `must not exceed timeoutMs (${String(route.timeoutMs)}); the overall deadline always wins (ADR-0033)`,
    });
  });

  const listeners = [
    { path: ['server', 'port'], name: 'server.port', port: config.server.port },
    { path: ['admin', 'port'], name: 'admin.port', port: config.admin.port },
    { path: ['operations', 'port'], name: 'operations.port', port: config.operations.port },
  ];
  listeners.forEach((current, i) => {
    const earlier = listeners.slice(0, i).find((other) => other.port === current.port);
    if (earlier === undefined) return;
    ctx.addIssue({
      code: 'custom',
      path: current.path,
      message: `port ${String(current.port)} is already used by ${earlier.name}; the public, admin and operations listeners need distinct ports (ADR-0020, ADR-0022)`,
    });
  });
}

/** Applies resolution rules that need the whole config, e.g. breaker defaults (ADR-0015). */
function resolve(config: BaseConfig) {
  const globalBreaker = config.circuitBreaker;
  return {
    ...config,
    upstreams: config.upstreams.map(({ id, baseUrl: url, circuitBreaker: override }) => ({
      id,
      baseUrl: url.href,
      origin: url.origin,
      basePath: url.basePath,
      circuitBreaker: {
        failureThreshold: override?.failureThreshold ?? globalBreaker.failureThreshold,
        openDurationMs: override?.openDurationMs ?? globalBreaker.openDurationMs,
        halfOpenMaxRequests: override?.halfOpenMaxRequests ?? globalBreaker.halfOpenMaxRequests,
        halfOpenSuccessThreshold:
          override?.halfOpenSuccessThreshold ?? globalBreaker.halfOpenSuccessThreshold,
        failureStatuses: override?.failureStatuses ?? globalBreaker.failureStatuses,
      },
    })),
  };
}

export const gatewayConfigSchema = baseConfigSchema
  .superRefine(checkCrossFieldRules)
  .transform(resolve);

/** Config as written in YAML/JSON (defaults optional). */
export type GatewayConfigInput = z.input<typeof gatewayConfigSchema>;
/** Fully resolved, validated config used at runtime. */
export type GatewayConfig = z.output<typeof gatewayConfigSchema>;
export type RouteConfig = GatewayConfig['routes'][number];
export type UpstreamConfig = GatewayConfig['upstreams'][number];
export type CircuitBreakerConfig = UpstreamConfig['circuitBreaker'];
export type RetryConfig = RouteConfig['retries'];
export type CacheConfig = RouteConfig['cache'];
export type HttpMethod = (typeof HTTP_METHODS)[number];

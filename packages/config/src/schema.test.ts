import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from './index.ts';

/** Raw, not-yet-validated config input that tests can freely mutate. */
type Json = Record<string, unknown>;
interface TestInput extends Json {
  upstreams: [Json, ...Json[]];
  routes: [Json, ...Json[]];
}

function minimal(): TestInput {
  return {
    upstreams: [{ id: 'orders-service', baseUrl: 'http://orders:4001' }],
    routes: [
      {
        id: 'get-orders',
        pathPrefix: '/api/orders',
        methods: ['GET'],
        upstreamId: 'orders-service',
        rateLimit: { capacity: 60, refillRatePerSecond: 1 },
      },
    ],
  };
}

/** Builds a minimal config, letting the test mutate the plain input first. */
function withInput(mutate: (input: TestInput) => void): TestInput {
  const input = minimal();
  mutate(input);
  return input;
}

function issuesOf(input: unknown): { path: string; message: string }[] {
  try {
    parseConfig(input);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.issues];
    throw error;
  }
  throw new Error('expected parseConfig to fail');
}

function expectIssue(input: unknown, path: string, message: string | RegExp): void {
  const issues = issuesOf(input);
  expect(issues).toContainEqual({
    path,
    message: typeof message === 'string' ? message : (expect.stringMatching(message) as string),
  });
}

describe('defaults', () => {
  it('fills every documented default for a minimal config', () => {
    const config = parseConfig(minimal());
    expect(config.server).toEqual({
      host: '0.0.0.0',
      port: 8080,
      trustedProxies: [],
      limits: { maxRequestBodyBytes: 1_048_576, maxResponseBodyBytes: 10_485_760 },
      shutdownTimeoutMs: 10_000,
    });
    expect(config.admin).toEqual({ host: '127.0.0.1', port: 9090 });
    expect(config.operations).toEqual({ host: '127.0.0.1', port: 9091 });
    expect(config.rateLimit).toEqual({ mode: 'local', maxBuckets: 100_000 });
    expect(config.routes[0]).toEqual({
      id: 'get-orders',
      pathPrefix: '/api/orders',
      methods: ['GET'],
      upstreamId: 'orders-service',
      stripPrefix: false,
      auth: { required: true },
      rateLimit: { capacity: 60, refillRatePerSecond: 1 },
      timeoutMs: 3000,
      retries: {
        maxAttempts: 1,
        baseDelayMs: 50,
        maxDelayMs: 1000,
        retryableStatuses: [502, 503, 504],
      },
      cache: { enabled: false },
      forwarding: { authorization: false, forwardedHost: false },
    });
  });

  it('returns a deeply frozen config', () => {
    const config = parseConfig(minimal());
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.routes[0]?.retries.retryableStatuses)).toBe(true);
  });
});

describe('upstreams and routing (ADR-0013)', () => {
  it('lets several routes share one upstream', () => {
    const config = parseConfig(
      withInput((c) => {
        c.routes.push({ ...c.routes[0], id: 'create-orders', methods: ['POST'] });
      }),
    );
    expect(config.routes.map((r) => r.upstreamId)).toEqual(['orders-service', 'orders-service']);
  });

  it('rejects an unknown upstreamId and lists the known ones', () => {
    expectIssue(
      withInput((c) => (c.routes[0]['upstreamId'] = 'payments')),
      'routes[0] ("get-orders").upstreamId',
      'unknown upstream "payments"; known upstreams: "orders-service" (ADR-0013)',
    );
  });

  it('rejects duplicate upstream ids', () => {
    expectIssue(
      withInput((c) => c.upstreams.push({ id: 'orders-service', baseUrl: 'http://other:1' })),
      'upstreams[1] ("orders-service").id',
      /duplicate upstream id "orders-service" \(first defined at upstreams\[0\]\)/,
    );
  });

  it('rejects duplicate route ids', () => {
    expectIssue(
      withInput((c) => c.routes.push({ ...c.routes[0], pathPrefix: '/other' })),
      'routes[1] ("get-orders").id',
      /duplicate route id "get-orders"/,
    );
  });

  it('rejects an inline upstream URL on a route with a hint', () => {
    expectIssue(
      withInput((c) => (c.routes[0]['upstream'] = 'http://orders:4001')),
      'routes[0] ("get-orders").upstream',
      /unknown key; routes reference an upstream by "upstreamId".*ADR-0013/,
    );
  });

  it('requires at least one upstream and one route', () => {
    const issues = issuesOf({ upstreams: [], routes: [] });
    expect(issues).toContainEqual({
      path: 'upstreams',
      message: 'must define at least one upstream',
    });
    expect(issues).toContainEqual({ path: 'routes', message: 'must define at least one route' });
  });
});

describe('baseUrl (ADR-0013, ADR-0019)', () => {
  const at = 'upstreams[0] ("orders-service").baseUrl';
  const withBase = (baseUrl: string) => withInput((c) => (c.upstreams[0]['baseUrl'] = baseUrl));

  it('normalizes the base path and drops trailing slashes', () => {
    const [upstream] = parseConfig(withBase('http://orders:4001/v1/')).upstreams;
    expect(upstream).toMatchObject({
      baseUrl: 'http://orders:4001/v1',
      origin: 'http://orders:4001',
      basePath: '/v1',
    });
    expect(parseConfig(withBase('https://orders')).upstreams[0]?.basePath).toBe('');
  });

  it('rejects non-http protocols', () => {
    expectIssue(withBase('ftp://orders'), at, /protocol "ftp:" is not allowed/);
  });

  it('rejects credentials without echoing them', () => {
    const issues = issuesOf(withBase('http://user:s3cret@orders:4001'));
    expect(issues).toContainEqual({
      path: at,
      message: expect.stringMatching(/must not contain credentials/) as string,
    });
    expect(JSON.stringify(issues)).not.toContain('s3cret');
  });

  it('rejects query strings and fragments', () => {
    expectIssue(withBase('http://orders:4001/v1?key=1'), at, /must not contain a query string/);
    expectIssue(withBase('http://orders:4001/#x'), at, /must not contain a fragment/);
  });

  it('rejects relative or malformed URLs', () => {
    expectIssue(withBase('/v1'), at, /must be an absolute URL/);
  });
});

describe('route auth (ADR-0014)', () => {
  it('rejects the flat authRequired key with a hint', () => {
    expectIssue(
      withInput((c) => (c.routes[0]['authRequired'] = false)),
      'routes[0] ("get-orders").authRequired',
      /use "auth: \{ required: true \}" \(ADR-0014\)/,
    );
  });

  it('accepts auth.required: false', () => {
    const config = parseConfig(withInput((c) => (c.routes[0]['auth'] = { required: false })));
    expect(config.routes[0]?.auth.required).toBe(false);
  });
});

describe('circuit breaker (ADR-0015, ADR-0024)', () => {
  it('applies global defaults and per-upstream field overrides', () => {
    const config = parseConfig(
      withInput((c) => {
        c['circuitBreaker'] = { openDurationMs: 5000 };
        c.upstreams.push({
          id: 'payments',
          baseUrl: 'http://payments:4002',
          circuitBreaker: { failureThreshold: 3 },
        });
      }),
    );
    expect(config.upstreams[0]?.circuitBreaker).toEqual({
      failureThreshold: 5,
      openDurationMs: 5000,
      halfOpenMaxRequests: 1,
      halfOpenSuccessThreshold: 1,
      failureStatuses: [500, 502, 503, 504],
    });
    expect(config.upstreams[1]?.circuitBreaker).toEqual({
      failureThreshold: 3,
      openDurationMs: 5000,
      halfOpenMaxRequests: 1,
      halfOpenSuccessThreshold: 1,
      failureStatuses: [500, 502, 503, 504],
    });
  });

  it('rejects non-5xx failure statuses', () => {
    expectIssue(
      withInput((c) => (c['circuitBreaker'] = { failureStatuses: [404] })),
      'circuitBreaker.failureStatuses[0]',
      /5xx/,
    );
  });

  it('rejects breaker settings on a route with a hint', () => {
    expectIssue(
      withInput((c) => (c.routes[0]['circuitBreaker'] = { failureThreshold: 1 })),
      'routes[0] ("get-orders").circuitBreaker',
      /belong on "upstreams\[\]" or the top-level "circuitBreaker" block \(ADR-0015\)/,
    );
  });

  it('rejects a zero failure threshold', () => {
    expectIssue(
      withInput((c) => (c.upstreams[0]['circuitBreaker'] = { failureThreshold: 0 })),
      'upstreams[0] ("orders-service").circuitBreaker.failureThreshold',
      /1/,
    );
  });
});

describe('Phase 3 settings (ADR-0033)', () => {
  it('defaults halfOpenSuccessThreshold to 1 and merges per-upstream overrides', () => {
    const config = parseConfig(
      withInput((c) => {
        c['circuitBreaker'] = { halfOpenMaxRequests: 3 };
        c.upstreams[0]['circuitBreaker'] = { halfOpenSuccessThreshold: 3 };
      }),
    );
    expect(config.circuitBreaker.halfOpenSuccessThreshold).toBe(1);
    expect(config.upstreams[0]?.circuitBreaker).toMatchObject({
      halfOpenMaxRequests: 3,
      halfOpenSuccessThreshold: 3,
    });
  });

  it('rejects a success threshold above the probe limit after merging', () => {
    expectIssue(
      withInput((c) => (c.upstreams[0]['circuitBreaker'] = { halfOpenSuccessThreshold: 2 })),
      'upstreams[0] ("orders-service").circuitBreaker.halfOpenSuccessThreshold',
      /2 exceeds halfOpenMaxRequests \(1\).*could never close/,
    );
    expectIssue(
      withInput((c) => (c['circuitBreaker'] = { halfOpenSuccessThreshold: 2 })),
      'circuitBreaker.halfOpenSuccessThreshold',
      /exceeds halfOpenMaxRequests/,
    );
  });

  it('accepts attemptTimeoutMs within timeoutMs and rejects it above', () => {
    expect(
      parseConfig(withInput((c) => (c.routes[0]['attemptTimeoutMs'] = 500))).routes[0]
        ?.attemptTimeoutMs,
    ).toBe(500);
    expectIssue(
      withInput((c) => (c.routes[0]['attemptTimeoutMs'] = 5000)),
      'routes[0] ("get-orders").attemptTimeoutMs',
      /must not exceed timeoutMs \(3000\)/,
    );
  });
});

describe('retries (ADR-0016)', () => {
  const retries = 'routes[0] ("get-orders").retries';

  it('rejects maxAttempts below 1', () => {
    expectIssue(
      withInput((c) => (c.routes[0]['retries'] = { maxAttempts: 0 })),
      `${retries}.maxAttempts`,
      /1/,
    );
  });

  it('rejects maxDelayMs below baseDelayMs', () => {
    expectIssue(
      withInput((c) => (c.routes[0]['retries'] = { baseDelayMs: 500, maxDelayMs: 100 })),
      `${retries}.maxDelayMs`,
      'must be greater than or equal to baseDelayMs (ADR-0016)',
    );
  });

  it('rejects retrying ordinary 4xx statuses', () => {
    expectIssue(
      withInput((c) => (c.routes[0]['retries'] = { retryableStatuses: [404] })),
      `${retries}.retryableStatuses[0]`,
      'must be 408, 429 or a 5xx status (ADR-0016)',
    );
  });
});

describe('route matching (ADR-0017)', () => {
  const prefix = 'routes[0] ("get-orders").pathPrefix';
  const withPrefix = (pathPrefix: string) =>
    withInput((c) => (c.routes[0]['pathPrefix'] = pathPrefix));

  it('rejects a second route with the same prefix and an overlapping method', () => {
    expectIssue(
      withInput((c) =>
        c.routes.push({ ...c.routes[0], id: 'orders-dup', methods: ['POST', 'GET'] }),
      ),
      'routes[1] ("orders-dup").methods',
      /GET \/api\/orders is already handled by route "get-orders" \(routes\[0\]\)/,
    );
  });

  it.each([
    ['api/orders', /must start with "\/"/],
    ['/api/orders/', /must not end with "\/"/],
    ['/api//orders', /empty segments/],
    ['/api/../admin', /"\." or "\.\." segments/],
    ['/api/%6Frders', /percent-encoding/],
    ['/api/orders?x=1', /percent-encoding, "\?" and "#"/],
  ])('rejects pathPrefix %s', (value, message) => {
    expectIssue(withPrefix(value), prefix, message);
  });

  it('accepts "/" as a catch-all prefix', () => {
    expect(parseConfig(withPrefix('/')).routes[0]?.pathPrefix).toBe('/');
  });

  it('rejects unsupported and duplicate methods', () => {
    expectIssue(
      withInput((c) => (c.routes[0]['methods'] = ['CONNECT'])),
      'routes[0] ("get-orders").methods[0]',
      /GET/,
    );
    expectIssue(
      withInput((c) => (c.routes[0]['methods'] = ['GET', 'GET'])),
      'routes[0] ("get-orders").methods',
      'must not contain duplicates',
    );
  });
});

describe('cache (ADR-0009)', () => {
  it('requires ttlSeconds when enabled', () => {
    expectIssue(
      withInput((c) => (c.routes[0]['cache'] = { enabled: true })),
      'routes[0] ("get-orders").cache.ttlSeconds',
      'is required when cache.enabled is true',
    );
  });

  it('resolves an enabled cache with its defaults', () => {
    const config = parseConfig(
      withInput((c) => (c.routes[0]['cache'] = { enabled: true, ttlSeconds: 30 })),
    );
    expect(config.routes[0]?.cache).toEqual({
      enabled: true,
      ttlSeconds: 30,
      maxResponseBytes: 262_144,
    });
  });
});

describe('rate-limit mode (ADR-0005)', () => {
  it('requires an explicit Redis failure policy', () => {
    expectIssue(
      withInput((c) => (c['rateLimit'] = { mode: 'redis' })),
      'rateLimit.redisFailurePolicy',
      /is required when mode is "redis"/,
    );
  });

  it('accepts redis mode with a policy', () => {
    const config = parseConfig(
      withInput((c) => (c['rateLimit'] = { mode: 'redis', redisFailurePolicy: 'closed' })),
    );
    expect(config.rateLimit).toEqual({
      mode: 'redis',
      redisFailurePolicy: 'closed',
      maxBuckets: 100_000,
    });
  });

  it('rejects a route without a rate limit', () => {
    expectIssue(
      withInput((c) => delete c.routes[0]['rateLimit']),
      'routes[0] ("get-orders").rateLimit',
      /expected object/,
    );
  });
});

describe('listeners and proxies (ADR-0020, ADR-0021, ADR-0022)', () => {
  it('rejects listeners sharing a port', () => {
    expectIssue(
      withInput((c) => (c['operations'] = { port: 9090 })),
      'operations.port',
      /port 9090 is already used by admin.port/,
    );
  });

  it('accepts IPs and CIDR ranges as trusted proxies', () => {
    const config = parseConfig(
      withInput((c) => (c['server'] = { trustedProxies: ['10.0.0.1', '10.0.0.0/8', 'fd00::/8'] })),
    );
    expect(config.server.trustedProxies).toEqual(['10.0.0.1', '10.0.0.0/8', 'fd00::/8']);
  });

  it.each(['10.0.0.0/33', 'not-an-ip', '10.0.0.0/8/1', 'fd00::/129'])(
    'rejects trusted proxy %s',
    (value) => {
      expectIssue(
        withInput((c) => (c['server'] = { trustedProxies: [value] })),
        'server.trustedProxies[0]',
        /must be an IP address or CIDR range/,
      );
    },
  );
});

describe('error reporting', () => {
  it('reports every problem at once with a readable message', () => {
    const input = withInput((c) => {
      c.routes[0]['upstreamId'] = 'nope';
      c.routes[0]['timeoutMs'] = 0;
      c['unexpected'] = true;
    });
    let thrown: unknown;
    try {
      parseConfig(input, { source: 'config/routes.yaml' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const message = (thrown as ConfigError).message;
    expect(message).toMatch(
      /^Invalid gateway configuration in config\/routes.yaml \(\d+ problems\):/,
    );
    expect(message).toContain('  - unexpected: unknown key (check for typos)');
    expect(message).toContain('  - routes[0] ("get-orders").timeoutMs:');
  });
});

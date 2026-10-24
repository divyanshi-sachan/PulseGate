import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, formatFromPath, loadConfigFile, parseConfigText } from './index.ts';

const EXAMPLE = fileURLToPath(new URL('../../../config/routes.example.yaml', import.meta.url));

const YAML = `
upstreams:
  - id: orders-service
    baseUrl: http://orders:4001
routes:
  - id: get-orders
    pathPrefix: /api/orders
    methods: [GET]
    upstreamId: orders-service
    rateLimit: { capacity: 10, refillRatePerSecond: 1 }
`;

async function rejection(promise: Promise<unknown>): Promise<ConfigError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ConfigError);
  return error as ConfigError;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pulsegate-config-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadConfigFile', () => {
  it('loads and validates the committed example config', async () => {
    const config = await loadConfigFile(EXAMPLE);
    expect(config.routes.map((r) => r.id)).toEqual(['get-orders', 'create-orders', 'get-payments']);
    expect(config.upstreams[1]?.circuitBreaker.failureThreshold).toBe(3);
    expect(config.routes[0]?.cache).toEqual({
      enabled: true,
      ttlSeconds: 30,
      maxResponseBytes: 262_144,
      scope: 'client',
      varyHeaders: [],
    });
  });

  it('loads the committed distributed example config', async () => {
    const path = fileURLToPath(
      new URL('../../../config/routes.distributed.example.yaml', import.meta.url),
    );
    const config = await loadConfigFile(path);
    expect(config.rateLimit).toMatchObject({ mode: 'redis', redisFailurePolicy: 'closed' });
  });

  it('loads the committed dashboard example config, with the admin listener open inside the container', async () => {
    const config = await loadConfigFile(
      fileURLToPath(new URL('../../../config/routes.dashboard.example.yaml', import.meta.url)),
    );
    expect(config.admin).toEqual({ host: '0.0.0.0', port: 9090 });
    expect(config.routes.map((r) => r.id)).toEqual(['get-orders', 'create-orders', 'get-payments']);
  });

  it('loads the e2e config: plan §7 routes plus the fault scenarios F1-F6', async () => {
    const config = await loadConfigFile(
      fileURLToPath(new URL('../../../config/routes.e2e.yaml', import.meta.url)),
    );
    expect(config.routes.map((r) => r.id)).toEqual([
      'e2e-ok',
      'e2e-limited',
      'e2e-cached',
      'e2e-faulty',
      'e2e-slow',
      'e2e-retry',
      'e2e-recover',
    ]);
    expect(config.routes.find((r) => r.id === 'e2e-slow')?.timeoutMs).toBe(500);
    expect(config.routes.find((r) => r.id === 'e2e-retry')?.retries.maxAttempts).toBe(3);
    expect(config.upstreams.find((u) => u.id === 'recover-service')?.circuitBreaker).toMatchObject({
      failureThreshold: 2,
      openDurationMs: 3000,
    });
    expect(config.routes.find((r) => r.id === 'e2e-limited')?.rateLimit).toEqual({
      capacity: 3,
      refillRatePerSecond: 0.001,
    });
    expect(config.routes.find((r) => r.id === 'e2e-cached')?.cache).toMatchObject({
      enabled: true,
      ttlSeconds: 600,
    });
    expect(config.upstreams.find((u) => u.id === 'faulty-service')?.circuitBreaker).toMatchObject({
      failureThreshold: 2,
      openDurationMs: 600_000,
    });
  });

  it('loads the pinned k6 bench configs (ADR-0046)', async () => {
    const local = await loadConfigFile(
      fileURLToPath(new URL('../../../config/routes.bench.yaml', import.meta.url)),
    );
    expect(local.rateLimit.mode).toBe('local');
    expect(local.routes.find((r) => r.id === 'bench-limited')?.rateLimit).toEqual({
      capacity: 10,
      refillRatePerSecond: 2,
    });
    expect(local.routes.find((r) => r.id === 'bench-cached')?.cache).toMatchObject({
      enabled: true,
      ttlSeconds: 600,
      scope: 'shared',
      varyHeaders: [],
    });
    const redis = await loadConfigFile(
      fileURLToPath(new URL('../../../config/routes.bench-redis.yaml', import.meta.url)),
    );
    expect(redis.rateLimit).toMatchObject({ mode: 'redis', redisFailurePolicy: 'closed' });
    expect(redis.routes.find((r) => r.id === 'bench-shared')?.rateLimit).toEqual({
      capacity: 20,
      refillRatePerSecond: 4,
    });
  });

  it('loads YAML and JSON files', async () => {
    const yamlPath = join(dir, 'gateway.yml');
    const jsonPath = join(dir, 'gateway.json');
    await writeFile(yamlPath, YAML);
    await writeFile(
      jsonPath,
      JSON.stringify({
        upstreams: [{ id: 'a', baseUrl: 'http://a:1' }],
        routes: [
          {
            id: 'r',
            pathPrefix: '/r',
            methods: ['GET'],
            upstreamId: 'a',
            rateLimit: { capacity: 1, refillRatePerSecond: 1 },
          },
        ],
      }),
    );
    expect((await loadConfigFile(yamlPath)).routes[0]?.id).toBe('get-orders');
    expect((await loadConfigFile(jsonPath)).routes[0]?.id).toBe('r');
  });

  it('reports a missing file with a next step', async () => {
    const error = await rejection(loadConfigFile(join(dir, 'missing.yaml')));
    expect(error.issues).toEqual([
      { path: '(file)', message: expect.stringContaining('config file not found') as string },
    ]);
    expect(error.source).toBe(join(dir, 'missing.yaml'));
  });

  it('names the file in validation errors', async () => {
    const path = join(dir, 'bad.yaml');
    await writeFile(path, YAML.replace('upstreamId: orders-service', 'upstreamId: nope'));
    const error = await rejection(loadConfigFile(path));
    expect(error.message).toContain(`Invalid gateway configuration in ${path}`);
    expect(error.message).toContain('unknown upstream "nope"');
  });
});

describe('parseConfigText', () => {
  it('reports YAML syntax errors with their position', () => {
    let thrown: unknown;
    try {
      parseConfigText('routes: [\n  - id: x\n', 'yaml');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const issue = (thrown as ConfigError).issues[0];
    expect(issue?.path).toBe('(syntax)');
    expect(issue?.message).toMatch(/line \d+/);
  });

  it('rejects duplicate YAML keys', () => {
    expect(() => parseConfigText(`${YAML}\nroutes: []\n`, 'yaml')).toThrow(/(syntax)/);
  });

  it('reports JSON syntax errors', () => {
    expect(() => parseConfigText('{ "routes": ', 'json')).toThrow(/\(syntax\)/);
  });
});

describe('formatFromPath', () => {
  it('detects the format from the extension', () => {
    expect(formatFromPath('a/b.YAML')).toBe('yaml');
    expect(formatFromPath('a/b.yml')).toBe('yaml');
    expect(formatFromPath('a/b.json')).toBe('json');
    expect(() => formatFromPath('a/b.toml')).toThrow(/unsupported config file extension ".toml"/);
  });
});

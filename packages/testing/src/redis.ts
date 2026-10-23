import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

/** Pinned image for Redis integration tests (ADR-0034). */
export const REDIS_TEST_IMAGE = 'redis:7.4.11-alpine';

export interface TestRedis {
  /** redis://[:password@]host:port */
  url: string;
  host: string;
  port: number;
  password: string | undefined;
  stop(): Promise<void>;
}

/**
 * Starts a real Redis in Docker. Without Docker the caller should skip its suite: this returns
 * undefined and warns loudly, unless REQUIRE_REDIS_TESTS=1, which turns the skip into a failure (ADR-0034).
 */
export async function startTestRedis(
  options: { password?: string } = {},
): Promise<TestRedis | undefined> {
  let container: StartedRedisContainer;
  try {
    const base = new RedisContainer(REDIS_TEST_IMAGE);
    container = await (
      options.password === undefined ? base : base.withPassword(options.password)
    ).start();
  } catch (error) {
    if (process.env['REQUIRE_REDIS_TESTS'] === '1') throw error;
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    // Written straight to stderr: Vitest drops console output from files whose tests are all skipped.
    process.stderr.write(
      `\n[pulsegate] Redis integration tests SKIPPED: could not start ${REDIS_TEST_IMAGE} (${reason ?? 'unknown'}).` +
        '\n[pulsegate] Start Docker, or set REQUIRE_REDIS_TESTS=1 to make this a failure.\n',
    );
    return undefined;
  }
  const host = container.getHost();
  const port = container.getPort();
  const auth = options.password === undefined ? '' : `:${encodeURIComponent(options.password)}@`;
  return {
    url: `redis://${auth}${host}:${String(port)}`,
    host,
    port,
    password: options.password,
    stop: async () => {
      await container.stop();
    },
  };
}

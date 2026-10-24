import { ConfigError } from '@pulsegate/config';

export interface RedisTarget {
  /** host:port, the only part of the URL ever logged (ADR-0034). */
  target: string;
  /** Removes the URL and any credentials from text before it is logged or surfaced. */
  redact: (text: string) => string;
}

/**
 * Validates REDIS_URL without ever echoing it: Node's URL TypeError carries the full input
 * (password included) in its `input` property, so it must not escape (ADR-0034 review).
 */
export function parseRedisUrl(redisUrl: string): RedisTarget {
  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    throw new ConfigError([
      {
        path: 'REDIS_URL',
        message: 'is not a valid URL (value not shown; it may contain credentials)',
      },
    ]);
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new ConfigError([
      {
        path: 'REDIS_URL',
        message: `must use redis:// or rediss:// (got "${url.protocol}"; value not shown)`,
      },
    ]);
  }
  const secrets = [redisUrl, url.password, decodeURIComponent(url.password), url.username]
    .filter((secret) => secret.length >= 3)
    .sort((a, b) => b.length - a.length);
  return {
    target: url.host,
    redact: (text) => secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), text),
  };
}

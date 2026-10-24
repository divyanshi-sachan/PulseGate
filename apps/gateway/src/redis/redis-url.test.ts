import { ConfigError } from '@pulsegate/config';
import { describe, expect, it } from 'vitest';
import { parseRedisUrl } from './redis-url.ts';

const SECRET = 'Sup3r$ecret/pw';

function errorText(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    // Everything that could be logged: message, issues and every enumerable property.
    return JSON.stringify({
      ...(error as object),
      message: (error as Error).message,
      stack: (error as Error).stack,
    });
  }
  throw new Error('expected a ConfigError');
}

describe('parseRedisUrl (ADR-0034 review: credential redaction)', () => {
  it('returns only host:port as the loggable target', () => {
    const parsed = parseRedisUrl(
      `redis://user:${encodeURIComponent(SECRET)}@cache.internal:6380/0`,
    );
    expect(parsed.target).toBe('cache.internal:6380');
  });

  it('rejects a malformed URL without echoing it', () => {
    const text = errorText(() => parseRedisUrl(`redis//:${SECRET}@cache:6379`));
    expect(text).toContain('REDIS_URL');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('cache:6379');
  });

  it('rejects other schemes without echoing the URL', () => {
    const text = errorText(() =>
      parseRedisUrl(`http://user:${encodeURIComponent(SECRET)}@cache:6379`),
    );
    expect(text).toContain('redis:// or rediss://');
    expect(text).not.toContain(encodeURIComponent(SECRET));
  });

  it('scrubs the URL and the password (raw and decoded) from error text', () => {
    const url = `rediss://default:${encodeURIComponent(SECRET)}@cache:6379`;
    const { redact } = parseRedisUrl(url);
    expect(redact(`connect to ${url} failed`)).toBe('connect to [redacted] failed');
    expect(redact(`WRONGPASS ${SECRET}`)).toBe('WRONGPASS [redacted]');
    expect(redact(`auth ${encodeURIComponent(SECRET)}`)).toBe('auth [redacted]');
    expect(redact('ECONNREFUSED 10.0.0.5:6379')).toBe('ECONNREFUSED 10.0.0.5:6379');
  });
});

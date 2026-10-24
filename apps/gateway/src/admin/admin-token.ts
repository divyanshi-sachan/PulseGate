import { createHash, timingSafeEqual } from 'node:crypto';
import { ConfigError } from '@pulsegate/config';

/** Shortest accepted ADMIN_TOKEN (plan §5, Claude-chosen): 32 characters, e.g. `openssl rand -hex 16`. */
export const MIN_ADMIN_TOKEN_LENGTH = 32;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Bearer-token check for the admin listener (ADR-0020). Both sides are hashed first, so the comparison is
 * constant-time and length-independent. The token itself is never stored in a readable field or logged.
 */
export class AdminTokenVerifier {
  readonly #expected: Buffer;

  constructor(token: string) {
    if (token.length < MIN_ADMIN_TOKEN_LENGTH) {
      throw new ConfigError([
        {
          path: 'ADMIN_TOKEN',
          message: `must be at least ${String(MIN_ADMIN_TOKEN_LENGTH)} characters (got ${String(token.length)}); generate one with \`openssl rand -hex 32\` (ADR-0020)`,
        },
      ]);
    }
    this.#expected = digest(token);
  }

  /** True only for `Authorization: Bearer <token>` with the exact token. */
  verify(authorization: string | undefined): boolean {
    if (authorization === undefined) return false;
    const match = /^Bearer ([^\s]+)$/i.exec(authorization.trim());
    const presented = match?.[1];
    if (presented === undefined) return false;
    return timingSafeEqual(digest(presented), this.#expected);
  }
}

import { createHash, randomBytes } from 'node:crypto';

/** `pg_` + 32 random bytes in base64url (ADR-0031). */
export const API_KEY_PATTERN = /^pg_[A-Za-z0-9_-]{43}$/;

export function generateApiKey(): string {
  return `pg_${randomBytes(32).toString('base64url')}`;
}

/** Lowercase hex SHA-256 digest, the only form in which keys are stored. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

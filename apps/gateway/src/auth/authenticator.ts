import type { ClientsConfig } from '@pulsegate/config';
import { GatewayError } from '@pulsegate/shared';
import { API_KEY_PATTERN, hashApiKey } from './api-key.ts';

export interface ClientIdentity {
  clientId: string;
  keyId: string;
}

/** Internal reason, logged but never returned to the client (ADR-0031). */
export type AuthFailureReason = 'missing' | 'malformed' | 'unknown' | 'expired' | 'disabled';

/** 401 that remembers why authentication failed, for the request log only. */
export class AuthenticationError extends GatewayError {
  readonly reason: AuthFailureReason;

  constructor(reason: AuthFailureReason) {
    super('AUTHENTICATION_FAILED');
    this.reason = reason;
  }
}

interface KeyEntry {
  clientId: string;
  keyId: string;
  enabled: boolean;
  expiresAtMs: number | undefined;
}

/** Resolves `X-API-Key` to a client identity by SHA-256 digest lookup (ADR-0031). */
export class ApiKeyAuthenticator {
  readonly #byDigest = new Map<string, KeyEntry>();
  readonly #now: () => number;

  constructor(clients: ClientsConfig, options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    for (const client of clients.clients) {
      for (const key of client.keys) {
        this.#byDigest.set(key.sha256, {
          clientId: client.id,
          keyId: key.id,
          enabled: client.enabled,
          expiresAtMs: key.expiresAtMs,
        });
      }
    }
  }

  /** Throws {@link AuthenticationError} (401) for every failure, with the same public body. */
  authenticate(header: string | string[] | undefined): ClientIdentity {
    if (header === undefined || header === '') throw new AuthenticationError('missing');
    // Repeated headers arrive as an array or a comma-joined string; both are rejected.
    if (Array.isArray(header) || !API_KEY_PATTERN.test(header)) {
      throw new AuthenticationError('malformed');
    }
    const entry = this.#byDigest.get(hashApiKey(header));
    if (entry === undefined) throw new AuthenticationError('unknown');
    if (!entry.enabled) throw new AuthenticationError('disabled');
    if (entry.expiresAtMs !== undefined && this.#now() >= entry.expiresAtMs) {
      throw new AuthenticationError('expired');
    }
    return { clientId: entry.clientId, keyId: entry.keyId };
  }
}

import { parseClients } from '@pulsegate/config';
import { describe, expect, it } from 'vitest';
import { API_KEY_PATTERN, generateApiKey, hashApiKey } from './api-key.ts';
import { ApiKeyAuthenticator, AuthenticationError } from './authenticator.ts';

const live = generateApiKey();
const rotated = generateApiKey();
const expiring = generateApiKey();
const disabled = generateApiKey();
const EXPIRY = Date.UTC(2027, 0, 1);

const clients = parseClients({
  clients: [
    {
      id: 'mobile',
      keys: [
        { id: 'current', sha256: hashApiKey(live) },
        { id: 'next', sha256: hashApiKey(rotated) },
        { id: 'temp', sha256: hashApiKey(expiring), expiresAt: new Date(EXPIRY).toISOString() },
      ],
    },
    { id: 'retired', enabled: false, keys: [{ id: 'k', sha256: hashApiKey(disabled) }] },
  ],
});

function reasonOf(auth: ApiKeyAuthenticator, header: string | string[] | undefined): string {
  try {
    auth.authenticate(header);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      expect(error.status).toBe(401);
      expect(error.code).toBe('AUTHENTICATION_FAILED');
      return error.reason;
    }
    throw error;
  }
  return 'ok';
}

describe('API keys (ADR-0031)', () => {
  it('generates keys in the documented format with distinct digests', () => {
    expect(live).toMatch(API_KEY_PATTERN);
    expect(live).toHaveLength(46);
    expect(hashApiKey(live)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(live)).not.toBe(hashApiKey(rotated));
  });
});

describe('ApiKeyAuthenticator (ADR-0031)', () => {
  const auth = new ApiKeyAuthenticator(clients, { now: () => EXPIRY - 1 });

  it('resolves every live key of a client during rotation', () => {
    expect(auth.authenticate(live)).toEqual({ clientId: 'mobile', keyId: 'current' });
    expect(auth.authenticate(rotated)).toEqual({ clientId: 'mobile', keyId: 'next' });
  });

  it.each([
    ['missing', undefined],
    ['missing', ''],
    ['malformed', 'not-a-key'],
    ['malformed', `${live}, ${rotated}`],
    ['malformed', [live, rotated]],
    ['unknown', generateApiKey()],
    ['disabled', disabled],
  ] as const)('rejects as %s', (reason, header) => {
    expect(reasonOf(auth, header as string | string[] | undefined)).toBe(reason);
  });

  it('accepts a key until its expiry instant, then rejects it', () => {
    expect(reasonOf(auth, expiring)).toBe('ok');
    const later = new ApiKeyAuthenticator(clients, { now: () => EXPIRY });
    expect(reasonOf(later, expiring)).toBe('expired');
  });

  it('returns the same public error for every reason', () => {
    const bodies = [undefined, 'junk', generateApiKey(), disabled].map((header) => {
      try {
        auth.authenticate(header);
      } catch (error) {
        return (error as AuthenticationError).toBody('req_x');
      }
      return undefined;
    });
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
  });
});

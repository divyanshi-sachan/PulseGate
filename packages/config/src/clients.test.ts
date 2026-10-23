import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertClientsForAuth,
  ConfigError,
  loadClientsFile,
  parseClients,
  parseConfig,
} from './index.ts';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const EXAMPLE = fileURLToPath(new URL('../../../config/clients.example.yaml', import.meta.url));

function issuesOf(input: unknown): { path: string; message: string }[] {
  try {
    parseClients(input);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.issues];
    throw error;
  }
  throw new Error('expected parseClients to fail');
}

describe('clients file (ADR-0031)', () => {
  it('applies defaults and converts expiry to epoch milliseconds', () => {
    const clients = parseClients({
      clients: [
        {
          id: 'mobile-app',
          keys: [
            { id: 'old', sha256: DIGEST_A.toUpperCase(), expiresAt: '2027-01-01T00:00:00Z' },
            { id: 'new', sha256: DIGEST_B },
          ],
        },
      ],
    });
    expect(clients.clients[0]).toEqual({
      id: 'mobile-app',
      enabled: true,
      keys: [
        { id: 'old', sha256: DIGEST_A, expiresAtMs: Date.UTC(2027, 0, 1) },
        { id: 'new', sha256: DIGEST_B, expiresAtMs: undefined },
      ],
    });
  });

  it('rejects a raw key stored as the digest, pointing to pnpm keygen', () => {
    expect(
      issuesOf({ clients: [{ id: 'c', keys: [{ id: 'k', sha256: `pg_${'x'.repeat(43)}` }] }] }),
    ).toContainEqual({
      path: 'clients[0] ("c").keys[0] ("k").sha256',
      message: expect.stringMatching(/looks like a raw API key.*pnpm keygen/) as string,
    });
  });

  it('rejects a raw key field with a hint', () => {
    expect(
      issuesOf({
        clients: [{ id: 'c', keys: [{ id: 'k', sha256: DIGEST_A, key: 'pg_secret' }] }],
      }),
    ).toContainEqual({
      path: 'clients[0] ("c").keys[0] ("k").key',
      message: expect.stringMatching(/never store raw API keys/) as string,
    });
  });

  it('rejects malformed digests and timezone-less expiry', () => {
    const issues = issuesOf({
      clients: [{ id: 'c', keys: [{ id: 'k', sha256: 'abc', expiresAt: '2027-01-01T00:00:00' }] }],
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      'clients[0] ("c").keys[0] ("k").sha256',
      'clients[0] ("c").keys[0] ("k").expiresAt',
    ]);
  });

  it('rejects duplicate client ids, key ids and digests', () => {
    const issues = issuesOf({
      clients: [
        {
          id: 'c',
          keys: [
            { id: 'k', sha256: DIGEST_A },
            { id: 'k', sha256: DIGEST_B },
          ],
        },
        { id: 'c', keys: [{ id: 'other', sha256: DIGEST_A }] },
      ],
    });
    expect(issues.map((issue) => issue.message)).toEqual([
      expect.stringMatching(/duplicate key id "k"/),
      expect.stringMatching(/duplicate client id "c"/),
      expect.stringMatching(/already used by c\/k/),
    ]);
  });

  it('requires at least one client and one key', () => {
    expect(issuesOf({ clients: [] })[0]?.message).toBe('must define at least one client');
    expect(issuesOf({ clients: [{ id: 'c', keys: [] }] })[0]?.message).toBe(
      'each client needs at least one key',
    );
  });

  it('loads the committed example file', async () => {
    const clients = await loadClientsFile(EXAMPLE);
    expect(clients.clients.map((client) => client.id)).toEqual(['demo-client']);
  });
});

describe('assertClientsForAuth', () => {
  const config = (required: boolean) =>
    parseConfig({
      upstreams: [{ id: 'up', baseUrl: 'http://up:1' }],
      routes: [
        {
          id: 'r',
          pathPrefix: '/r',
          methods: ['GET'],
          upstreamId: 'up',
          auth: { required },
          rateLimit: { capacity: 1, refillRatePerSecond: 1 },
        },
      ],
    });

  it('fails when a route needs auth and there are no clients', () => {
    expect(() => {
      assertClientsForAuth(config(true), undefined, 'config/clients.yaml');
    }).toThrow(/routes "r" require auth.*no clients file/);
  });

  it('passes when no route needs auth or clients exist', () => {
    expect(() => {
      assertClientsForAuth(config(false), undefined, 'x');
    }).not.toThrow();
    const clients = parseClients({ clients: [{ id: 'c', keys: [{ id: 'k', sha256: DIGEST_A }] }] });
    expect(() => {
      assertClientsForAuth(config(true), clients, 'x');
    }).not.toThrow();
  });
});

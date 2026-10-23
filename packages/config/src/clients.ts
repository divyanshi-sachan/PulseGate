import { z } from 'zod';
import { ConfigError } from './errors.ts';
import type { GatewayConfig } from './schema.ts';

/**
 * API clients file schema (ADR-0031). Holds SHA-256 digests of API keys, never raw keys.
 */

const identifier = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    'must be 1-64 characters: letters, digits, ".", "_" or "-", starting with a letter or digit',
  );

const sha256 = z
  .string()
  .superRefine((value, ctx) => {
    if (value.startsWith('pg_')) {
      ctx.addIssue({
        code: 'custom',
        message:
          'looks like a raw API key; store only its SHA-256 digest. Run `pnpm keygen` to generate a key and digest (ADR-0031)',
      });
    } else if (!/^[0-9a-fA-F]{64}$/.test(value)) {
      ctx.addIssue({ code: 'custom', message: 'must be a 64-character hex SHA-256 digest' });
    }
  })
  .transform((value) => value.toLowerCase());

const keySchema = z.strictObject({
  id: identifier,
  sha256,
  expiresAt: z.iso
    .datetime({
      offset: true,
      error: 'must be an ISO 8601 date-time with a timezone, e.g. "2027-01-01T00:00:00Z"',
    })
    .optional(),
});

const clientSchema = z.strictObject({
  id: identifier,
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().default(true),
  keys: z.array(keySchema).min(1, 'each client needs at least one key'),
});

type BaseClients = z.output<typeof baseClientsSchema>;

const baseClientsSchema = z.strictObject({
  clients: z.array(clientSchema).min(1, 'must define at least one client'),
});

function checkUniqueness(file: BaseClients, ctx: z.RefinementCtx): void {
  const clientIndex = new Map<string, number>();
  const digestOwner = new Map<string, string>();
  file.clients.forEach((client, i) => {
    const first = clientIndex.get(client.id);
    if (first === undefined) clientIndex.set(client.id, i);
    else {
      ctx.addIssue({
        code: 'custom',
        path: ['clients', i, 'id'],
        message: `duplicate client id "${client.id}" (first defined at clients[${String(first)}])`,
      });
    }

    const keyIds = new Set<string>();
    client.keys.forEach((key, k) => {
      if (keyIds.has(key.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['clients', i, 'keys', k, 'id'],
          message: `duplicate key id "${key.id}" within client "${client.id}"`,
        });
      }
      keyIds.add(key.id);

      const owner = digestOwner.get(key.sha256);
      if (owner === undefined) digestOwner.set(key.sha256, `${client.id}/${key.id}`);
      else {
        ctx.addIssue({
          code: 'custom',
          path: ['clients', i, 'keys', k, 'sha256'],
          message: `this key digest is already used by ${owner}; every key must be unique (ADR-0031)`,
        });
      }
    });
  });
}

export const clientsFileSchema = baseClientsSchema
  .superRefine(checkUniqueness)
  .transform((file) => ({
    clients: file.clients.map((client) => ({
      ...client,
      keys: client.keys.map((key) => ({
        id: key.id,
        sha256: key.sha256,
        expiresAtMs: key.expiresAt === undefined ? undefined : Date.parse(key.expiresAt),
      })),
    })),
  }));

export type ClientsFileInput = z.input<typeof clientsFileSchema>;
export type ClientsConfig = z.output<typeof clientsFileSchema>;
export type ApiClientConfig = ClientsConfig['clients'][number];

/** Route ids that require authentication. */
export function routesRequiringAuth(config: GatewayConfig): string[] {
  return config.routes.filter((route) => route.auth.required).map((route) => route.id);
}

/** Fails startup when auth is required somewhere but no clients are configured (ADR-0031). */
export function assertClientsForAuth(
  config: GatewayConfig,
  clients: ClientsConfig | undefined,
  clientsPath: string,
): void {
  const needAuth = routesRequiringAuth(config);
  if (needAuth.length === 0 || clients !== undefined) return;
  throw new ConfigError(
    [
      {
        path: '(file)',
        message: `routes ${needAuth.map((id) => `"${id}"`).join(', ')} require auth (auth.required defaults to true), but no clients file was found. Copy config/clients.example.yaml or run \`pnpm keygen\`, or set auth.required: false on those routes (ADR-0031)`,
      },
    ],
    clientsPath,
  );
}

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { clientsFileSchema, type ClientsConfig } from './clients.ts';
import { ConfigError, toConfigIssues } from './errors.ts';
import { gatewayConfigSchema, type GatewayConfig } from './schema.ts';

export type ConfigFormat = 'yaml' | 'json';

export interface ParseOptions {
  /** Shown in error messages, usually the file path. */
  source?: string;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function validate<S extends z.ZodType>(
  schema: S,
  input: unknown,
  options: ParseOptions,
): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new ConfigError(toConfigIssues(result.error, input), options.source);
  return deepFreeze(result.data);
}

function parseText(text: string, format: ConfigFormat, options: ParseOptions): unknown {
  if (format === 'yaml') {
    const document = parseDocument(text);
    if (document.errors.length > 0) {
      throw new ConfigError(
        document.errors.map((error) => ({ path: '(syntax)', message: error.message })),
        options.source,
      );
    }
    return document.toJS();
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError([{ path: '(syntax)', message }], options.source);
  }
}

async function readConfigText(path: string, notFoundMessage: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message =
      code === 'ENOENT' ? notFoundMessage : `cannot read config file (${code ?? 'unknown error'})`;
    throw new ConfigError([{ path: '(file)', message }], path);
  }
}

/** Validates already-parsed config data. The result is deeply frozen (read-only at runtime, ADR-0003). */
export function parseConfig(input: unknown, options: ParseOptions = {}): GatewayConfig {
  return validate(gatewayConfigSchema, input, options);
}

/** Parses YAML or JSON text, then validates it. */
export function parseConfigText(
  text: string,
  format: ConfigFormat,
  options: ParseOptions = {},
): GatewayConfig {
  return parseConfig(parseText(text, format, options), options);
}

/** Validates already-parsed clients data (ADR-0031). The result is deeply frozen. */
export function parseClients(input: unknown, options: ParseOptions = {}): ClientsConfig {
  return validate(clientsFileSchema, input, options);
}

export function formatFromPath(path: string): ConfigFormat {
  const extension = extname(path).toLowerCase();
  if (extension === '.yaml' || extension === '.yml') return 'yaml';
  if (extension === '.json') return 'json';
  throw new ConfigError(
    [
      {
        path: '(file)',
        message: `unsupported config file extension "${extension}"; use .yaml, .yml or .json`,
      },
    ],
    path,
  );
}

/** Reads, parses and validates a config file. Throws {@link ConfigError} on any problem. */
export async function loadConfigFile(path: string): Promise<GatewayConfig> {
  const format = formatFromPath(path);
  const text = await readConfigText(
    path,
    'config file not found; copy config/routes.example.yaml to get started',
  );
  return parseConfigText(text, format, { source: path });
}

/** Reads, parses and validates a clients file (ADR-0031). Throws {@link ConfigError} on any problem. */
export async function loadClientsFile(path: string): Promise<ClientsConfig> {
  const format = formatFromPath(path);
  const text = await readConfigText(
    path,
    'clients file not found; copy config/clients.example.yaml or run `pnpm keygen` (ADR-0031)',
  );
  return parseClients(parseText(text, format, { source: path }), { source: path });
}

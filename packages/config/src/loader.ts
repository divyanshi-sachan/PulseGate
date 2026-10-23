import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseDocument } from 'yaml';
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

/** Validates already-parsed config data. The result is deeply frozen (read-only at runtime, ADR-0003). */
export function parseConfig(input: unknown, options: ParseOptions = {}): GatewayConfig {
  const result = gatewayConfigSchema.safeParse(input);
  if (!result.success) throw new ConfigError(toConfigIssues(result.error, input), options.source);
  return deepFreeze(result.data);
}

/** Parses YAML or JSON text, then validates it. */
export function parseConfigText(
  text: string,
  format: ConfigFormat,
  options: ParseOptions = {},
): GatewayConfig {
  let data: unknown;
  if (format === 'yaml') {
    const document = parseDocument(text);
    if (document.errors.length > 0) {
      throw new ConfigError(
        document.errors.map((error) => ({ path: '(syntax)', message: error.message })),
        options.source,
      );
    }
    data = document.toJS();
  } else {
    try {
      data = JSON.parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConfigError([{ path: '(syntax)', message }], options.source);
    }
  }
  return parseConfig(data, options);
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
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message =
      code === 'ENOENT'
        ? 'config file not found; copy config/routes.example.yaml to get started'
        : `cannot read config file (${code ?? 'unknown error'})`;
    throw new ConfigError([{ path: '(file)', message }], path);
  }
  return parseConfigText(text, format, { source: path });
}

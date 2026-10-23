import type { z } from 'zod';

export interface ConfigIssue {
  /** Location in the config, e.g. `routes[1] ("create-orders").upstreamId`. */
  path: string;
  message: string;
}

/** Thrown when configuration cannot be read, parsed or validated. Startup must abort (ADR-0003). */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly issues: readonly ConfigIssue[];
  readonly source: string | undefined;

  constructor(issues: readonly ConfigIssue[], source?: string) {
    const where = source === undefined ? '' : ` in ${source}`;
    const count = issues.length === 1 ? '1 problem' : `${String(issues.length)} problems`;
    const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
    super([`Invalid gateway configuration${where} (${count}):`, ...lines].join('\n'));
    this.issues = issues;
    this.source = source;
  }
}

/** Hints for keys that older drafts of the specs used, keyed by "<section>.<key>". */
const UNKNOWN_KEY_HINTS: Record<string, string> = {
  'routes.upstream':
    'routes reference an upstream by "upstreamId"; define its URL under top-level "upstreams" (ADR-0013)',
  'routes.authRequired': 'use "auth: { required: true }" (ADR-0014)',
  'clients.keys.key':
    'never store raw API keys; put only the SHA-256 digest under "sha256" (run `pnpm keygen`, ADR-0031)',
  'clients.keys.apiKey':
    'never store raw API keys; put only the SHA-256 digest under "sha256" (run `pnpm keygen`, ADR-0031)',
  'clients.key':
    'never store raw API keys; put only the SHA-256 digest under "sha256" (run `pnpm keygen`, ADR-0031)',
  'clients.apiKey':
    'never store raw API keys; put only the SHA-256 digest under "sha256" (run `pnpm keygen`, ADR-0031)',
  'routes.circuitBreaker':
    'circuit-breaker settings belong on "upstreams[]" or the top-level "circuitBreaker" block (ADR-0015)',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Formats a Zod path, naming list entries by their `id` when the input has one. */
export function formatPath(path: readonly PropertyKey[], input: unknown): string {
  if (path.length === 0) return '(root)';
  let out = '';
  let node: unknown = input;
  for (const key of path) {
    if (typeof key === 'number') {
      out += `[${String(key)}]`;
      node = Array.isArray(node) ? (node[key] as unknown) : undefined;
      const id = isRecord(node) ? node['id'] : undefined;
      if (typeof id === 'string') out += ` ("${id}")`;
    } else {
      out += out === '' ? String(key) : `.${String(key)}`;
      node = isRecord(node) ? node[key as string] : undefined;
    }
  }
  return out;
}

function sectionOf(path: readonly PropertyKey[]): string {
  return path.filter((key) => typeof key === 'string').join('.');
}

export function toConfigIssues(error: z.ZodError, input: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const hint = UNKNOWN_KEY_HINTS[`${sectionOf(issue.path)}.${key}`];
        issues.push({
          path: formatPath([...issue.path, key], input),
          message: hint === undefined ? 'unknown key (check for typos)' : `unknown key; ${hint}`,
        });
      }
      continue;
    }
    issues.push({ path: formatPath(issue.path, input), message: issue.message });
  }
  return issues;
}

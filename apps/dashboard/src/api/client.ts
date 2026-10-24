import {
  cacheResponseSchema,
  rateLimitsResponseSchema,
  routesResponseSchema,
  statsResponseSchema,
  upstreamsResponseSchema,
  type CacheResponse,
  type RateLimitsResponse,
  type RoutesResponse,
  type StatsResponse,
  type UpstreamsResponse,
} from '@pulsegate/admin-contract';
import type { z } from 'zod';

/**
 * - `unauthorized`: 401, the token was rejected; the UI returns to the token gate.
 * - `unreachable`: no HTTP response (network down, gateway stopped, timeout).
 * - `invalid-response`: a response that isn't JSON or doesn't match the shared contract. Never rendered.
 * - `http`: any other non-2xx status.
 */
export type ApiErrorKind = 'unauthorized' | 'unreachable' | 'invalid-response' | 'http';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  /** The gateway's normalized error code, when it sent one (ADR-0011). */
  readonly code: string | undefined;

  constructor(kind: ApiErrorKind, message: string, status?: number, code?: string) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

/** Plain function properties (no `this`), so screens can pass a loader around safely. */
export interface AdminApi {
  stats: (signal?: AbortSignal) => Promise<StatsResponse>;
  upstreams: (signal?: AbortSignal) => Promise<UpstreamsResponse>;
  routes: (signal?: AbortSignal) => Promise<RoutesResponse>;
  rateLimits: (signal?: AbortSignal) => Promise<RateLimitsResponse>;
  cache: (signal?: AbortSignal) => Promise<CacheResponse>;
}

export interface AdminApiOptions {
  token: string;
  /** Injected in tests; defaults to the browser's fetch. */
  fetch?: typeof globalThis.fetch;
  /** Same origin by default: the UI and the API share the admin listener (ADR-0037). */
  baseUrl?: string;
  /** Per-request timeout (default 10 s), so a hung gateway shows as unreachable instead of loading forever. */
  timeoutMs?: number;
}

function errorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const error = body.error;
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** First few contract violations as "path: message", for the console and the error state; never the data. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Typed client for `/admin/api/*`. Every response is validated with the same Zod schemas the gateway's tests
 * use (`@pulsegate/admin-contract`), so a contract drift is an explicit error, never a silently wrong chart.
 */
export function createAdminApi(options: AdminApiOptions): AdminApi {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.baseUrl ?? '';
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${base}/admin/api/${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' },
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      // A caller's own abort is not a failure to report; let it propagate as-is.
      if (signal?.aborted === true) throw error;
      throw new ApiError('unreachable', 'The admin API could not be reached');
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (response.status === 401) {
      throw new ApiError('unauthorized', 'The admin token was rejected', 401, errorCode(body));
    }
    if (!response.ok) {
      throw new ApiError(
        'http',
        `The admin API answered ${String(response.status)}`,
        response.status,
        errorCode(body),
      );
    }
    if (body === undefined) {
      throw new ApiError('invalid-response', 'The admin API did not return JSON', response.status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        'invalid-response',
        `The admin API response does not match the contract (${describeIssues(parsed.error)})`,
        response.status,
      );
    }
    return parsed.data;
  }

  return {
    stats: (signal) => get('stats', statsResponseSchema, signal),
    upstreams: (signal) => get('upstreams', upstreamsResponseSchema, signal),
    routes: (signal) => get('routes', routesResponseSchema, signal),
    rateLimits: (signal) => get('rate-limits', rateLimitsResponseSchema, signal),
    cache: (signal) => get('cache', cacheResponseSchema, signal),
  };
}

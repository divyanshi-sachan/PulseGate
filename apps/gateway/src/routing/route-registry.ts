import type { RouteConfig } from '@pulsegate/config';
import { GatewayError } from '@pulsegate/shared';

export interface RouteMatch {
  route: RouteConfig;
  /** Path to append to the upstream base path (prefix removed when stripPrefix is set). */
  forwardedPath: string;
}

interface PrefixEntry {
  prefix: string;
  byMethod: ReadonlyMap<string, RouteConfig>;
  allow: string;
}

function matchesPrefix(prefix: string, rawPath: string): boolean {
  return prefix === '/' || rawPath === prefix || rawPath.startsWith(`${prefix}/`);
}

/**
 * Matches requests to routes (ADR-0017): segment-aware longest prefix first, then method.
 * Matching is byte-for-byte on the raw path (ADR-0019), so encoded spellings never match.
 */
export class RouteRegistry {
  readonly #entries: readonly PrefixEntry[];

  constructor(routes: readonly RouteConfig[]) {
    const grouped = new Map<string, Map<string, RouteConfig>>();
    for (const route of routes) {
      const byMethod = grouped.get(route.pathPrefix) ?? new Map<string, RouteConfig>();
      for (const method of route.methods) byMethod.set(method, route);
      grouped.set(route.pathPrefix, byMethod);
    }
    this.#entries = [...grouped]
      .map(([prefix, byMethod]) => ({
        prefix,
        byMethod,
        allow: [...byMethod.keys()].sort().join(', '),
      }))
      .sort((a, b) => b.prefix.length - a.prefix.length);
  }

  /** Throws ROUTE_NOT_FOUND (404) or METHOD_NOT_ALLOWED (405, with `allow`) when nothing matches. */
  match(method: string, rawPath: string): RouteMatch {
    const entry = this.#entries.find(({ prefix }) => matchesPrefix(prefix, rawPath));
    if (entry === undefined) throw new GatewayError('ROUTE_NOT_FOUND');

    const route = entry.byMethod.get(method);
    if (route === undefined) throw new MethodNotAllowedError(entry.allow);

    let forwardedPath = rawPath;
    if (route.stripPrefix && route.pathPrefix !== '/') {
      forwardedPath = rawPath.slice(route.pathPrefix.length) || '/';
    }
    return { route, forwardedPath };
  }
}

/** 405 carrying the value for the `Allow` response header (ADR-0017). */
export class MethodNotAllowedError extends GatewayError {
  readonly allow: string;

  constructor(allow: string) {
    super('METHOD_NOT_ALLOWED');
    this.allow = allow;
  }
}

import { realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { GatewayError } from '@pulsegate/shared';
import { parseRequestTarget } from '../routing/request-target.ts';

/** Where the dashboard is served on the admin listener (ADR-0037). */
export const UI_PREFIX = '/admin/ui/';

/** Only these file types are ever served; anything else in the build directory is a 404. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Vite writes content-hashed files under assets/, so they can be cached forever. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Everything else (index.html above all) must be revalidated so a new build shows up at once. */
const REVALIDATE = 'no-cache';

export interface UiFile {
  /** Absolute path inside the real UI root. */
  path: string;
  size: number;
  contentType: string;
  cacheControl: string;
}

function badRequest(publicMessage: string): GatewayError {
  return new GatewayError('BAD_REQUEST', { publicMessage });
}

/**
 * Maps `/admin/ui/<path>` to a file in the dashboard build (plan §5), or fails closed:
 * - the raw path passes the proxy's rules first (ADR-0019: no `\`, bad %-encoding, `.`/`..` even encoded);
 * - each decoded segment must be non-empty, without `/`, `\`, NUL or a leading `.` (no hidden files, no
 *   encoded separators, no `//` absolute-path tricks);
 * - the resolved real path (symlinks followed) must stay inside the real root;
 * - only allow-listed extensions are served.
 * A path without an extension that matches no file gets `index.html` (client-side routes); a missing
 * asset is a 404, never the HTML page.
 */
export class StaticUi {
  readonly #root: string;
  #realRoot: string | undefined;

  constructor(root: string) {
    this.#root = root;
  }

  async #rootDir(): Promise<string> {
    this.#realRoot ??= await realpath(this.#root);
    return this.#realRoot;
  }

  /** Startup check: the directory exists and holds an index.html (a configured but missing build fails startup). */
  async check(): Promise<boolean> {
    try {
      return (await this.#file(await this.#rootDir(), 'index.html')) !== undefined;
    } catch {
      return false;
    }
  }

  async resolve(rawUrl: string): Promise<UiFile> {
    const { rawPath } = parseRequestTarget(rawUrl);
    if (!rawPath.startsWith(UI_PREFIX)) throw new GatewayError('ROUTE_NOT_FOUND');
    const rest = rawPath.slice(UI_PREFIX.length);
    const segments: string[] = [];
    if (rest !== '') {
      for (const raw of rest.split('/')) {
        let segment: string;
        try {
          segment = decodeURIComponent(raw);
        } catch {
          throw badRequest('Request target contains invalid percent-encoding');
        }
        if (segment === '' || /[/\\\0]/.test(segment) || segment.startsWith('.')) {
          throw badRequest('Invalid admin UI path');
        }
        segments.push(segment);
      }
    }
    const root = await this.#rootDir();
    const requested = segments.length === 0 ? 'index.html' : join(...segments);
    const found = await this.#file(root, requested);
    if (found !== undefined) return found;
    // Client-side routes have no extension; a missing asset must not turn into an HTML page.
    if (extname(requested) === '') {
      const index = await this.#file(root, 'index.html');
      if (index !== undefined) return index;
    }
    throw new GatewayError('ROUTE_NOT_FOUND');
  }

  async #file(root: string, relative: string): Promise<UiFile | undefined> {
    const contentType = CONTENT_TYPES[extname(relative).toLowerCase()];
    if (contentType === undefined) return undefined;
    let real: string;
    try {
      real = await realpath(join(root, relative));
    } catch {
      return undefined;
    }
    // Defense in depth: a symlink in the build must not lead outside it.
    if (!real.startsWith(root + sep)) return undefined;
    const info = await stat(real);
    if (!info.isFile()) return undefined;
    const hashed = relative.startsWith(`assets${sep}`);
    return {
      path: real,
      size: info.size,
      contentType,
      cacheControl: hashed ? IMMUTABLE : REVALIDATE,
    };
  }
}

/**
 * Headers for every UI response (plan §5): a strict same-origin CSP with no inline scripts or styles,
 * no framing, no referrer, no MIME sniffing.
 */
export const UI_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

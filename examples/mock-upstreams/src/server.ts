import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * Mock upstream for local development and failure demos. Behavior is controlled per request with
 * "_"-prefixed query parameters, which PulseGate forwards verbatim (ADR-0019), so faults can be
 * triggered through the gateway with plain curl:
 *
 *   _delay=<ms>        wait before responding (max 60000)
 *   _status=<code>     respond with this status (100-599)
 *   _failRate=<0..1>   respond 503 with this probability
 *   _failTimes=<n>     with _key=<k>: respond 503 to the first n requests carrying that key, then normally.
 *                      Deterministic, for retry and breaker-recovery tests; use a fresh key per test run
 *   _reset=1           destroy the connection without a response
 *   _bytes=<n>         stream n bytes of "x" (chunked) instead of the JSON echo
 *   _contentLength=1   with _bytes, send Content-Length up front
 *
 * Any other request gets a JSON echo of what the upstream received. GET /healthz is a liveness probe.
 */
export interface MockOptions {
  /** Reported in every echo, e.g. "orders". */
  name: string;
  /** Random source for _failRate; injectable for tests. */
  random?: () => number;
}

const MAX_DELAY_MS = 60_000;
/** Distinct `_key` counters kept for `_failTimes`; the least recently used is dropped beyond this. */
export const MAX_FAIL_KEYS = 1000;
const MAX_FAIL_TIMES = 1000;
const MAX_ECHO_BODY_BYTES = 64 * 1024;
const MAX_STREAM_BYTES = 1024 * 1024 * 1024;
const CHUNK = Buffer.alloc(16 * 1024, 'x');

function intParam(
  params: URLSearchParams,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function streamBytes(
  res: ServerResponse,
  status: number,
  total: number,
  withLength: boolean,
): void {
  res.writeHead(status, {
    'content-type': 'text/plain',
    ...(withLength ? { 'content-length': total } : {}),
  });
  let sent = 0;
  const pump = (): void => {
    while (sent < total) {
      const chunk = CHUNK.subarray(0, Math.min(CHUNK.length, total - sent));
      sent += chunk.length;
      if (!res.write(chunk)) {
        res.once('drain', pump);
        return;
      }
    }
    res.end();
  };
  res.on('error', () => undefined);
  pump();
}

async function readBody(req: IncomingMessage): Promise<{ text: string; bytes: number }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes <= MAX_ECHO_BODY_BYTES) chunks.push(buffer);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes };
}

/** Requests seen per `_key`, bounded (LRU by insertion order refresh). */
class KeyCounter {
  readonly #seen = new Map<string, number>();

  /** Counts this request and returns how many came before it with the same key. */
  next(key: string): number {
    const before = this.#seen.get(key) ?? 0;
    this.#seen.delete(key);
    this.#seen.set(key, before + 1);
    if (this.#seen.size > MAX_FAIL_KEYS) {
      const oldest = this.#seen.keys().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return before;
  }

  get size(): number {
    return this.#seen.size;
  }
}

export function createMockServer(options: MockOptions): Server & { failKeys: () => number } {
  const random = options.random ?? Math.random;
  const counter = new KeyCounter();

  const server = createServer((req, res) => {
    void (async () => {
      const rawUrl = req.url ?? '/';
      const params = new URL(rawUrl, 'http://mock').searchParams;

      if (req.method === 'GET' && rawUrl === '/healthz') {
        sendJson(res, 200, { status: 'ok', service: options.name });
        return;
      }

      const body = await readBody(req);
      const delay = intParam(params, '_delay', 0, MAX_DELAY_MS) ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

      if (params.get('_reset') === '1') {
        req.socket.destroy();
        return;
      }

      let status = intParam(params, '_status', 100, 599) ?? 200;
      const failRate = Number(params.get('_failRate') ?? '0');
      if (failRate > 0 && random() < failRate) status = 503;
      const failTimes = intParam(params, '_failTimes', 1, MAX_FAIL_TIMES);
      const key = params.get('_key');
      if (failTimes !== undefined && key !== null && key !== '' && counter.next(key) < failTimes) {
        status = 503;
      }

      const bytes = intParam(params, '_bytes', 0, MAX_STREAM_BYTES);
      if (bytes !== undefined) {
        streamBytes(res, status, bytes, params.get('_contentLength') === '1');
        return;
      }

      sendJson(res, status, {
        service: options.name,
        method: req.method,
        url: rawUrl,
        headers: req.headers,
        body: body.text,
        bodyBytes: body.bytes,
      });
    })().catch(() => {
      res.destroy();
    });
  });
  return Object.assign(server, { failKeys: () => counter.size });
}

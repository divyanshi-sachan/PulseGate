import { once } from 'node:events';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';

export type ProxyMode = 'pass' | 'cut' | 'stall';

/**
 * A TCP proxy that can simulate dependency outages deterministically:
 * - `cut()`: drop every connection and refuse new ones (connection refused/reset).
 * - `stall()`: keep connections open but stop forwarding bytes (commands time out).
 * - `restore()`: forward normally again; stalled connections are dropped so clients reconnect.
 */
export class TcpProxy {
  readonly #server = createServer((client) => {
    this.#accept(client);
  });
  readonly #pairs = new Set<{ client: Socket; upstream: Socket }>();
  #mode: ProxyMode = 'pass';
  #port = 0;

  readonly #targetHost: string;
  readonly #targetPort: number;

  private constructor(targetHost: string, targetPort: number) {
    this.#targetHost = targetHost;
    this.#targetPort = targetPort;
  }

  static async start(targetHost: string, targetPort: number): Promise<TcpProxy> {
    const proxy = new TcpProxy(targetHost, targetPort);
    proxy.#server.listen(0, '127.0.0.1');
    await once(proxy.#server, 'listening');
    proxy.#port = (proxy.#server.address() as AddressInfo).port;
    return proxy;
  }

  get port(): number {
    return this.#port;
  }

  get mode(): ProxyMode {
    return this.#mode;
  }

  cut(): void {
    this.#mode = 'cut';
    this.#dropAll();
  }

  stall(): void {
    this.#mode = 'stall';
  }

  restore(): void {
    const wasStalled = this.#mode === 'stall';
    this.#mode = 'pass';
    if (wasStalled) this.#dropAll();
  }

  async close(): Promise<void> {
    this.#dropAll();
    this.#server.close();
    await once(this.#server, 'close');
  }

  #accept(client: Socket): void {
    if (this.#mode === 'cut') {
      client.destroy();
      return;
    }
    const upstream = connect(this.#targetPort, this.#targetHost);
    const pair = { client, upstream };
    this.#pairs.add(pair);
    const forward = (from: Socket, to: Socket) => {
      from.on('data', (chunk: Buffer) => {
        if (this.#mode === 'pass') to.write(chunk);
      });
    };
    forward(client, upstream);
    forward(upstream, client);
    const drop = () => {
      client.destroy();
      upstream.destroy();
      this.#pairs.delete(pair);
    };
    for (const socket of [client, upstream]) {
      socket.on('error', drop);
      socket.on('close', drop);
    }
  }

  #dropAll(): void {
    for (const { client, upstream } of this.#pairs) {
      client.destroy();
      upstream.destroy();
    }
    this.#pairs.clear();
  }
}

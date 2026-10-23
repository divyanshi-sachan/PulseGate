import type { UpstreamConfig } from '@pulsegate/config';
import { Pool, type Dispatcher } from 'undici';

export interface RegisteredUpstream {
  config: UpstreamConfig;
  dispatcher: Dispatcher;
}

export interface UpstreamRegistryOptions {
  /** Max concurrent connections per upstream (bounded resources, system_design §5). */
  connectionsPerUpstream?: number;
}

/** Resolves upstream ids to their validated config and a pooled HTTP client (ADR-0013). */
export class UpstreamRegistry {
  readonly #upstreams = new Map<string, RegisteredUpstream>();

  constructor(upstreams: readonly UpstreamConfig[], options: UpstreamRegistryOptions = {}) {
    const connections = options.connectionsPerUpstream ?? 128;
    for (const config of upstreams) {
      this.#upstreams.set(config.id, {
        config,
        dispatcher: new Pool(config.origin, { connections }),
      });
    }
  }

  /** Config validation guarantees every route's upstreamId exists, so a miss is a programming error. */
  getById(id: string): RegisteredUpstream {
    const upstream = this.#upstreams.get(id);
    if (upstream === undefined) throw new Error(`Unknown upstream "${id}"`);
    return upstream;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#upstreams.values()].map(({ dispatcher }) => dispatcher.close()));
  }
}

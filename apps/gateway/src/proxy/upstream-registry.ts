import type { UpstreamConfig } from '@pulsegate/config';
import { TargetSet, type TargetState } from '@pulsegate/reliability';
import { Pool, type Dispatcher } from 'undici';

/** One replica of an upstream: its own validated URL parts and connection pool (ADR-0051). */
export interface RegisteredTarget {
  /** `t0`, `t1`, ... in configuration order; bounded by config, so safe as a metric label. */
  id: string;
  baseUrl: string;
  basePath: string;
  dispatcher: Dispatcher;
}

export interface RegisteredUpstream {
  config: UpstreamConfig;
  /** In configuration order; `TargetSet` indexes refer to this array. */
  targets: readonly RegisteredTarget[];
  /** Chooses a target per attempt and ejects failing ones (passive outlier detection). */
  selector: TargetSet;
}

export interface UpstreamRegistryOptions {
  /** Max concurrent connections per target (bounded resources, system_design §5). */
  connectionsPerTarget?: number;
  /** Monotonic milliseconds for ejection timing (default `performance.now`); fake in tests. */
  now?: () => number;
  /** Called on every target state change, e.g. for metrics and logs (ADR-0051). */
  onTargetStateChange?: (
    upstreamId: string,
    change: { id: string; from: TargetState; to: TargetState },
  ) => void;
}

/** Resolves upstream ids to their validated config, targets and pooled HTTP clients (ADR-0013, ADR-0051). */
export class UpstreamRegistry {
  readonly #upstreams = new Map<string, RegisteredUpstream>();

  constructor(upstreams: readonly UpstreamConfig[], options: UpstreamRegistryOptions = {}) {
    const connections = options.connectionsPerTarget ?? 128;
    for (const config of upstreams) {
      const targets: RegisteredTarget[] = config.targets.map((target) => ({
        id: target.id,
        baseUrl: target.baseUrl,
        basePath: target.basePath,
        dispatcher: new Pool(target.origin, { connections }),
      }));
      const selector = new TargetSet({
        ids: targets.map((target) => target.id),
        algorithm: config.loadBalancing,
        ejection: config.outlierEjection,
        ...(options.now === undefined ? {} : { now: options.now }),
        onStateChange: (change) => {
          options.onTargetStateChange?.(config.id, change);
        },
      });
      this.#upstreams.set(config.id, { config, targets, selector });
    }
  }

  /** Config validation guarantees every route's upstreamId exists, so a miss is a programming error. */
  getById(id: string): RegisteredUpstream {
    const upstream = this.#upstreams.get(id);
    if (upstream === undefined) throw new Error(`Unknown upstream "${id}"`);
    return upstream;
  }

  all(): readonly RegisteredUpstream[] {
    return [...this.#upstreams.values()];
  }

  /** Waits for in-flight upstream requests to finish, then closes the pools. */
  async close(): Promise<void> {
    await Promise.all(this.#dispatchers().map((dispatcher) => dispatcher.close()));
  }

  /** Aborts in-flight upstream requests and closes the pools immediately. */
  async destroy(): Promise<void> {
    await Promise.all(this.#dispatchers().map((dispatcher) => dispatcher.destroy()));
  }

  #dispatchers(): Dispatcher[] {
    return [...this.#upstreams.values()].flatMap((upstream) =>
      upstream.targets.map((target) => target.dispatcher),
    );
  }
}

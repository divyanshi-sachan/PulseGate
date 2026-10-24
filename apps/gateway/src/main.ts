import { access } from 'node:fs/promises';
import {
  assertClientsForAuth,
  ConfigError,
  loadClientsFile,
  loadConfigFile,
  type ClientsConfig,
  type GatewayConfig,
} from '@pulsegate/config';
import { createGateway } from './app.ts';

const configPath = process.env['PULSEGATE_CONFIG'] ?? 'config/routes.yaml';
const clientsPath = process.env['PULSEGATE_CLIENTS'] ?? 'config/clients.yaml';

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

let config: GatewayConfig;
let clients: ClientsConfig | undefined;
try {
  config = await loadConfigFile(configPath);
  // The clients file is optional only when no route requires auth (ADR-0031).
  if (await exists(clientsPath)) clients = await loadClientsFile(clientsPath);
  assertClientsForAuth(config, clients, clientsPath);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const redisUrl = process.env['REDIS_URL'];
const gateway = createGateway(config, {
  ...(clients === undefined ? {} : { clients }),
  ...(redisUrl === undefined ? {} : { redisUrl }),
});
try {
  await gateway.start();
} catch (error) {
  // e.g. Redis unreachable at boot (ADR-0034): exit non-zero so the orchestrator restarts us.
  gateway.public.log.error(
    { err: error instanceof Error ? error.message : String(error) },
    'startup failed',
  );
  await gateway.close().catch(() => undefined);
  process.exit(1);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    gateway.public.log.info({ signal }, 'shutting down');
    gateway.close().then(
      ({ forced }) => {
        gateway.public.log.info({ forced }, 'shutdown complete');
        process.exit(0);
      },
      (error: unknown) => {
        gateway.public.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}

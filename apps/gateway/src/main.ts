import { ConfigError, loadConfigFile } from '@pulsegate/config';
import { createGateway } from './app.ts';

const configPath = process.env['PULSEGATE_CONFIG'] ?? 'config/routes.yaml';

let config;
try {
  config = await loadConfigFile(configPath);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const gateway = createGateway(config);
await gateway.start();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    gateway.public.log.info({ signal }, 'shutting down');
    gateway.close().then(
      () => process.exit(0),
      (error: unknown) => {
        gateway.public.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}

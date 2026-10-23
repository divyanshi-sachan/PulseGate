import { createMockServer } from './server.ts';

const name = process.env['SERVICE_NAME'] ?? 'mock';
const host = process.env['HOST'] ?? '0.0.0.0';
const port = Number(process.env['PORT'] ?? '4001');

const server = createMockServer({ name });
server.listen(port, host, () => {
  console.log(JSON.stringify({ msg: 'mock upstream listening', service: name, host, port }));
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}

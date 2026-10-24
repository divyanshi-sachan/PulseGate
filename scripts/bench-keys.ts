/**
 * Per-run API keys for the k6 suite (ADR-0046): written only into the run directory (git-ignored), never committed.
 * keys.json holds the raw keys for k6; clients.yaml holds only their SHA-256 digests for the gateway (ADR-0031).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateApiKey, hashApiKey } from '../apps/gateway/src/auth/api-key.ts';

const dir = process.argv[2];
if (dir === undefined) throw new Error('usage: node scripts/bench-keys.ts <run-dir>');

const auth = generateApiKey();
const limited = Array.from({ length: 10 }, () => generateApiKey());
const clients = [
  { id: 'bench-auth', keys: [auth] },
  ...limited.map((key, i) => ({ id: `bench-subject-${String(i)}`, keys: [key] })),
];
const yaml = [
  '# Generated per benchmark run by scripts/bench-keys.ts; digests only.',
  'clients:',
  ...clients.flatMap((c) => [
    `  - id: ${c.id}`,
    '    keys:',
    ...c.keys.map((k) => `      - { id: k1, sha256: '${hashApiKey(k)}' }`),
  ]),
  '',
].join('\n');

await writeFile(join(dir, 'keys.json'), JSON.stringify({ auth, limited }), { mode: 0o600 });
await writeFile(join(dir, 'clients.yaml'), yaml);

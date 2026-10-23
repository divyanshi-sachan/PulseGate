import { parseArgs } from 'node:util';
import { generateApiKey, hashApiKey } from './auth/api-key.ts';

/**
 * Generates an API key and the clients-file snippet that stores its SHA-256 digest (ADR-0031).
 * Usage: pnpm keygen [--client <id>] [--key-id <id>] [--expires <ISO 8601>]
 */
const { values } = parseArgs({
  options: {
    client: { type: 'string', default: 'my-client' },
    'key-id': { type: 'string', default: new Date().toISOString().slice(0, 7) },
    expires: { type: 'string' },
  },
});

const key = generateApiKey();
const lines = [
  'API key (shown once; give it to the client and store it in a secret manager):',
  '',
  `  ${key}`,
  '',
  'Add this to your clients file (config/clients.yaml). It stores only the SHA-256 digest:',
  '',
  'clients:',
  `  - id: ${values.client}`,
  '    keys:',
  `      - id: "${values['key-id']}"`,
  `        sha256: "${hashApiKey(key)}"`,
];
if (values.expires !== undefined) lines.push(`        expiresAt: "${values.expires}"`);
console.log(lines.join('\n'));

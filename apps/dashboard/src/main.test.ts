// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('entry module order (ADR-0043)', () => {
  it('imports zod-config before anything that builds schemas, so Zod never probes eval under the CSP', () => {
    const source = readFileSync(new URL('main.tsx', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import\s.*?['"](.+?)['"];?$/gm)].map((m) => m[1]);
    expect(imports[0]).toBe('./zod-config.ts');
  });

  it('sets Zod to jitless', async () => {
    const { z } = await import('zod');
    await import('./zod-config.ts');
    expect(z.config().jitless).toBe(true);
  });
});

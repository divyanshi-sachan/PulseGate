import { defineConfig } from 'vitest/config';

// Opt-in suite against real public APIs (`pnpm test:real`, ADR-0045). Never part of `pnpm test` or PR CI:
// its files end in .real.ts, which the default config's globs don't match.
const conditions = ['@pulsegate/source', 'node', 'import', 'module', 'default'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@pulsegate/source'] } },
  test: {
    include: ['tests/real/**/*.real.ts'],
    environment: 'node',
    // Sequential by design: one provider request at a time, paced.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['verbose', ['json', { outputFile: 'test-results/real-apis.json' }]],
  },
});

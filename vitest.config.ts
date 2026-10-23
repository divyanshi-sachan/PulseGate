import { defineConfig } from 'vitest/config';

// Workspace packages export their TypeScript source under the "@pulsegate/source"
// condition (ADR-0025), so tests run against src without a build step.
const conditions = ['@pulsegate/source', 'node', 'import', 'module', 'default'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@pulsegate/source'] } },
  test: {
    include: ['{apps,packages,examples}/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});

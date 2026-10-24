import { defineConfig } from 'vitest/config';

// Workspace packages export their TypeScript source under the "@pulsegate/source"
// condition (ADR-0025), so tests run against src without a build step.
const conditions = ['@pulsegate/source', 'node', 'import', 'module', 'default'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@pulsegate/source'] } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: [
            '{apps,packages,examples}/*/{src,test}/**/*.test.ts',
            'tests/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
          exclude: ['apps/dashboard/**', '**/node_modules/**'],
          environment: 'node',
        },
      },
      // Browser code: jsdom, React plugin (apps/dashboard/vitest.config.ts).
      'apps/dashboard',
    ],
  },
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { UI_BASE } from './src/app/base.ts';

// Served by the gateway's admin listener at /admin/ui/ (ADR-0037, ADR-0040).
export default defineConfig({
  base: UI_BASE,
  plugins: [react()],
  resolve: {
    // Workspace packages are bundled from their TypeScript source (ADR-0025).
    conditions: ['@pulsegate/source', 'browser', 'module', 'import', 'default'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Read by scripts/check-bundle.ts to compute the initial and total JS budget (plan §3).
    manifest: true,
    // Strict CSP (ADR-0040): never inline assets as data: scripts or styles.
    assetsInlineLimit: 0,
    sourcemap: true,
  },
  server: {
    // Local development against a running gateway: the API stays on the admin listener.
    proxy: { '/admin/api': 'http://127.0.0.1:9090' },
  },
});

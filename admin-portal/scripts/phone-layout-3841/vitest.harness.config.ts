/**
 * BACKLOG-3841: vitest config for the layout harness only (run.sh). Not used by
 * CI: the portal config includes only *.test.{ts,tsx}, and this one includes
 * only *.harness.tsx in this directory.
 */
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['scripts/phone-layout-3841/*.harness.tsx'],
    environment: 'jsdom',
    globals: true,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '../..') },
  },
});

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  // `.tsx` suites render components to a string. Without `jsx: 'automatic'`,
  // esbuild honours tsconfig's `jsx: "preserve"` (which Next needs) and emits
  // JSX that Node cannot execute.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    // `.tsx` has to be listed explicitly: with `**/*.test.ts` alone a component
    // render test is silently skipped and reports green by never running.
    include: ['**/*.test.{ts,tsx}'],
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // BACKLOG-3859: @keepr/shared maps to THIS checkout's source (also matches
      // '@keepr/shared/<sub>'). Without it, vitest follows node_modules/@keepr/shared,
      // a symlink that in a git worktree points at the main checkout's packages/shared.
      // Same reason: render THIS checkout's design-system, not the main checkout's.
      '@keepr/design-system': path.resolve(__dirname, '../packages/design-system/src'),
      '@keepr/shared': path.resolve(__dirname, '../packages/shared/src'),
    },
  },
});

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
    // ARRAY form so @keepr/ui can match the bare specifier only (BACKLOG-3502a).
    alias: [
      { find: '@', replacement: path.resolve(__dirname, '.') },
      // BACKLOG-3859: @keepr/shared maps to THIS checkout's source (also matches
      // '@keepr/shared/<sub>'). Without it, vitest follows node_modules/@keepr/shared,
      // a symlink that in a git worktree points at the main checkout's packages/shared.
      { find: '@keepr/shared', replacement: path.resolve(__dirname, '../packages/shared/src') },
      // BACKLOG-3502a: @keepr/ui likewise, but ONLY the bare specifier. A string
      // find would also rewrite '@keepr/ui/src/styles/theme.css' to
      // '.../src/index.ts/src/styles/theme.css' (ENOTDIR); subpaths keep
      // resolving through node_modules.
      { find: /^@keepr\/ui$/, replacement: path.resolve(__dirname, '../packages/ui/src/index.ts') },
    ],
  },
});

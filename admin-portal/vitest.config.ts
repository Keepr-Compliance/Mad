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
    },
  },
});

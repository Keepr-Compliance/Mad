import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';
import fs from 'fs';

/** Unconditionally delete .js.map files after build so source maps never ship. */
function deleteSourceMaps() {
  return {
    name: 'delete-source-maps',
    closeBundle: {
      sequential: true,
      order: 'post',
      handler() {
        const distDir = path.resolve(__dirname, 'dist');
        if (!fs.existsSync(distDir)) return;
        const files = fs.readdirSync(distDir, { recursive: true });
        let count = 0;
        for (const file of files) {
          if (typeof file === 'string' && file.endsWith('.js.map')) {
            fs.unlinkSync(path.join(distDir, file));
            count++;
          }
        }
        if (count > 0) {
          console.log(`[delete-source-maps] Removed ${count} source map file(s)`);
        }
      },
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    // Sentry source map upload (TASK-1967)
    // Only active during release builds when SENTRY_AUTH_TOKEN is available
    ...(process.env.SENTRY_AUTH_TOKEN ? [
      sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: 'keeprcompliancecom',
        project: 'electron',
        sourcemaps: {
          filesToDeleteAfterUpload: ['**/*.js.map'], // Don't ship source maps
        },
      }),
    ] : []),
    deleteSourceMaps(),
  ],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@electron': path.resolve(__dirname, './electron'),
      '@types': path.resolve(__dirname, './types'),
      // BACKLOG-3863 (SR R6): the kit and its tokens from THIS checkout, not
      // through node_modules (a worktree's node_modules points at another one).
      '@keepr/ui': path.resolve(__dirname, './packages/ui/src/index.ts'),
      '@keepr/design-system': path.resolve(__dirname, './packages/design-system/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true, // Enable sourcemaps for better debugging
    rollupOptions: {
      output: {
        manualChunks: {
          'react-joyride': ['react-joyride'],
          'dompurify': ['dompurify'],
          'canvas-confetti': ['canvas-confetti'],
        },
      },
    },
  },
  // Ensure TypeScript files are handled
  esbuild: {
    loader: 'tsx',
    include: /src\/.*\.[tj]sx?$/,
  },
});

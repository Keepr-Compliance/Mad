import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSentryConfig } from '@sentry/nextjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable React strict mode for better development
  reactStrictMode: true,

  // Transpile shared types from parent directory + the design-system package
  // (raw TS source, see packages/design-system/DESIGN-SYSTEM.md)
  transpilePackages: ['@shared', '@keepr/design-system'],

  webpack: (config) => {
    // @keepr/design-system is linked from ../packages (outside this app dir);
    // let its bare imports (react, lucide-react) fall back to this portal's
    // node_modules when webpack resolves from the package's real path.
    config.resolve.modules = [
      ...(config.resolve.modules ?? ['node_modules']),
      path.resolve(__dirname, 'node_modules'),
    ];
    return config;
  },

  async headers() {
    const cspDirectives = [
      "default-src 'self'",
      // unsafe-eval required in both dev (HMR) and prod (Clarity uses dynamic evaluation)
      "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://www.clarity.ms https://scripts.clarity.ms",
      "style-src 'self' 'unsafe-inline'",
      // blob: required for HEIC image conversion (AttachmentViewerModal, AttachmentList)
      "img-src 'self' data: blob: https:",
      // next/font/google downloads at build time and self-hosts - no external font CDN needed
      "font-src 'self'",
      // Supabase API and Realtime WebSocket connections
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.clarity.ms https://*.sentry.io",
      // PDF preview uses iframes with signed Supabase storage URLs
      "frame-src 'self' https://*.supabase.co",
      // Video preview uses <video src={signedUrl}> from Supabase storage
      "media-src 'self' https://*.supabase.co",
      // Supabase Realtime creates blob: workers for WebSocket connections
      "worker-src 'self' blob:",
      // Prevent clickjacking
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: cspDirectives,
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // Suppress source map upload logs during build
  silent: true,

  // Do not upload source maps unless SENTRY_AUTH_TOKEN is set
  disableServerWebpackPlugin: !process.env.SENTRY_AUTH_TOKEN,
  disableClientWebpackPlugin: !process.env.SENTRY_AUTH_TOKEN,

  // Hide source maps from the client bundle
  hideSourceMaps: true,
});

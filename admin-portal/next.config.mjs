import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSentryConfig } from '@sentry/nextjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },

  // The design-system and ui packages ship raw TS source (see
  // packages/design-system/DESIGN-SYSTEM.md and packages/ui/README.md)
  transpilePackages: ['@keepr/design-system', '@keepr/ui'],

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
    // Vercel Live feedback widget (preview/dev only) loads scripts from
    // vercel.live and opens a real-time channel via Pusher. The widget pulls
    // its JS, styles, and iframe from vercel.live and uses Pusher for the
    // comments channel. Allowing these in prod too is a tiny surface
    // expansion (one CDN + Pusher) and avoids an env-branched CSP.
    const cspDirectives = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://vercel.live",
      "style-src 'self' 'unsafe-inline' https://vercel.live",
      "img-src 'self' data: https:",
      "font-src 'self' data: https://vercel.live",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.sentry.io https://vercel.live https://*.pusher.com wss://*.pusher.com",
      "frame-src 'self' https://vercel.live",
      "worker-src 'self' blob:",
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

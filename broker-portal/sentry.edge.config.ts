import * as Sentry from '@sentry/nextjs';

/**
 * Sentry edge-runtime SDK initialization for broker-portal.
 *
 * Runs in the Vercel Edge Runtime (middleware, edge API routes).
 * Kept minimal — no Replay, no heavy integrations.
 */

Sentry.init({
  // Server-only DSN (BACKLOG-3849): turning on server reporting must not also
  // turn on the browser SDK, which reads NEXT_PUBLIC_SENTRY_DSN and records replays.
  dsn: process.env.SENTRY_DSN,

  enabled: !!process.env.SENTRY_DSN,

  tracesSampleRate: 0.1,
});

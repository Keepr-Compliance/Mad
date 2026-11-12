import * as Sentry from '@sentry/nextjs';
import { scrubBreadcrumb, scrubEvent, scrubSpan, scrubTransaction } from './lib/mcp/sentryScrub';

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

  // BACKLOG-4237/4238: middleware runs on /oauth; drop request headers, cookies,
  // body, query and env there, and redact Keepr OAuth credentials everywhere.
  beforeSend(event) {
    return scrubEvent(event);
  },
  beforeSendTransaction(event) {
    return scrubTransaction(event);
  },
  beforeSendSpan(span) {
    return scrubSpan(span);
  },
  beforeBreadcrumb(breadcrumb) {
    return scrubBreadcrumb(breadcrumb);
  },
});

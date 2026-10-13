import * as Sentry from '@sentry/nextjs';

/**
 * Next.js instrumentation hook (BACKLOG-3849).
 *
 * @sentry/nextjs 10 initialises server-side Sentry only from here: without this
 * file, sentry.server.config.ts and sentry.edge.config.ts are never loaded and
 * every server-side Sentry.capture* call is a no-op.
 *
 * Both configs send only when SENTRY_DSN is set on the deployment; unset, the
 * SDK initialises disabled and the app runs as before.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

/** Reports errors thrown by server components, route handlers and middleware. */
export const onRequestError = Sentry.captureRequestError;

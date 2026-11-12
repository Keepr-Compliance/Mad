import * as Sentry from '@sentry/nextjs';
import { scrubBreadcrumb, scrubEvent, scrubSpan, scrubTransaction } from './lib/mcp/sentryScrub';

/**
 * Sentry server-side SDK initialization for broker-portal.
 *
 * Runs in the Node.js runtime (API routes, server components, middleware).
 * No Replay integration — that is client-only.
 */

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function scrubEmails(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(EMAIL_REGEX, '[email]');
  }
  return value;
}

function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      result[key] = scrubEmails(val);
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      result[key] = scrubObject(val as Record<string, unknown>);
    } else if (Array.isArray(val)) {
      result[key] = val.map((item) =>
        typeof item === 'string'
          ? scrubEmails(item)
          : item && typeof item === 'object'
            ? scrubObject(item as Record<string, unknown>)
            : item
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}

Sentry.init({
  // Server-only DSN (BACKLOG-3849): turning on server reporting must not also
  // turn on the browser SDK, which reads NEXT_PUBLIC_SENTRY_DSN and records replays.
  dsn: process.env.SENTRY_DSN,

  enabled: !!process.env.SENTRY_DSN,

  tracesSampleRate: 0.1,

  // BACKLOG-4237/4238: no request headers, cookies, body, query or env for
  // /api/mcp and /oauth; Keepr OAuth credentials redacted everywhere. Each hook
  // fails closed on an MCP event (lib/mcp/sentryScrub.ts).
  beforeSend(event) {
    return scrubEvent(event, (e) => {
      if (e.message) {
        e.message = scrubEmails(e.message) as string;
      }

      if (e.exception?.values) {
        for (const ex of e.exception.values) {
          if (ex.value) {
            ex.value = scrubEmails(ex.value) as string;
          }
        }
      }

      if (e.breadcrumbs) {
        e.breadcrumbs = e.breadcrumbs.filter((crumb) => scrubBreadcrumb(crumb) !== null);
        for (const crumb of e.breadcrumbs) {
          if (crumb.message) {
            crumb.message = scrubEmails(crumb.message) as string;
          }
          if (crumb.data) {
            crumb.data = scrubObject(crumb.data as Record<string, unknown>);
          }
        }
      }

      if (e.user) {
        if (e.user.email) {
          e.user.email = '[email]';
        }
      }

      if (e.extra) {
        e.extra = scrubObject(e.extra as Record<string, unknown>);
      }
      if (e.tags) {
        e.tags = scrubObject(e.tags as Record<string, unknown>) as Record<string, string>;
      }

      return e;
    }, { dropOnFailure: true });
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

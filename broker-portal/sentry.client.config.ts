import * as Sentry from '@sentry/nextjs';
import { scrubBreadcrumb, scrubEvent, scrubSpan, scrubTransaction } from './lib/mcp/sentryScrub';

/**
 * Sentry client-side SDK initialization for broker-portal.
 *
 * This file is loaded by the @sentry/nextjs build plugin and runs
 * in the browser. The DSN is read from NEXT_PUBLIC_SENTRY_DSN so it
 * is available at build time via Next.js env inlining.
 */

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function scrubEmails(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(EMAIL_REGEX, '[email]');
  }
  return value;
}

/**
 * Recursively walk an object and replace email-like strings with [email].
 */
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
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Only enable when a DSN is configured
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Performance — keep sample rate low to avoid quota burn
  tracesSampleRate: 0.1,

  // Replay for debugging — capture 1% of sessions and 100% of errors
  replaysSessionSampleRate: 0.01,
  replaysOnErrorSampleRate: 1.0,

  integrations: [
    Sentry.replayIntegration(),
  ],

  // Strip emails from event payloads before they leave the browser.
  // BACKLOG-4238: the MCP / OAuth / consent-page scrub runs first; an event
  // whose processing throws is dropped (lib/mcp/sentryScrub.ts).
  beforeSend(event) {
    return scrubEvent(event, scrubEmailsFromEvent, { dropOnFailure: true });
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

function scrubEmailsFromEvent<E extends Sentry.ErrorEvent>(event: E): E {
  // Scrub message
  if (event.message) {
    event.message = scrubEmails(event.message) as string;
  }

  // Scrub exception values
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) {
        ex.value = scrubEmails(ex.value) as string;
      }
    }
  }

  // Scrub breadcrumb messages
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.filter((crumb) => scrubBreadcrumb(crumb) !== null);
    for (const crumb of event.breadcrumbs) {
      if (crumb.message) {
        crumb.message = scrubEmails(crumb.message) as string;
      }
      if (crumb.data) {
        crumb.data = scrubObject(crumb.data as Record<string, unknown>);
      }
    }
  }

  // Scrub user context
  if (event.user) {
    if (event.user.email) {
      event.user.email = '[email]';
    }
  }

  // Scrub extra and tags
  if (event.extra) {
    event.extra = scrubObject(event.extra as Record<string, unknown>);
  }
  if (event.tags) {
    event.tags = scrubObject(event.tags as Record<string, unknown>) as Record<string, string>;
  }

  return event;
}

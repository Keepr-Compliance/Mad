/**
 * Billing alerts (BACKLOG-3849).
 *
 * One call writes two places:
 *  - Sentry, as an error-level message tagged `billing_alert:<name>` and grouped
 *    per alert and mode. Server-side Sentry sends only when SENTRY_DSN is set on
 *    the deployment (see instrumentation.ts); without it this half is a no-op.
 *  - The function log, as one line starting `[billing-alert] <name>`. Vercel
 *    runtime logs keep it, but nothing watches or pages on them.
 *
 * `extra` must hold ids and counts only, never personal data or request headers.
 */

import * as Sentry from '@sentry/nextjs';
import type { StripeMode } from './mode';

export type BillingAlertName =
  | 'outbox_dead_letter'
  | 'outbox_unknown_kind'
  | 'outbox_stale';

export function billingAlert(
  name: BillingAlertName,
  mode: StripeMode,
  extra: Record<string, string | number | boolean | null> = {}
): void {
  console.error(`[billing-alert] ${name}`, { stripe_mode: mode, ...extra });
  Sentry.captureMessage(`billing alert: ${name}`, {
    level: 'error',
    tags: { billing_alert: name, stripe_mode: mode },
    fingerprint: ['billing_alert', name, mode],
    extra,
  });
}

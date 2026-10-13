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
  | 'outbox_stale'
  // BACKLOG-3848
  | 'card_update_pay_not_active'
  | 'end_now_cancel_failed'
  | 'agent_receipt_stripe_sent'
  // BACKLOG-3849 PR-2 (nightly reconcile + queue check)
  | 'reconcile_mismatch'
  | 'outbox_stale_daily'
  | 'outbox_parked'
  // BACKLOG-3878 (suspension pause / resume, SR R7 + R8)
  | 'paid_while_suspended'
  | 'suspended_subscription_unpaused'
  | 'paused_subscription_licence_active'
  // BACKLOG-3934 (a paying Agent who is also a brokerage member; support cancels + refunds)
  | 'agent_subscription_brokerage_member';

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

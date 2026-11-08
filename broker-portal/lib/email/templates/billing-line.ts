/**
 * The billing line of the reinstated emails — BACKLOG-4209 (founder copy, pm_comments on 4209).
 * Chosen by the outbox handler at send time from the deal and its Stripe subscription:
 *  - renews: auto-renew is on and the subscription is live.
 *  - ends:   auto-renew is off; endsOn is the period end ("Nov 27, 2026"), or null when it is
 *            unknown or already past (then the fallback wording).
 *  - none:   no subscription or it is canceled (founder ruling on SR D1): the line is left out.
 */

import type { BillingLine } from '../types';

export type { BillingLine };

export function billingLineText(b: BillingLine): string | null {
  if (b.kind === 'renews') return 'Your plan renews each month and is billed as before.';
  if (b.kind === 'ends') {
    return b.endsOn ? `Auto-renew is off. Your plan ends on ${b.endsOn}.` : 'Auto-renew is off. Your plan ends at the end of the billing period.';
  }
  return null;
}

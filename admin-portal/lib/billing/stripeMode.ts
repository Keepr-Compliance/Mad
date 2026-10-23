/**
 * Stripe mode of this admin-portal deployment (BACKLOG-3853 PR-2A).
 *
 * The broker portal derives its mode from the prefix of STRIPE_SECRET_KEY
 * (broker-portal/lib/billing/mode.ts). The admin portal never calls Stripe and
 * holds no Stripe key, so it reads a server-only STRIPE_MODE instead, with the
 * same rule: 'test' or 'live', and anything else throws. It never guesses, so an
 * unconfigured deployment cannot save a brokerage deal.
 *
 * Server-only: STRIPE_MODE is not a NEXT_PUBLIC_ variable.
 */

import type { StripeMode } from '@keepr/shared';

export type { StripeMode } from '@keepr/shared';

export function parseStripeMode(value: string | undefined | null): StripeMode {
  if (value === 'test' || value === 'live') return value;
  if (!value) throw new Error('STRIPE_MODE is not configured');
  throw new Error('STRIPE_MODE has an unrecognised value');
}

/** Mode this deployment saves brokerage deals in. Read on every call. */
export function adminStripeMode(): StripeMode {
  return parseStripeMode(process.env.STRIPE_MODE);
}

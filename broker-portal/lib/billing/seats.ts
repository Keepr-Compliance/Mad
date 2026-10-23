/**
 * Brokerage seats as the broker portal shows them — BACKLOG-3854.
 *
 * Read with the signed-in user's client through public.broker_get_seats (migration
 * 20261021020000), which counts with member_row_holds_seat (the seat trigger's own rule) and
 * decides can_add with the same refusals broker_add_seats enforces. The page never counts and
 * never decides can_add from a role. lib/users/seatAvailability.ts stays the invite dialog's
 * pre-check; this is the display source.
 */

import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listOpenInvoices, overdueOf, stripeNow } from './overdue';

export interface SeatsView {
  /** null = no seat limit. */
  bought: number | null;
  inUse: number;
  free: number | null;
  unlimited: boolean;
  canAdd: boolean;
  /** Why not, when canAdd is false: not_allowed, deal_canceling, invoice_overdue, deal_suspended, ... */
  reason: string | null;
  version: number | null;
  /** Broker/Admin only. */
  unitPriceCents: number | null;
  trialing: boolean;
  accountManagerEmail: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** null when the read fails or this person may not read it: the block then says so. */
export async function readSeats(client: SupabaseClient, organizationId: string): Promise<SeatsView | null> {
  try {
    const { data, error } = await client.rpc('broker_get_seats', { p_org: organizationId });
    if (error || !data) return null;
    const d = data as Record<string, unknown>;
    if (typeof d.in_use !== 'number') return null;
    return {
      bought: num(d.bought),
      inUse: d.in_use,
      free: num(d.free),
      unlimited: d.unlimited === true,
      canAdd: d.can_add === true,
      reason: typeof d.cannot_add_reason === 'string' ? d.cannot_add_reason : null,
      version: num(d.version),
      unitPriceCents: num(d.unit_price_cents),
      trialing: d.trialing === true,
      accountManagerEmail: typeof d.account_manager_email === 'string' ? d.account_manager_email : null,
    };
  } catch {
    return null;
  }
}

/** The live overdue check in the add-seats action gets this long; past it the add is refused. */
export const SEAT_OVERDUE_TIMEOUT_MS = 3000;

/**
 * Is any open invoice of this customer past due, read live from Stripe ("now" = the test clock in
 * TEST, the same rule as the suspension email and the Pay link)? 'unavailable' on error or
 * timeout: the caller refuses (fail closed). The database repeats the check from its webhook
 * mirror; this one catches an invoice whose webhook has not arrived yet.
 */
export async function liveOverdue(stripe: Stripe, customerId: string): Promise<'clear' | 'overdue' | 'unavailable'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'unavailable'>((resolve) => {
    timer = setTimeout(() => {
      console.error('[billing/seats] overdue check timed out');
      resolve('unavailable');
    }, SEAT_OVERDUE_TIMEOUT_MS);
  });
  const check = (async (): Promise<'clear' | 'overdue' | 'unavailable'> => {
    try {
      const [now, open] = await Promise.all([stripeNow({ stripe }, customerId), listOpenInvoices({ stripe }, customerId)]);
      return overdueOf(open, now).length > 0 ? 'overdue' : 'clear';
    } catch (e) {
      console.error('[billing/seats] overdue check unavailable:', (e as Error).message);
      return 'unavailable';
    }
  })();
  try {
    return await Promise.race([check, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Errors broker_add_seats (and the action) can return, as sentences. */
const MESSAGES: Record<string, string> = {
  not_authorized: 'Only a Broker or Admin can add seats.',
  impersonation: 'Write operations are not allowed during impersonation sessions',
  invalid_seats: 'Enter a number of seats from 1 to 10,000.',
  version_conflict: 'Your plan changed. Reload the page and try again.',
  invoice_overdue: 'Pay the overdue invoice to add seats.',
  stripe_unavailable: 'Stripe is unavailable right now. Try again in a minute.',
  deal_canceling: 'Your plan is ending, so seats cannot be added.',
  deal_suspended: 'Contact Keepr to change your plan.',
  deal_canceled: 'Your plan has ended. Contact support to restart it.',
  deal_not_started: 'Billing has not started yet.',
  no_deal: 'Billing has not started yet.',
  billing_not_live: 'Billing has not started yet.',
  seats_below_assigned: 'More people hold seats than your plan has. Contact your Keepr account manager.',
};

export function seatsErrorMessage(code: string | null | undefined): string {
  return (code && MESSAGES[code]) || 'Something went wrong. No seats were added.';
}

/** "$24.99" from cents. */
export function formatSeatPrice(cents: number | null): string | null {
  if (cents === null) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

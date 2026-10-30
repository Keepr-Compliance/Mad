/**
 * Is this user a member of a suspended brokerage? — BACKLOG-3853 PR-2.
 *
 * billing_purchase_blocked (PR-1, service role only) answers for the organization that decides
 * the user's billing (billing_deciding_org): true while that brokerage's deal is suspended.
 * The $14.99 purchase routes refuse with 403 account_suspended, the same answer a suspended
 * licence gets (BACKLOG-3878), before any quote, customer or Stripe call.
 *
 * Returns true / false, or null when the check failed: money paths refuse on null (fail closed).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** The only thing logged for a failed check: a static code, never the error. */
export const BROKERAGE_BLOCK_READ_FAILED = 'brokerage_block_read_failed';

export async function readBrokeragePurchaseBlocked(client: Pick<SupabaseClient, 'rpc'>, userId: string): Promise<boolean | null> {
  try {
    const { data, error } = await client.rpc('billing_purchase_blocked', { p_user: userId });
    if (error) return null;
    return data === true;
  } catch {
    return null;
  }
}

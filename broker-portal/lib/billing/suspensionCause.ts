/**
 * Why a suspended account is suspended — BACKLOG-3878. Copy only.
 *
 * suspend_account_for_dispute writes an `account_suspensions` row
 * (event_type 'suspended', stripe_dispute_id set); admin_suspend_user writes
 * none, and reinstate_suspended_account writes a 'reinstated' row. So the
 * latest row says "chargeback" only when it is a dispute suspension.
 *
 * Service client only: the table's one policy admits internal roles.
 * Soft: a failed read gives the wording without "after a chargeback".
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function suspendedForDispute(service: Pick<SupabaseClient, 'from'>, userId: string): Promise<boolean> {
  try {
    const { data, error } = await service
      .from('account_suspensions')
      .select('event_type, stripe_dispute_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error || !Array.isArray(data) || data.length === 0) return false;
    const latest = data[0] as { event_type?: string | null; stripe_dispute_id?: string | null };
    return latest.event_type === 'suspended' && !!latest.stripe_dispute_id;
  } catch {
    return false;
  }
}

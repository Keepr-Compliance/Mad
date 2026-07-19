/**
 * Account-suspension queries + input validation (BACKLOG-2077).
 *
 * Support-facing "account suspended by chargeback" surface on the user-detail
 * page. Two concerns live here so they can be unit-tested in node (vitest, no
 * jsdom), separate from the React component:
 *
 *   1. getSuspensionStatus(service, userId) — READ. Resolves whether the viewed
 *      user is currently suspended (licenses.status = 'suspended') and, if so,
 *      the most recent 'suspended' event from account_suspensions (reason, tx,
 *      amount, dispute id, date). Uses the service-role client (cross-user read).
 *
 *   2. validateReinstateReason(raw) — pure input check for the reinstate modal.
 *      A reason is REQUIRED (every lift is auditable), mirroring the server-side
 *      guard in reinstate_suspended_account.
 *
 * The actual mutation (reinstate) is a call to the internal-role-guarded
 * `reinstate_suspended_account` RPC via the BROWSER client (cookie session ->
 * auth.uid() -> has_internal_role), NOT service-role — mirrors admin_adjust_credits.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The most recent 'suspended' audit event for the viewed user, if any. */
export interface SuspensionEvent {
  id: string;
  reason: string;
  stripe_dispute_id: string | null;
  stripe_payment_intent_id: string | null;
  local_transaction_id: string | null;
  amount_cents: number | null;
  dispute_created_at: string | null;
  created_at: string;
}

/** Whether the user is suspended right now + the event that explains why. */
export interface SuspensionStatus {
  /** licenses.status === 'suspended'. Drives the desktop block + the UI banner. */
  isSuspended: boolean;
  /** The most recent 'suspended' event, or null (also null if never suspended). */
  event: SuspensionEvent | null;
  /** True when a read failed — never render "not suspended" on a failed read. */
  hasError: boolean;
}

// ---------------------------------------------------------------------------
// Reinstate reason validation
// ---------------------------------------------------------------------------

export interface ReinstateValidationValid {
  ok: true;
  /** Trimmed, non-empty reason, ready for the RPC. */
  reason: string;
}
export interface ReinstateValidationInvalid {
  ok: false;
  error: string;
}
export type ReinstateValidationResult =
  | ReinstateValidationValid
  | ReinstateValidationInvalid;

/**
 * A reason is required for every reinstatement (founder rule: every account
 * action is auditable). Empty / whitespace-only is rejected. Mirrors the
 * server-side guard so the operator sees the error before the network call.
 */
export function validateReinstateReason(raw: string): ReinstateValidationResult {
  const reason = raw.trim();
  if (reason.length === 0) {
    return { ok: false, error: 'A reason is required to reinstate an account.' };
  }
  return { ok: true, reason };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Resolve the viewed user's current suspension standing.
 *
 * isSuspended is authoritative from licenses.status (the switch the desktop app
 * honours). The event is best-effort context: a suspended user should normally
 * have a matching 'suspended' row, but we still report isSuspended=true even if
 * the audit read comes back empty (never hide a real block behind a missing row).
 */
export async function getSuspensionStatus(
  supabase: SupabaseClient,
  userId: string
): Promise<SuspensionStatus> {
  const [licenseRes, eventRes] = await Promise.all([
    supabase
      .from('licenses')
      .select('status')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('account_suspensions')
      .select(
        'id, reason, stripe_dispute_id, stripe_payment_intent_id, local_transaction_id, amount_cents, dispute_created_at, created_at'
      )
      .eq('user_id', userId)
      .eq('event_type', 'suspended')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const hasError = Boolean(licenseRes.error) || Boolean(eventRes.error);
  const isSuspended = licenseRes.data?.status === 'suspended';
  const event = (eventRes.data as SuspensionEvent | null) ?? null;

  return { isSuspended, event, hasError };
}

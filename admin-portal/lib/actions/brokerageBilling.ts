'use server';

/**
 * Server actions for the brokerage Billing card (BACKLOG-3853 PR-2A).
 *
 * Every call goes through the signed-in user's Supabase client, so the database
 * RPCs (admin_save_deal, admin_suspend_org, admin_reinstate_org) see auth.uid()
 * and check billing.manage / billing.suspend themselves. The Stripe mode comes
 * from this deployment (lib/billing/stripeMode.ts); without it nothing is saved.
 */

import { revalidatePath } from 'next/cache';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import { adminStripeMode, type StripeMode } from '@/lib/billing/stripeMode';
import { checkStartDate, dealErrorMessage, type OrgBilling } from '@/lib/billing/dealRules';

export interface ActionResult {
  ok: boolean;
  error: string | null;
}

export interface SaveDealInput {
  organizationId: string;
  seats: number;
  unitPriceCents: number;
  accountManagerId: string | null;
  reason: string;
  /** null when the organization has no deal yet. */
  expectedVersion: number | null;
  /**
   * BACKLOG-4007: yyyy-mm-dd start date, or null to keep the deal's date (today on a new deal).
   * Always sent as p_start_date: without the key PostgREST resolves the 9-arg wrapper,
   * which ignores any chosen date.
   */
  startDate: string | null;
}

type RpcResult = { success?: boolean; error?: string; pct_off?: number; cap_pct?: number; assigned?: number } | null;

function fromRpc(data: RpcResult, error: { code?: string; message?: string } | null): ActionResult {
  if (error) {
    return { ok: false, error: error.code === '42501' ? dealErrorMessage('not_authorized') : dealErrorMessage(null) };
  }
  if (data?.success) return { ok: true, error: null };
  return { ok: false, error: dealErrorMessage(data?.error, data ?? undefined) };
}

export async function saveDealAction(input: SaveDealInput): Promise<ActionResult> {
  let mode: StripeMode;
  try {
    mode = adminStripeMode();
  } catch {
    return { ok: false, error: dealErrorMessage('mode_not_configured') };
  }
  if (!input.reason.trim()) return { ok: false, error: dealErrorMessage('reason_required') };

  const { supabase, user } = await getAuthenticatedUser();
  if (!user) return { ok: false, error: dealErrorMessage('not_authorized') };

  // BACKLOG-3852: the 365-day cap, enforced here before the save. The business date and the
  // deal's current start date come from the database (admin_get_org_billing, session client),
  // never from the caller. An unchanged existing date stays allowed.
  if (input.startDate != null) {
    const read = await supabase.rpc('admin_get_org_billing', { p_org: input.organizationId });
    const billing = read.data as OrgBilling | null;
    if (read.error || !billing?.business_date) return { ok: false, error: dealErrorMessage(null) };
    const dateError = checkStartDate(input.startDate, billing.business_date, billing.deal?.start_date ?? null);
    if (dateError) return { ok: false, error: dealErrorMessage(dateError) };
  }

  const { data, error } = await supabase.rpc('admin_save_deal', {
    p_org: input.organizationId,
    p_stripe_mode: mode,
    p_seats: input.seats,
    p_unit_price_cents: input.unitPriceCents,
    // BACKLOG-4007 People v2: the billing contact is set in People / setup, never from the deal.
    p_billing_contact_name: null,
    p_billing_contact_email: null,
    p_account_manager_id: input.accountManagerId,
    p_reason: input.reason,
    p_expected_version: input.expectedVersion,
    p_start_date: input.startDate,
  });
  const result = fromRpc(data as RpcResult, error);
  if (result.ok) revalidatePath(`/dashboard/organizations/${input.organizationId}`);
  return result;
}

export async function suspendOrgAction(
  organizationId: string,
  reason: 'non_payment' | 'other',
  note: string
): Promise<ActionResult> {
  if (!note.trim()) return { ok: false, error: dealErrorMessage('note_required') };
  const { supabase, user } = await getAuthenticatedUser();
  if (!user) return { ok: false, error: dealErrorMessage('not_authorized') };
  const { data, error } = await supabase.rpc('admin_suspend_org', {
    p_org: organizationId,
    p_reason: reason,
    p_note: note.trim(),
  });
  const result = fromRpc(data as RpcResult, error);
  if (result.ok) revalidatePath(`/dashboard/organizations/${organizationId}`);
  return result;
}

/**
 * BACKLOG-4019: turn the deal's auto-renew off or back on. set_org_auto_renew checks
 * billing.manage itself and needs the note for staff; the version guards against a stale card.
 */
export async function setAutoRenewAction(
  organizationId: string,
  on: boolean,
  note: string,
  expectedVersion: number
): Promise<ActionResult> {
  if (!note.trim()) return { ok: false, error: dealErrorMessage('note_required') };
  const { supabase, user } = await getAuthenticatedUser();
  if (!user) return { ok: false, error: dealErrorMessage('not_authorized') };
  const { data, error } = await supabase.rpc('set_org_auto_renew', {
    p_org: organizationId,
    p_on: on,
    p_note: note.trim(),
    p_expected_version: expectedVersion,
  });
  const result = fromRpc(data as RpcResult, error);
  if (result.ok) revalidatePath(`/dashboard/organizations/${organizationId}`);
  return result;
}

export async function reinstateOrgAction(organizationId: string, note: string): Promise<ActionResult> {
  if (!note.trim()) return { ok: false, error: dealErrorMessage('note_required') };
  const { supabase, user } = await getAuthenticatedUser();
  if (!user) return { ok: false, error: dealErrorMessage('not_authorized') };
  const { data, error } = await supabase.rpc('admin_reinstate_org', {
    p_org: organizationId,
    p_note: note.trim(),
  });
  const result = fromRpc(data as RpcResult, error);
  if (result.ok) revalidatePath(`/dashboard/organizations/${organizationId}`);
  return result;
}

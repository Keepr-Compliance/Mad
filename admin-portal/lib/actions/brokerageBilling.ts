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
import { dealErrorMessage } from '@/lib/billing/dealRules';

export interface ActionResult {
  ok: boolean;
  error: string | null;
}

export interface SaveDealInput {
  organizationId: string;
  seats: number;
  unitPriceCents: number;
  billingContactName: string;
  billingContactEmail: string;
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

  const { data, error } = await supabase.rpc('admin_save_deal', {
    p_org: input.organizationId,
    p_stripe_mode: mode,
    p_seats: input.seats,
    p_unit_price_cents: input.unitPriceCents,
    p_billing_contact_name: input.billingContactName,
    p_billing_contact_email: input.billingContactEmail,
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

'use server';

/**
 * Auto-renew on the broker Billing page — BACKLOG-4019.
 *
 * Calls public.set_org_auto_renew with the SIGNED-IN USER'S client (never the service client:
 * the database reads auth.uid() to decide who may switch it and to name who did). The database
 * admits the brokerage's Admin and its billing contact, refuses everyone else (42501), and
 * refuses a brokerage caller while the brokerage is suspended.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { autoRenewErrorMessage } from '@/lib/billing/planEnd';

export interface AutoRenewResult {
  ok: boolean;
  error: string | null;
}

export async function setAutoRenew(organizationId: string, on: boolean, expectedVersion: number): Promise<AutoRenewResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { ok: false, error: autoRenewErrorMessage('impersonation') };
  if (!Number.isInteger(expectedVersion)) return { ok: false, error: autoRenewErrorMessage('version_conflict') };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: autoRenewErrorMessage('not_authorized') };
  const { data, error } = await supabase.rpc('set_org_auto_renew', {
    p_org: organizationId,
    p_on: on,
    p_note: null,
    p_expected_version: expectedVersion,
  });
  if (error) return { ok: false, error: autoRenewErrorMessage(error.code === '42501' ? 'not_authorized' : null) };
  const res = data as { success?: boolean; error?: string } | null;
  if (!res?.success) return { ok: false, error: autoRenewErrorMessage(res?.error) };
  revalidatePath('/dashboard/billing');
  revalidatePath('/dashboard');
  return { ok: true, error: null };
}

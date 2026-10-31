'use server';

/**
 * Server action for the "Free trial" card on the Plans page (BACKLOG-3860 PR-3).
 *
 * Three checks, in order: the input (whole days 1-90, on/off a real boolean), the caller's
 * billing.pricebook capability (Super Admin only) read here through has_permission, then the
 * database function admin_set_solo_trial_setting, which checks auth.uid() and the capability
 * again and writes the setting and its audit row together. Nothing here writes an audit row:
 * the function does, in the same transaction as the change.
 */

import { revalidatePath } from 'next/cache';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import { checkTrialDays, trialErrorMessage } from '@/lib/billing/trialSettingRules';

export interface TrialActionResult {
  ok: boolean;
  error: string | null;
}

export async function setSoloTrialAction(enabled: boolean, days: string | number): Promise<TrialActionResult> {
  if (typeof enabled !== 'boolean') return { ok: false, error: trialErrorMessage('22004') };
  const checked = checkTrialDays(days);
  if (!checked.ok) return { ok: false, error: checked.error };

  const { supabase, user } = await getAuthenticatedUser();
  if (!user) return { ok: false, error: trialErrorMessage('42501') };

  const { data: canEdit, error: permError } = await supabase.rpc('has_permission', {
    check_user_id: user.id,
    required_permission: 'billing.pricebook',
  });
  if (permError || canEdit !== true) return { ok: false, error: trialErrorMessage('42501') };

  const { error } = await supabase.rpc('admin_set_solo_trial_setting', {
    p_enabled: enabled,
    p_days: checked.days,
  });
  if (error) return { ok: false, error: trialErrorMessage((error as { code?: string }).code) };

  revalidatePath('/dashboard/plans');
  return { ok: true, error: null };
}

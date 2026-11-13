'use server';

/**
 * Staff revoke of a brokerage domain claim (BACKLOG-3962 PR2).
 *
 * Checks, in order: the ids and the reason, the caller's organizations.edit permission read through
 * has_permission, then admin_revoke_domain_claim on the staff member's own session client, which
 * checks auth.uid(), the internal role and organizations.edit again, writes the change and its
 * audit row together. Nothing here writes domain_claims or the audit log directly.
 */

import { revalidatePath } from 'next/cache';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import { checkRevokeReason, revokeErrorMessage } from '@/lib/domainClaimRules';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RevokeDomainClaimResult {
  ok: boolean;
  error: string | null;
}

export async function revokeDomainClaimAction(
  organizationId: string,
  claimId: string,
  reason: string
): Promise<RevokeDomainClaimResult> {
  if (typeof organizationId !== 'string' || !UUID_RE.test(organizationId)) {
    return { ok: false, error: revokeErrorMessage('claim_not_found') };
  }
  if (typeof claimId !== 'string' || !UUID_RE.test(claimId)) {
    return { ok: false, error: revokeErrorMessage('claim_not_found') };
  }
  const checked = checkRevokeReason(reason);
  if (!checked.ok) return { ok: false, error: checked.error };

  const { supabase, user } = await getAuthenticatedUser();
  if (!user) return { ok: false, error: revokeErrorMessage('not_authenticated') };

  const { data: canEdit, error: permError } = await supabase.rpc('has_permission', {
    check_user_id: user.id,
    required_permission: 'organizations.edit',
  });
  if (permError || canEdit !== true) return { ok: false, error: revokeErrorMessage('insufficient_permissions') };

  const { data, error } = await supabase.rpc('admin_revoke_domain_claim', {
    p_claim: claimId,
    p_reason: checked.reason,
  });
  if (error) return { ok: false, error: revokeErrorMessage(undefined) };
  const reply = (data ?? {}) as { success?: unknown; error?: unknown };
  if (reply.success !== true) {
    return { ok: false, error: revokeErrorMessage(typeof reply.error === 'string' ? reply.error : undefined) };
  }

  revalidatePath(`/dashboard/organizations/${organizationId}`);
  return { ok: true, error: null };
}

'use server';

import { createClient } from '@/lib/supabase/server';
import { randomBytes, createHash } from 'crypto';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { requireScimAccess, isScimProvisioningEnabled } from '@/lib/scim-access';
import { requireJitAccess, isJitProvisioningEnabled } from '@/lib/jit-access';
import { isFeatureEnabledFailClosed } from '@/lib/feature-gate';
import { RETENTION_FEATURE_KEY } from '@/lib/org-settings-access';

/**
 * BACKLOG-3087: the four SCIM-specific actions below (generateScimToken,
 * revokeScimToken, listScimTokens, listScimSyncLogs) no longer do their own
 * auth. They call requireScimAccess(), which adds a FAIL-CLOSED
 * scim_provisioning feature check on top of the identity + role checks they
 * used to perform inline. Hiding the link is not a gate — a caller who knows
 * the action name must be refused too.
 *
 * BACKLOG-3078/3094 extended the same shape to the other two gated cards:
 *   - getJitStatus / updateJitStatus route through requireJitAccess(), which
 *     adds a FAIL-CLOSED jit_provisioning check on top of the role check.
 *   - updateRetentionPolicy adds a FAIL-CLOSED custom_retention check. It had
 *     NONE before: the card was simply always rendered, so a team-plan admin
 *     could call the action directly and the write landed. Graying the control
 *     without this would have been theatre.
 *
 * The consent actions are not feature-gated — admin consent is how a tenant is
 * connected at all — and keep their own admin checks.
 */

/**
 * Is the SCIM surface available to the caller? For rendering decisions only.
 *
 * Never throws: an unauthenticated or errored caller gets { enabled: false },
 * so a client component that forgets a catch still hides the card.
 */
export async function getScimFeatureStatus(): Promise<{ enabled: boolean }> {
  return { enabled: await isScimProvisioningEnabled() };
}

export async function generateScimToken(description: string) {
  // Block during impersonation (read-only session)
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) throw new Error(blocked.error);

  // Authenticated + admin/it_admin + scim_provisioning enabled (fail-closed).
  const { supabase, userId, organizationId } = await requireScimAccess();

  const plainToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(plainToken).digest('hex');

  const { error } = await supabase.from('scim_tokens').insert({
    organization_id: organizationId,
    token_hash: tokenHash,
    description: description || 'SCIM Token',
    created_by: userId,
  });

  if (error) throw new Error('Failed to create token');
  return { token: plainToken };
}

export async function revokeScimToken(tokenId: string) {
  // Block during impersonation (read-only session)
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) throw new Error(blocked.error);

  // Authenticated + admin/it_admin + scim_provisioning enabled (fail-closed).
  const { supabase, organizationId } = await requireScimAccess();

  const { error } = await supabase
    .from('scim_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', tokenId)
    .eq('organization_id', organizationId);

  if (error) throw new Error('Failed to revoke token');
  return { success: true };
}

export async function listScimTokens() {
  // Authenticated + admin/it_admin + scim_provisioning enabled (fail-closed).
  const { supabase, organizationId } = await requireScimAccess();

  const { data: tokens } = await supabase
    .from('scim_tokens')
    .select(
      'id, description, created_at, expires_at, revoked_at, last_used_at, request_count'
    )
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });

  return tokens || [];
}

export async function getRetentionPolicy() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data: membership } = await supabase
    .from('organization_members')
    .select('organization_id, role')
    .eq('user_id', user.id)
    .in('role', ['admin', 'it_admin'])
    .single();

  if (!membership) throw new Error('Not authorized');

  const { data: org } = await supabase
    .from('organizations')
    .select('retention_years')
    .eq('id', membership.organization_id)
    .single();

  return {
    retentionYears: org?.retention_years ?? 7,
  };
}

export async function updateRetentionPolicy(retentionYears: number) {
  // Block during impersonation (read-only session)
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) throw new Error(blocked.error);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data: membership } = await supabase
    .from('organization_members')
    .select('organization_id, role')
    .eq('user_id', user.id)
    .in('role', ['admin', 'it_admin'])
    .single();

  if (!membership) throw new Error('Not authorized');

  if (retentionYears < 1 || retentionYears > 10) {
    throw new Error('Retention must be between 1 and 10 years');
  }

  // BACKLOG-3078: a grayed control is not a gate. The card renders disabled for
  // a plan without custom_retention, and this is what stops a caller who knows
  // the action name from writing anyway. Fail-closed: an RPC error or a missing
  // feature row refuses rather than allowing the write.
  const retentionAllowed = await isFeatureEnabledFailClosed(
    membership.organization_id,
    RETENTION_FEATURE_KEY
  );
  if (!retentionAllowed) throw new Error('Not authorized');

  const { error } = await supabase
    .from('organizations')
    .update({ retention_years: retentionYears })
    .eq('id', membership.organization_id);

  if (error) throw new Error('Failed to update retention policy');
  return { success: true };
}

export async function getConsentStatus() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data: membership } = await supabase
    .from('organization_members')
    .select('organization_id, role')
    .eq('user_id', user.id)
    .in('role', ['admin', 'it_admin'])
    .single();

  if (!membership) throw new Error('Not authorized');

  const { data: org } = await supabase
    .from('organizations')
    .select('microsoft_tenant_id, graph_admin_consent_granted, graph_admin_consent_at')
    .eq('id', membership.organization_id)
    .single();

  return {
    organizationId: membership.organization_id,
    tenantId: org?.microsoft_tenant_id || null,
    consentGranted: org?.graph_admin_consent_granted || false,
    consentGrantedAt: org?.graph_admin_consent_at || null,
  };
}

/**
 * Is the JIT surface available to the caller? For rendering decisions only.
 *
 * Never throws — mirrors getScimFeatureStatus, so a client that forgets a catch
 * still hides the card.
 */
export async function getJitFeatureStatus(): Promise<{ enabled: boolean }> {
  return { enabled: await isJitProvisioningEnabled() };
}

export async function getJitStatus() {
  // Authenticated + admin/it_admin + jit_provisioning enabled (fail-closed).
  const { supabase, organizationId } = await requireJitAccess();

  const { data: org } = await supabase
    .from('organizations')
    .select('jit_provisioning_enabled')
    .eq('id', organizationId)
    .single();

  return {
    enabled: org?.jit_provisioning_enabled ?? true,
  };
}

export async function updateJitStatus(enabled: boolean) {
  // Block during impersonation (read-only session)
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) throw new Error(blocked.error);

  // Authenticated + admin/it_admin + jit_provisioning enabled (fail-closed).
  const { supabase, organizationId } = await requireJitAccess();

  const { error } = await supabase
    .from('organizations')
    .update({ jit_provisioning_enabled: enabled })
    .eq('id', organizationId);

  if (error) throw new Error('Failed to update JIT provisioning setting');
  return { success: true };
}

export async function listScimSyncLogs(limit = 50) {
  // Authenticated + admin/it_admin + scim_provisioning enabled (fail-closed).
  const { supabase, organizationId } = await requireScimAccess();

  const { data: logs } = await supabase
    .from('scim_sync_log')
    .select(
      'id, operation, resource_type, external_id, response_status, error_message, created_at'
    )
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  return logs || [];
}

/**
 * JIT provisioning access gate — BACKLOG-3094, shipped with BACKLOG-3078.
 *
 * The exact shape of lib/scim-access.ts, one card up on the same page. The
 * Just-in-Time card claims "Anyone with a matching Microsoft tenant can sign in
 * and join automatically". Verified 2026-09-03: every JIT join fails and signs
 * the user out, for two independent reasons — the portal calls
 * jit_join_organization(p_provider_type, p_identifier) while production only has
 * the one-argument form, and that remaining function has EXECUTE revoked from
 * `authenticated` (the interim mitigation for the cross-org escalation in
 * BACKLOG-1954). Last JIT-provisioned member: 2026-03-05.
 *
 * ---------------------------------------------------------------------------
 * Why this gate is FAIL-CLOSED
 * ---------------------------------------------------------------------------
 *   false negative -> an admin does not see a toggle that does not work.
 *   false positive -> an admin flips it on, tells their agents to sign in, and
 *                     every agent is bounced with org_not_setup.
 *
 * `isFeatureEnabled` from lib/feature-gate.ts returns TRUE for a key it cannot
 * find, which is the state prod is in until the migration in this PR is
 * applied. `isFeatureEnabledFailClosed` is the one to use here.
 *
 * organizations.jit_provisioning_enabled is deliberately untouched by any of
 * this. Hiding the control must not change any org's stored value — the column
 * matters again the moment BACKLOG-1954 lands.
 */

import { createClient } from '@/lib/supabase/server';
import { isFeatureEnabledFailClosed } from '@/lib/feature-gate';

/** feature_definitions.key seeded by 20260904_backlog_3094_jit_provisioning_feature.sql */
export const JIT_FEATURE_KEY = 'jit_provisioning';

/** Roles that may administer JIT provisioning. Unchanged from the inline checks. */
export const JIT_ADMIN_ROLES = ['admin', 'it_admin'] as const;

type ServerClient = Awaited<ReturnType<typeof createClient>>;

export interface JitAccess {
  supabase: ServerClient;
  userId: string;
  organizationId: string;
  role: string;
}

/**
 * Authenticate, authorize and feature-check the caller for JIT work.
 *
 * Throws on refusal so a server action cannot continue past it. Order matters:
 * identity, then role, then feature — the feature check needs an
 * organization_id, and reporting "not authorized" before "feature off" avoids
 * telling an unauthorized caller anything about the org's plan.
 */
export async function requireJitAccess(): Promise<JitAccess> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data: membership } = await supabase
    .from('organization_members')
    .select('organization_id, role')
    .eq('user_id', user.id)
    .in('role', [...JIT_ADMIN_ROLES])
    .single();

  if (!membership) throw new Error('Not authorized');

  const enabled = await isFeatureEnabledFailClosed(
    membership.organization_id,
    JIT_FEATURE_KEY
  );
  if (!enabled) throw new Error('Not authorized');

  return {
    supabase,
    userId: user.id,
    organizationId: membership.organization_id,
    role: membership.role,
  };
}

/**
 * Non-throwing form for rendering decisions.
 *
 * Shares requireJitAccess rather than re-deriving the answer: two
 * implementations of "may this caller use JIT" would eventually disagree, and
 * the way they disagree is a visible toggle whose action then refuses.
 *
 * Any throw at all is a refusal.
 */
export async function isJitProvisioningEnabled(): Promise<boolean> {
  try {
    await requireJitAccess();
    return true;
  } catch {
    return false;
  }
}

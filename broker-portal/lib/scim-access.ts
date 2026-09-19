/**
 * SCIM access gate — BACKLOG-3087
 *
 * One place decides whether the SCIM surfaces exist for the caller. The
 * settings card, the /dashboard/settings/scim route and the four SCIM server
 * actions all route through here, so there is no route a caller can know about
 * that skips the check.
 *
 * ---------------------------------------------------------------------------
 * Why this gate is FAIL-CLOSED
 * ---------------------------------------------------------------------------
 * The SCIM settings page hands an IT admin an endpoint URL and a bearer token
 * and invites them to point Entra/Okta at it. As of 2026-09-03 the `scim` edge
 * function has never been deployed: that URL returns 404, and scim_tokens /
 * scim_sync_log have zero rows.
 *
 *   false negative -> an IT admin does not see a page that does not work.
 *   false positive -> a customer wires their identity provider to a 404.
 *
 * The second is far more expensive, so every uncertainty resolves to "no":
 * unauthenticated, no membership, wrong role, RPC error, feature row missing,
 * feature row disabled. `isFeatureEnabledFailClosed` supplies that policy —
 * the ordinary `isFeatureEnabled` helper would return TRUE for a missing
 * scim_provisioning key, which is exactly the state prod is in today.
 */

import { createClient } from '@/lib/supabase/server';
import { isFeatureEnabledFailClosed } from '@/lib/feature-gate';

/** feature_definitions.key seeded by 20260903_backlog_3087_scim_provisioning_feature.sql */
export const SCIM_FEATURE_KEY = 'scim_provisioning';

/** Roles that may administer SCIM. Unchanged from the pre-BACKLOG-3087 actions. */
export const SCIM_ADMIN_ROLES = ['admin', 'it_admin'] as const;

type ServerClient = Awaited<ReturnType<typeof createClient>>;

export interface ScimAccess {
  supabase: ServerClient;
  userId: string;
  organizationId: string;
  role: string;
}

/**
 * Authenticate, authorize and feature-check the caller for SCIM work.
 *
 * Throws on refusal so a server action cannot accidentally continue past it —
 * a boolean return is too easy to ignore at a call site.
 *
 * Order matters: identity, then role, then feature. The feature check needs an
 * organization_id, and reporting "not authorized" before "feature off" avoids
 * telling an unauthorized caller anything about the org's plan.
 */
export async function requireScimAccess(): Promise<ScimAccess> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data: membership } = await supabase
    .from('organization_members')
    .select('organization_id, role')
    .eq('user_id', user.id)
    .in('role', [...SCIM_ADMIN_ROLES])
    .single();

  if (!membership) throw new Error('Not authorized');

  const enabled = await isFeatureEnabledFailClosed(
    membership.organization_id,
    SCIM_FEATURE_KEY
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
 * Non-throwing form for rendering decisions (route gate, settings card).
 *
 * Deliberately shares requireScimAccess rather than re-deriving the answer:
 * two implementations of "may this caller use SCIM" would eventually disagree,
 * and the way they disagree is a visible link to a page that then refuses — or
 * worse, a page that renders while the actions refuse.
 *
 * Any throw at all is a refusal. There is no error this function reports as
 * "probably fine".
 */
export async function isScimProvisioningEnabled(): Promise<boolean> {
  try {
    await requireScimAccess();
    return true;
  } catch {
    return false;
  }
}

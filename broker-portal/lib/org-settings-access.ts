/**
 * Who may open org settings, and how each gated card renders — BACKLOG-3078.
 *
 * ---------------------------------------------------------------------------
 * Before this file, /dashboard/settings had NO server gate at all.
 * ---------------------------------------------------------------------------
 * The page was a client component. Every server action it called checked
 * admin/it_admin independently, so a non-admin who loaded the URL got the page
 * chrome, an empty consent card, a retention dropdown defaulted to 7 years and
 * a JIT toggle defaulted to on — all of which are org policy — and only found
 * out it was refused when a save failed. A missing nav link is not a gate.
 *
 * BACKLOG-3080 lets a non-admin role into the portal. Once that lands, this
 * page must refuse `agent` on the server, before any org-policy markup exists.
 */

import { createClient } from '@/lib/supabase/server';
import { isFeatureEnabledFailClosed } from '@/lib/feature-gate';
import { SCIM_FEATURE_KEY } from '@/lib/scim-access';
import { JIT_FEATURE_KEY } from '@/lib/jit-access';
import {
  featureRenderPolicy,
  featureUnlockLabel,
  type FeatureRenderPolicy,
} from '@/lib/feature-availability';

/** feature_definitions.key gating the org-wide email retention policy. */
export const RETENTION_FEATURE_KEY = 'custom_retention';

/** Roles that may see or change organization policy. */
export const ORG_SETTINGS_ROLES = ['admin', 'it_admin'] as const;

export interface OrgSettingsAccessGranted {
  allowed: true;
  userId: string;
  organizationId: string;
  role: string;
}

export interface OrgSettingsAccessDenied {
  allowed: false;
  reason: 'unauthenticated' | 'unauthorized';
}

export type OrgSettingsAccess = OrgSettingsAccessGranted | OrgSettingsAccessDenied;

/**
 * May the signed-in caller see organization policy?
 *
 * Returns rather than throws because the page turns the answer into a redirect.
 * Does NOT consider impersonation — a support session has no authenticated
 * user, and the page handles that branch separately with a scoped read-only
 * client, exactly as /dashboard/users does.
 */
export async function checkOrgSettingsAccess(): Promise<OrgSettingsAccess> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { allowed: false, reason: 'unauthenticated' };

  const { data: membership } = await supabase
    .from('organization_members')
    .select('organization_id, role')
    .eq('user_id', user.id)
    .maybeSingle();

  if (
    !membership ||
    !(ORG_SETTINGS_ROLES as readonly string[]).includes(membership.role)
  ) {
    return { allowed: false, reason: 'unauthorized' };
  }

  return {
    allowed: true,
    userId: user.id,
    organizationId: membership.organization_id,
    role: membership.role,
  };
}

/** How one gated card renders, plus the label to print when it is grayed. */
export interface CardPolicy {
  policy: FeatureRenderPolicy;
  unlockLabel: string | null;
}

/** Every gated card on the org settings page, resolved in one place. */
export interface OrgSettingsFeatureView {
  retention: CardPolicy;
  scim: CardPolicy;
  jit: CardPolicy;
}

function toCardPolicy(featureKey: string, enabled: boolean): CardPolicy {
  const policy = featureRenderPolicy(featureKey, enabled);
  return { policy, unlockLabel: featureUnlockLabel(featureKey, policy) };
}

/**
 * Resolve the render policy of every gated card for one organization.
 *
 * Each key is checked FAIL-CLOSED and then handed to the shared rule in
 * lib/feature-availability.ts. Nothing here knows that SCIM and JIT happen to
 * be the unbuilt ones — it asks, per key, and renders the answer. That is what
 * makes BACKLOG-3098 a one-file change.
 *
 * These three checks run against the same helper the server actions use, so a
 * card cannot render enabled while its action refuses, or vice versa.
 */
export async function resolveOrgSettingsFeatures(
  organizationId: string
): Promise<OrgSettingsFeatureView> {
  const [retention, scim, jit] = await Promise.all([
    isFeatureEnabledFailClosed(organizationId, RETENTION_FEATURE_KEY),
    isFeatureEnabledFailClosed(organizationId, SCIM_FEATURE_KEY),
    isFeatureEnabledFailClosed(organizationId, JIT_FEATURE_KEY),
  ]);

  return {
    retention: toCardPolicy(RETENTION_FEATURE_KEY, retention),
    scim: toCardPolicy(SCIM_FEATURE_KEY, scim),
    jit: toCardPolicy(JIT_FEATURE_KEY, jit),
  };
}

/**
 * What a read-only support session sees.
 *
 * An impersonation session has no authenticated user, so every fail-closed
 * feature check would refuse — and a refused custom_retention check would print
 * "Available on Enterprise" beside an enterprise customer's own retention
 * setting, which is a false statement about their plan. The page is already
 * read-only in this mode (every control carries `disabled={isImpersonating}`),
 * so the honest answer is to render the retention card normally and say nothing
 * about plans, and to keep the two unbuilt cards hidden — which is exactly what
 * a support session saw before this split.
 */
export function impersonationFeatureView(): OrgSettingsFeatureView {
  return {
    retention: { policy: 'enabled', unlockLabel: null },
    scim: { policy: 'hidden', unlockLabel: null },
    jit: { policy: 'hidden', unlockLabel: null },
  };
}

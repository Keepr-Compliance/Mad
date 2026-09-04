/**
 * One person's own account, assembled server-side. BACKLOG-3079.
 *
 * ---------------------------------------------------------------------------
 * IT TAKES NO USER ID, AND THAT IS THE SECURITY MODEL.
 * ---------------------------------------------------------------------------
 * The subject is the session's own user, or — during a support session — the
 * impersonation cookie's target. There is no parameter a caller could point at
 * somebody else, so "can user A read user B's account?" is not a check that can
 * be forgotten: it is unrepresentable.
 *
 * Underneath, RLS is the second wall. `user_preferences` is own-rows plus
 * service_role with NO internal-role read policy (verified 2026-09-04), so an
 * ordinary session physically cannot select another person's row even if this
 * function were wrong. Support reaches it only through the scoped service
 * client `getDataClient()` hands back for an impersonation session — which is
 * exactly what BACKLOG-3079 says: "Keepr support therefore sees this page only
 * through the existing impersonation flow."
 *
 * Read-only, deliberately. The desktop app owns these values; this page reports
 * them and offers no way to edit, because a second writer would be a second
 * source of truth.
 */

import { createClient } from '@/lib/supabase/server';
import { getDataClient } from '@/lib/impersonation-guards';
import { isFeatureEnabledFailClosed } from '@/lib/feature-gate';

/**
 * The types and the pure provider-name helper live in ./accountView so a CLIENT
 * component can import them. This module imports @/lib/supabase/server, which
 * needs next/headers; any client import of THIS file fails `next build` — and
 * only `next build`, since tsc and jest both resolve it happily.
 */

export type { AccountIdentity, AccountView } from './accountView';
export { providerDisplayName } from './accountView';

import type { AccountView } from './accountView';

/**
 * feature_definitions.key. Enterprise and Team enabled, Individual disabled —
 * verified against plan_features on 2026-09-04.
 */
export const SUBMISSION_FEATURE_KEY = 'broker_submission';

/**
 * May this organization submit email to a brokerage at all?
 *
 * ---------------------------------------------------------------------------
 * WHY THE RETENTION CARD ASKS THIS
 * ---------------------------------------------------------------------------
 * organizations.retention_years describes how long SUBMITTED email is kept. An
 * org whose members cannot submit has nothing being retained, so the card was
 * stating a policy that governs nothing — founder, 2026-09-04: "for an org with
 * only individual desktop accounts the retention policy on the new my account
 * shouldn't show since it's not relevant for desktop users on orgs that don't
 * have the option to submit."
 *
 * ---------------------------------------------------------------------------
 * FAIL-CLOSED, AND WHY THAT IS NOT THE DEFAULT HELPER
 * ---------------------------------------------------------------------------
 * `isFeatureEnabled` / `getOrgFeatures` in lib/feature-gate.ts are FAIL-OPEN by
 * documented design: an unknown key returns true and a failed RPC yields an
 * empty feature map that reads as "allow". Either would show this card to an
 * org that cannot submit the moment the RPC hiccups, and would look identical
 * to a working gate in every happy-path test. `isFeatureEnabledFailClosed` is
 * the strict sibling: RPC error, the RPC's own 200-with-error payload, a
 * malformed payload, a missing key and an explicitly disabled key all resolve
 * to false. An org with NO organization_plans row — which exists in production
 * — resolves broker_submission from the feature default, which is false.
 *
 * The try/catch is the last uncertainty: a throw (no session, transport
 * failure) is a refusal, not an error reported as "probably fine". Same shape
 * as isScimProvisioningEnabled() in lib/scim-access.ts.
 *
 * ---------------------------------------------------------------------------
 * A SUPPORT SESSION THEREFORE DOES NOT SEE THIS CARD. STATED, NOT ASSUMED.
 * ---------------------------------------------------------------------------
 * Impersonation on this portal carries NO Supabase auth session. The admin
 * portal mints a token, /auth/impersonate validates it with the SERVICE client
 * ("no user session needed") and sets a signed cookie, and middleware.ts lets
 * /dashboard/* through on that cookie alone without ever calling getUser. So
 * during a support session createClient() yields a client whose auth.uid() is
 * NULL, broker_get_org_features takes its first early return, and the RPC's
 * own 200-with-error payload resolves this check to false.
 *
 * The consequence is real and is the fail-closed one: support sees the account
 * page WITHOUT the retention card, on every org, including an enterprise
 * customer whose members can submit. That is a visibility gap, not a wrong
 * statement — and the alternative is worse. Resolving broker_submission for a
 * support session would need a SECOND implementation of "may this org submit",
 * reading organization_plans/plan_features directly, and two implementations of
 * one entitlement eventually disagree. lib/org-settings-access.ts hit the same
 * wall and answered it differently (impersonationFeatureView() renders
 * retention unconditionally there, because on THAT page the value is the org's
 * own policy and no relevance question is being asked). Filed on BACKLOG-3079
 * rather than papered over here.
 */
async function orgCanSubmit(organizationId: string): Promise<boolean> {
  try {
    return await isFeatureEnabledFailClosed(organizationId, SUBMISSION_FEATURE_KEY);
  } catch {
    return false;
  }
}

interface UserRow {
  id: string;
  email: string | null;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  oauth_provider: string | null;
  created_at: string | null;
}

/** Prefer the stored display name; fall back the way the desktop does. */
function resolveName(row: UserRow | null): string | null {
  if (!row) return null;
  if (row.display_name) return row.display_name;
  const parts = [row.first_name, row.last_name].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

/**
 * Assemble the page's data.
 *
 * Every read is independent and every one is allowed to come back empty. A
 * person with no user_preferences row, no organization, or a users row the
 * session cannot see must still get a page — the empty states are the point,
 * not an edge case.
 */
export async function getAccountView(): Promise<AccountView | null> {
  const { client, impersonation, targetUserId } = await getDataClient();

  let userId: string | null = targetUserId;
  if (!impersonation) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  }

  if (!userId) return null;

  const [userResult, membershipResult, preferencesResult] = await Promise.all([
    client
      .from('users')
      .select('id, email, display_name, first_name, last_name, oauth_provider, created_at')
      .eq('id', userId)
      .maybeSingle(),
    client
      .from('organization_members')
      .select('role, organization_id')
      .eq('user_id', userId)
      .maybeSingle(),
    client
      .from('user_preferences')
      .select('preferences, updated_at')
      .eq('user_id', userId)
      .maybeSingle(),
  ]);

  const userRow = (userResult.data as UserRow | null) ?? null;
  const membership = (membershipResult.data as
    | { role: string | null; organization_id: string | null }
    | null) ?? null;

  let organizationName: string | null = null;
  let orgRetentionYears: number | null = null;
  if (membership?.organization_id) {
    const [orgResult, canSubmit] = await Promise.all([
      client
        .from('organizations')
        .select('name, retention_years')
        .eq('id', membership.organization_id)
        .maybeSingle(),
      orgCanSubmit(membership.organization_id),
    ]);
    const org = orgResult.data;
    organizationName = (org as { name?: string | null } | null)?.name ?? null;
    // Suppressed HERE, at the source, rather than as a second condition in the
    // client. One decision cannot disagree with itself; two can, and the way
    // they disagree is a card that renders from stale props.
    orgRetentionYears = canSubmit
      ? ((org as { retention_years?: number | null } | null)?.retention_years ?? null)
      : null;
  }

  const prefsRow = (preferencesResult.data as
    | { preferences: Record<string, unknown> | null; updated_at: string | null }
    | null) ?? null;

  return {
    identity: {
      userId,
      displayName: resolveName(userRow),
      email: userRow?.email ?? null,
      authProvider: userRow?.oauth_provider ?? null,
      role: membership?.role ?? null,
      organizationName,
      createdAt: userRow?.created_at ?? null,
    },
    // A row that exists with a null/empty blob is NOT the same as no row, and
    // the page says so differently. Only a missing row becomes null here.
    preferences: prefsRow ? (prefsRow.preferences ?? {}) : null,
    preferencesUpdatedAt: prefsRow?.updated_at ?? null,
    orgRetentionYears,
    isImpersonating: Boolean(impersonation),
  };
}

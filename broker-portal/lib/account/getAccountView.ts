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

/**
 * The types and the pure provider-name helper live in ./accountView so a CLIENT
 * component can import them. This module imports @/lib/supabase/server, which
 * needs next/headers; any client import of THIS file fails `next build` — and
 * only `next build`, since tsc and jest both resolve it happily.
 */

export type { AccountIdentity, AccountView } from './accountView';
export { providerDisplayName } from './accountView';

import type { AccountView } from './accountView';

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
    const { data: org } = await client
      .from('organizations')
      .select('name, retention_years')
      .eq('id', membership.organization_id)
      .maybeSingle();
    organizationName = (org as { name?: string | null } | null)?.name ?? null;
    orgRetentionYears =
      (org as { retention_years?: number | null } | null)?.retention_years ?? null;
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

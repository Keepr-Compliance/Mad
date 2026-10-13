/**
 * Portal access for server components, route handlers and gates — BACKLOG-3080.
 *
 * The Node-runtime half of lib/auth/membership.ts. It runs the one membership
 * query every portal gate uses and hands the rows to `classifyPortalAccess`, so
 * the layout, each page, the settings gate and the users pages all read access
 * the same way middleware does.
 *
 * NEVER import this from middleware.ts: `@/lib/supabase/server` pulls
 * `next/headers`, which the Edge runtime cannot load.
 */

import { createClient } from '@/lib/supabase/server';
import type { User } from '@supabase/supabase-js';
import {
  PORTAL_MEMBERSHIP_SELECT,
  classifyPortalAccess,
  type PortalAccess,
  type PortalMembershipRow,
} from '@/lib/auth/membership';
import { LICENCE_READ_FAILED, readOwnLicenceSuspended } from '@/lib/auth/suspension';

type ServerClient = Awaited<ReturnType<typeof createClient>>;

export interface PortalAccessResult {
  supabase: ServerClient;
  user: User;
  access: PortalAccess;
  /**
   * BACKLOG-3878: the user's own licence is suspended. null = the read failed;
   * pages treat that as not suspended (fail open, logged), money paths never
   * read this field.
   */
  suspended: boolean | null;
}

/**
 * The signed-in user and what they may open, or null when nobody is signed in.
 *
 * The query is the same one middleware and the OAuth callback send: whole
 * embed, ordered on base columns, every row returned. See membership.ts for why
 * it must never name the personal-organization column.
 */
export async function getPortalAccess(): Promise<PortalAccessResult | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [{ data: memberships }, suspended] = await Promise.all([
    supabase
      .from('organization_members')
      .select(PORTAL_MEMBERSHIP_SELECT)
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
    readOwnLicenceSuspended(supabase, user.id),
  ]);
  if (suspended === null) console.warn('[portalAccess] suspended check skipped', { code: LICENCE_READ_FAILED });

  return {
    supabase,
    user,
    access: classifyPortalAccess(memberships as PortalMembershipRow[] | null, user.id),
    suspended,
  };
}

/** Full-portal access with its role and organization, or null. */
export interface FullPortalAccess extends PortalAccessResult {
  access: Extract<PortalAccess, { kind: 'full' }>;
}

/**
 * The caller's full-portal access, or null for everyone the portal floors,
 * does not know, or does not admit — and, BACKLOG-3878, for a suspended
 * account, so every full-portal page refuses it on its own.
 *
 * Pages call this BEFORE any data read and redirect on null.
 */
export async function requireFullPortalAccess(): Promise<FullPortalAccess | null> {
  const result = await getPortalAccess();
  if (!result || result.access.kind !== 'full' || result.suspended === true) return null;
  return result as FullPortalAccess;
}

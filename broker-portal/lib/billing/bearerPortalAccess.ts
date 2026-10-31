/**
 * Portal access for a desktop (Bearer-token) caller — BACKLOG-3676.
 *
 * The same membership query getPortalAccess() runs for a cookie session
 * (lib/auth/portalAccess.ts): PORTAL_MEMBERSHIP_SELECT, the caller's rows only,
 * ordered on created_at then id, every row returned, then classifyPortalAccess.
 *
 * Read with a client that carries the caller's own token, so RLS applies. RLS is
 * NOT a per-user filter on organization_members: its select policy also returns
 * every co-member of the caller's organizations. The `.eq('user_id', userId)`
 * is what keeps another member's row out of the classifier, whose first
 * brokerage row decides.
 */

import { createClient } from '@supabase/supabase-js';
import {
  PORTAL_MEMBERSHIP_SELECT,
  classifyPortalAccess,
  type PortalAccess,
  type PortalMembershipRow,
} from '@/lib/auth/membership';

/** A failed read classifies as `unknown` (callers answer "try again"), never as "no membership". */
export async function readBearerPortalAccess(token: string, userId: string): Promise<PortalAccess> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return classifyPortalAccess(null, userId);
  try {
    const client = createClient(url, anon, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data, error } = await client
      .from('organization_members')
      .select(PORTAL_MEMBERSHIP_SELECT)
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    return classifyPortalAccess(error ? null : (data as PortalMembershipRow[] | null), userId);
  } catch {
    return classifyPortalAccess(null, userId);
  }
}

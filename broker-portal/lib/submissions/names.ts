/**
 * Actor names for a submission page — BACKLOG-3477.
 *
 * Names come from public.users, NOT profiles. profiles is readable only by its
 * owner (policy users_can_read_own_profile), so reading it under the viewer's
 * session resolves the viewer and nobody else: every colleague would render
 * as "a former member". users_select_public admits every member of an
 * organization the viewer belongs to, so an id missing from the answer is a
 * person who is no longer a member (SR C5, pm_comments ff44a1b1).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatUserDisplayName } from '@/lib/utils/userDisplay';
import type { NameMap } from './history';

interface UserNameRow {
  id: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

/**
 * Resolve user ids to display names. Returns null when the lookup itself
 * failed, so a caller never labels a live colleague "a former member" because
 * a request errored.
 */
export async function resolveUserNames(
  client: SupabaseClient,
  ids: Iterable<string | null | undefined>
): Promise<NameMap> {
  const unique = Array.from(new Set(Array.from(ids).filter((id): id is string => !!id)));
  if (unique.length === 0) return new Map();

  const { data, error } = await client
    .from('users')
    .select('id, display_name, first_name, last_name, email')
    .in('id', unique);

  if (error || !Array.isArray(data)) {
    console.error('[submissions] actor names unavailable:', error?.message);
    return null;
  }

  const names = new Map<string, string>();
  for (const row of data as UserNameRow[]) {
    names.set(row.id, formatUserDisplayName(row, row.email));
  }
  return names;
}

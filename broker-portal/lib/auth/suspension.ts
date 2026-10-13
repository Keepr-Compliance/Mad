/**
 * Is this user's own licence suspended? — BACKLOG-3878.
 *
 * Suspended is `licenses.status = 'suspended'`, the one signal every
 * suspension path writes (suspend_account_for_dispute and admin_suspend_user
 * both `UPDATE public.licenses SET status = 'suspended'`). users.status is NOT
 * read: the dispute path never writes it.
 *
 * Returns true / false, or null when the read failed. The caller decides what
 * null means: pages and middleware let the request through (and log
 * LICENCE_READ_FAILED), money paths and writes refuse.
 *
 * Edge-safe: no imports beyond a type, no next/headers. Works with the session
 * client (RLS: own row) and with the service client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** The only thing ever logged for a failed read: a static code, never the error. */
export const LICENCE_READ_FAILED = 'licence_read_failed';

type LicenceReader = Pick<SupabaseClient, 'from'>;

export async function readOwnLicenceSuspended(client: LicenceReader, userId: string): Promise<boolean | null> {
  try {
    // licenses_user_id_unique: at most one row per user.
    const { data, error } = await client.from('licenses').select('status').eq('user_id', userId).maybeSingle();
    if (error) return null;
    return (data as { status?: string | null } | null)?.status === 'suspended';
  } catch {
    return null;
  }
}

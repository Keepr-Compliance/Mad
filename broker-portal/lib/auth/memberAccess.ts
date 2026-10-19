/**
 * The caller's own right to act in ONE organization — BACKLOG-3917.
 *
 * Every brokerage admin / reviewer server action asks this before it reads or
 * writes on the organization's behalf. Refused unless ALL of:
 *
 *   - the caller has a membership row in `organizationId` (the TARGET
 *     organization, never "any row of mine");
 *   - its role is one of `roles`;
 *   - its `license_status` is on the allow-list (memberStatusGrantsAccess);
 *   - the caller's own licence is NOT suspended (BACKLOG-3878). A failed
 *     licence read refuses and logs a static code only.
 *
 * The membership and the licence are read together, never one after the other.
 * Any read error refuses. Callers keep their own refusal messages.
 *
 * Takes the client as an argument so the action's own session client (and its
 * RLS) is the one asking.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { memberStatusGrantsAccess } from '@/lib/auth/membership';
import { LICENCE_READ_FAILED, readOwnLicenceSuspended } from '@/lib/auth/suspension';

type MemberReader = Pick<SupabaseClient, 'from'>;

/**
 * ok: admitted. Refused with reason `role` when the caller's row in the
 * organization grants access but its role is not one of `roles` (callers keep
 * their role-specific message for that); `refused` for everything else.
 */
export type ActiveOrgRole = { ok: true; role: string } | { ok: false; reason: 'role' | 'refused' };

const REFUSED: ActiveOrgRole = { ok: false, reason: 'refused' };

/** Logged when the caller's membership read errors; never the error itself. */
export const MEMBERSHIP_READ_FAILED = 'membership_read_failed';

export async function requireActiveOrgRole(
  client: MemberReader,
  userId: string,
  organizationId: string,
  roles: readonly string[]
): Promise<ActiveOrgRole> {
  if (!userId || !organizationId) return REFUSED;

  const [membershipResult, suspended] = await Promise.all([
    readOwnMembership(client, userId, organizationId),
    readOwnLicenceSuspended(client, userId),
  ]);

  if (membershipResult === 'error') {
    console.warn('[memberAccess] membership read failed', { code: MEMBERSHIP_READ_FAILED });
    return REFUSED;
  }
  if (suspended === null) {
    console.warn('[memberAccess] licence read failed', { code: LICENCE_READ_FAILED });
    return REFUSED;
  }
  if (suspended) return REFUSED;

  const row = membershipResult;
  if (!row) return REFUSED;
  if (!memberStatusGrantsAccess(row.license_status)) return REFUSED;
  if (!roles.includes(row.role)) return { ok: false, reason: 'role' };

  return { ok: true, role: row.role };
}

async function readOwnMembership(
  client: MemberReader,
  userId: string,
  organizationId: string
): Promise<{ role: string; license_status: string | null } | null | 'error'> {
  try {
    const { data, error } = await client
      .from('organization_members')
      .select('role, license_status')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) return 'error';
    const row = data as { role?: unknown; license_status?: unknown } | null;
    if (!row || typeof row.role !== 'string') return null;
    return {
      role: row.role,
      license_status: typeof row.license_status === 'string' ? row.license_status : null,
    };
  } catch {
    return 'error';
  }
}

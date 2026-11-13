/**
 * Who gets a brokerage's seat-limit email — BACKLOG-3962 PR3a.
 *
 * Portal port of the SCIM rule (supabase/functions/scim/shared/seatLimit.ts, SEAT_EMAIL_ROLE_ORDER
 * and the recipient loop): the first role in it_admin -> admin -> broker order with at least one
 * ACTIVE claimed member wins; those members' sign-in emails, de-duplicated.
 * The seat count uses memberRowHoldsSeat (same rule as public.member_row_holds_seat).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { memberRowHoldsSeat, type SeatRow } from '@/lib/users/seatAvailability';

/** Recipient roles, in order: the first role with at least one active member wins. */
export const SEAT_EMAIL_ROLE_ORDER = ['it_admin', 'admin', 'broker'] as const;

export interface SeatMemberRow extends SeatRow {
  role: string;
}

/** The recipient user ids, by the role order above. */
export function pickSeatRecipientIds(rows: readonly SeatMemberRow[], excludeUserIds: readonly string[] = []): string[] {
  for (const role of SEAT_EMAIL_ROLE_ORDER) {
    const ids = rows
      .filter((m) => m.role === role && m.license_status === 'active' && !!m.user_id && !excludeUserIds.includes(m.user_id))
      .map((m) => m.user_id as string);
    if (ids.length > 0) return Array.from(new Set(ids));
  }
  return [];
}

export interface SeatAlertContext {
  brokerageName: string;
  used: number;
  maxSeats: number | null;
  recipients: string[];
}

/**
 * Reads what a seat-limit email needs, on the server-role client. Null when a read fails.
 */
export async function loadSeatAlertContext(
  service: SupabaseClient,
  organizationId: string,
  nowMs: number,
  excludeUserIds: readonly string[] = [],
): Promise<SeatAlertContext | null> {
  const { data: org, error: orgError } = await service
    .from('organizations')
    .select('name, max_seats')
    .eq('id', organizationId)
    .maybeSingle();
  if (orgError || !org) return null;

  const { data: members, error: membersError } = await service
    .from('organization_members')
    .select('user_id, role, license_status, invitation_expires_at')
    .eq('organization_id', organizationId);
  if (membersError || !Array.isArray(members)) return null;
  const rows = members as SeatMemberRow[];

  const ids = pickSeatRecipientIds(rows, excludeUserIds);
  let recipients: string[] = [];
  if (ids.length > 0) {
    const { data: users, error: usersError } = await service.from('users').select('id, email').in('id', ids);
    if (usersError) return null;
    recipients = Array.from(
      new Set(
        ((users ?? []) as Array<{ email: string | null }>)
          .map((u) => (u.email ?? '').trim())
          .filter((e) => e.length > 0),
      ),
    );
  }

  return {
    brokerageName: ((org as { name?: string | null }).name ?? '').trim() || 'your brokerage',
    used: rows.filter((r) => memberRowHoldsSeat(r, nowMs)).length,
    maxSeats: (org as { max_seats?: number | null }).max_seats ?? null,
    recipients,
  };
}

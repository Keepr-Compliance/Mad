/**
 * Seat availability — BACKLOG-3851 PR-2g.
 *
 * Lets the Reactivate dialog know, before the click, whether the organization
 * has a free licence. The database stays the decider: set_member_license
 * reactivates by UPDATE ... SET license_status = 'active', and the seat trigger
 * (_enforce_member_seat_limit, supabase/migrations/
 * 20261016200000_backlog_3851_scim_seat_refusal.sql) refuses it with
 * seat_limit_reached. This module mirrors that trigger's rule so the dialog can
 * show the out-of-licenses notice up front; the post-click refusal remains the
 * backstop when the seat state changes in between.
 *
 * The trigger's rule, for a row that would take a seat:
 *   - personal organization (personal_owner_user_id IS NOT NULL) -> allowed
 *   - max_seats IS NULL OR max_seats <= 0                        -> allowed
 *   - count of OTHER rows where member_row_holds_seat(...) < max_seats -> allowed
 *   - otherwise refused. (Its first-claimed-member exception cannot apply to a
 *     reactivation from the portal: the caller is itself a claimed member with
 *     access in the organization.)
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** One organization_members row, the three columns the seat rule reads. */
export interface SeatRow {
  id?: string;
  license_status: string | null;
  invitation_expires_at: string | null;
  user_id: string | null;
}

export interface OrgSeatInfo {
  max_seats: number | null;
  personal_owner_user_id: string | null;
}

/**
 * Same rule as public.member_row_holds_seat(text, timestamptz, uuid)
 * (supabase/migrations/20261015152446_backlog_3851_license_model.sql:114) and
 * the SCIM mirror rowHoldsSeat (supabase/functions/scim/shared/seatLimit.ts):
 *   license_status = 'active'
 *   OR (license_status = 'pending' AND (user_id IS NOT NULL
 *       OR invitation_expires_at IS NULL OR invitation_expires_at >= now()))
 */
export function memberRowHoldsSeat(row: SeatRow, nowMs: number): boolean {
  if (row.license_status === 'active') return true;
  if (row.license_status !== 'pending') return false;
  if (row.user_id) return true;
  if (!row.invitation_expires_at) return true;
  return Date.parse(row.invitation_expires_at) >= nowMs;
}

/**
 * True when one more row could take a seat. The trigger counts the other rows
 * (m.id <> NEW.id); a member being reactivated is suspended or expired and holds
 * no seat, so counting every row gives the same answer for it.
 */
export function orgHasFreeSeat(org: OrgSeatInfo, rows: readonly SeatRow[], nowMs: number): boolean {
  if (org.personal_owner_user_id !== null) return true;
  if (org.max_seats === null || org.max_seats <= 0) return true;
  const used = rows.filter((r) => memberRowHoldsSeat(r, nowMs)).length;
  return used < org.max_seats;
}


/**
 * Server-side read for a page: the organization's seat columns and, unless the
 * caller already loaded them, its member rows. Returns null when either read
 * fails; the dialog then behaves as before (Reactivate, refused after the
 * click if no licence is free).
 */
export async function loadOrgHasFreeSeat(
  client: SupabaseClient,
  organizationId: string,
  loadedRows?: readonly SeatRow[],
): Promise<boolean | null> {
  const { data: org, error: orgError } = await client
    .from('organizations')
    .select('max_seats, personal_owner_user_id')
    .eq('id', organizationId)
    .maybeSingle();
  if (orgError || !org) return null;

  let rows = loadedRows;
  if (!rows) {
    const { data, error } = await client
      .from('organization_members')
      .select('id, license_status, invitation_expires_at, user_id')
      .eq('organization_id', organizationId);
    if (error || !data) return null;
    rows = data as SeatRow[];
  }

  return orgHasFreeSeat(org as OrgSeatInfo, rows, Date.now());
}

/**
 * The ONE membership a page shows or scopes to — BACKLOG-3851.
 *
 * A user can hold two membership rows: a deactivated (suspended / expired)
 * brokerage row and their own personal organization's row, which the database
 * attaches on deactivation (pay-as-you-go). Readers that asked for "the" row
 * with `.maybeSingle()` got PGRST116 and `data: null` for that user. Every such
 * reader reads all rows, ordered (`created_at`, then `id`), and takes the
 * organization classifyPortalAccess routes on, so the account page, the
 * impersonation scope and the portal's routing name the same organization.
 *
 * Classifier answers:
 *   full / floor -> that organization (a reverted member: the personal one);
 *   none         -> the first row, if any (a member of someone else's personal
 *                   organization: what the single-row read returned before);
 *   unknown      -> null (the read failed).
 */

import { classifyPortalAccess, type PortalMembershipRow } from '@/lib/auth/membership';

export interface RoutedMembership {
  role: string;
  organization_id: string;
}

export function routedMembership(
  rows: PortalMembershipRow[] | null | undefined,
  userId: string
): RoutedMembership | null {
  const access = classifyPortalAccess(rows, userId);
  if (access.kind === 'full' || access.kind === 'floor') {
    return { role: access.role, organization_id: access.organizationId };
  }
  if (access.kind === 'none' && Array.isArray(rows) && rows[0]) {
    return { role: rows[0].role, organization_id: rows[0].organization_id };
  }
  return null;
}

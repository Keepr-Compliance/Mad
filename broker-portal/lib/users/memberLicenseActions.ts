/**
 * Which licence actions a member row offers on the Users page — BACKLOG-3851 PR-2b.
 *
 * ONE rule, imported by the list menu (UserActionsDropdown, via UserTableRow and
 * UserCard) and by the detail page (UserDetailsCard), so the two cannot drift.
 * Deactivated = memberStatusIsDeactivated (suspended OR expired); never a bare
 * `=== 'suspended'`.
 *
 * | row license_status      | claimed | licence action | Deactivate |
 * |-------------------------|---------|----------------|------------|
 * | active                  | yes     | unassign       | yes        |
 * | unassigned              | yes     | assign         | yes        |
 * | suspended / expired     | yes     | reactivate     | no         |
 * | pending (invite)        | no      | none           | no         |
 *
 * An admin viewing an it_admin row gets no licence action (the database refuses
 * it: only an it_admin may change an it_admin). Own row: the callers hide the
 * whole menu, as before.
 */

import { MEMBER_UNASSIGNED_STATUS, memberStatusIsDeactivated } from '@keepr/shared';

/**
 * Release switch for the Assign / Unassign licence buttons.
 *
 * true  = both buttons are shown (default).
 * false = neither is shown; Reactivate, Deactivate and every other action are
 *         unchanged.
 *
 * This hides UI only. The server action and the database function stay
 * callable either way; flipping this changes no permission.
 */
export const MEMBER_LICENSE_ASSIGN_UNASSIGN_ENABLED = true;

export type MemberLicenseAction = 'assign' | 'unassign' | 'reactivate';

export interface MemberLicenseRowInput {
  /** The row's organization_members.license_status. */
  licenseStatus: string | null | undefined;
  /** False for an unclaimed invite (no user_id). */
  isClaimed: boolean;
  /** The row's role. */
  targetRole: string;
  /** The signed-in caller's role in this organization. */
  callerRole: string;
}

export interface MemberRowActions {
  licenseAction: MemberLicenseAction | null;
  showDeactivate: boolean;
}

export function memberRowActions(
  input: MemberLicenseRowInput,
  assignUnassignEnabled: boolean = MEMBER_LICENSE_ASSIGN_UNASSIGN_ENABLED
): MemberRowActions {
  if (!input.isClaimed) return { licenseAction: null, showDeactivate: false };

  const deactivated = memberStatusIsDeactivated(input.licenseStatus);
  const showDeactivate = !deactivated;

  const callerMayChangeTarget = input.targetRole !== 'it_admin' || input.callerRole === 'it_admin';
  if (!callerMayChangeTarget) return { licenseAction: null, showDeactivate };

  let licenseAction: MemberLicenseAction | null = null;
  if (deactivated) licenseAction = 'reactivate';
  else if (input.licenseStatus === 'active') licenseAction = assignUnassignEnabled ? 'unassign' : null;
  else if (input.licenseStatus === MEMBER_UNASSIGNED_STATUS) licenseAction = assignUnassignEnabled ? 'assign' : null;

  return { licenseAction, showDeactivate };
}

export const MEMBER_LICENSE_ACTION_LABELS: Record<MemberLicenseAction, string> = {
  assign: 'Assign license',
  unassign: 'Unassign license',
  reactivate: 'Reactivate User',
};

/** Messages the setMemberLicense action returns (a 'use server' file may export only async functions). */
export const MEMBER_LICENSE_ERRORS = {
  notAuthenticated: 'Not authenticated',
  notFound: 'Member not found',
  notAuthorized: 'Not authorized',
  lastManager: 'Cannot unassign the last admin.',
  invalidTransition: "This member's license cannot be changed that way. Refresh the page.",
  failed: 'Failed to update license',
} as const;

/**
 * Admin name edit (BACKLOG-3991). Shared by the action, the card and the modal.
 *
 * An admin or it_admin may edit a member's first and last name only when the
 * brokerage manages users by hand (no JIT, no SCIM, no directory sync). The
 * database (set_member_name, org_names_directory_managed) is the authority; the
 * card mirrors its rules only to decide whether to show the button.
 */

import { memberStatusIsDeactivated } from '@keepr/shared';
import type { MemberLicenseStatus, Role } from '@/lib/types/users';

export const MEMBER_NAME_MAX_LENGTH = 100;

export const MEMBER_NAME_NOTE = 'Updates from Microsoft or Google at the next sign-in.';

export const MEMBER_NAME_ERRORS = {
  notAuthenticated: 'Not authenticated',
  notFound: 'Member not found',
  notAuthorized: 'Not authorized',
  refused: "You can't edit this person's name.",
  directoryManaged: 'This brokerage manages names through Microsoft/Google sign-in or directory sync.',
  invalidName: 'Enter a first or last name (100 characters or fewer).',
  failed: 'Something went wrong. Please try again.',
} as const;

/** Trim like the database does for ordinary input; '' becomes null. */
export function normaliseMemberName(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The same refusals the database gives for bad input, checked before the call so
 * the modal can answer at once: both names empty, one over 100 characters, or a
 * control character / line break inside. The database re-checks.
 */
export function memberNameInputError(first: string, last: string): string | null {
  const f = normaliseMemberName(first);
  const l = normaliseMemberName(last);
  if (f === null && l === null) return MEMBER_NAME_ERRORS.invalidName;
  for (const v of [f, l]) {
    if (v === null) continue;
    if (v.length > MEMBER_NAME_MAX_LENGTH) return MEMBER_NAME_ERRORS.invalidName;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(v)) return MEMBER_NAME_ERRORS.invalidName;
  }
  return null;
}

/**
 * Whether the card shows "Edit name". namesEditable is the database's answer for
 * the target's organization (org_names_directory_managed = false). The rest mirrors
 * set_member_name: admin / it_admin only, not their own row, an admin never edits
 * an it_admin, never a deactivated member.
 */
export function canShowEditName(input: {
  namesEditable: boolean;
  callerRole: Role;
  targetRole: Role;
  isCurrentUser: boolean;
  licenseStatus: MemberLicenseStatus;
}): boolean {
  if (!input.namesEditable || input.isCurrentUser) return false;
  if (input.callerRole !== 'admin' && input.callerRole !== 'it_admin') return false;
  if (input.callerRole === 'admin' && input.targetRole === 'it_admin') return false;
  return !memberStatusIsDeactivated(input.licenseStatus);
}

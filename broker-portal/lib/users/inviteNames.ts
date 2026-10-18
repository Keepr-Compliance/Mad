/**
 * Optional first and last name typed on a broker-portal invite — BACKLOG-3851 PR-2f (S1).
 *
 * Stored on organization_members.invited_first_name / invited_last_name (M4a), shown
 * in Users until the person signs in, used as "Hi <first>," in the invite email, and
 * copied into public.users on accept when the person's own name is blank (M4).
 */

/** organization_members CHECK (char_length <= 100). */
export const INVITE_NAME_MAX_LENGTH = 100;

/** Trimmed; empty -> null. */
export function normalizeInviteName(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function inviteNameTooLong(value: string | null): boolean {
  return value !== null && value.length > INVITE_NAME_MAX_LENGTH;
}

/** "First Last" for a pending invite, or null when neither name was given. */
export function invitedDisplayName(first: string | null | undefined, last: string | null | undefined): string | null {
  const name = [normalizeInviteName(first), normalizeInviteName(last)].filter(Boolean).join(' ');
  return name.length > 0 ? name : null;
}

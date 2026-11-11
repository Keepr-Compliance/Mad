/**
 * BACKLOG-3976: role options and refusal wording for the admin-portal role change.
 * Kept out of the 'use server' file so the client table can import them.
 * The refusal sentences match broker-portal/lib/users/roleRefusals.ts.
 */

export type MemberRole = 'agent' | 'broker' | 'admin' | 'it_admin';

export const MEMBER_ROLE_OPTIONS: { value: MemberRole; label: string }[] = [
  { value: 'agent', label: 'Agent' },
  { value: 'broker', label: 'Broker' },
  { value: 'admin', label: 'Admin' },
  { value: 'it_admin', label: 'IT Admin' },
];

export const LAST_ADMIN_DEMOTE_REFUSED =
  "Can't demote the brokerage's last admin. Make another member an admin first, then try again.";
export const ROLE_MANAGED_BY_IDP = "This member's role is managed by the brokerage's identity provider.";

/** admin_update_org_member_role returns these codes in { success: false, error }. */
const RPC_ERROR_MAP: Record<string, string> = {
  not_authenticated: 'Not authenticated',
  not_internal_user: 'Not authorized to change roles',
  insufficient_permissions: 'Not authorized to change roles',
  invalid_role: 'Invalid role',
  cannot_change_own_role: "You can't change your own role",
  not_a_member: 'This user is not a member of this organization',
  role_unchanged: 'The member already has this role',
};

/**
 * Wording for a refusal. `code` is the RPC's error code; `dbMessage` is a raised database error
 * (the shared triggers raise 'last_admin' and 'managed_by_idp', as on the broker-portal Users page).
 */
export function describeRoleChangeError(code: string | null | undefined, dbMessage?: string | null): string {
  if (dbMessage?.includes('last_admin')) return LAST_ADMIN_DEMOTE_REFUSED;
  if (dbMessage?.includes('managed_by_idp')) return ROLE_MANAGED_BY_IDP;
  if (dbMessage) return 'Failed to change role';
  return (code && RPC_ERROR_MAP[code]) || 'Failed to change role';
}

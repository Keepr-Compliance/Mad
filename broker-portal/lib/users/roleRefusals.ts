/**
 * BACKLOG-4027: Users-page wording for the database's role refusals.
 * - last_admin (P0001, _guard_last_admin): the brokerage would be left with no active admin.
 * - managed_by_idp (42501, _guard_idp_role): the identity provider owns this member's role.
 */
export const LAST_ADMIN_DEMOTE_REFUSED = 'Cannot demote the last admin. Assign another admin first.';
export const ROLE_MANAGED_BY_IDP = 'Managed by your identity provider.';

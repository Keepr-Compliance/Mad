/**
 * Who may use People (the brokerage's IT, office and MSP contacts and its billing contact) —
 * BACKLOG-4007 PR-4 (founder e8571c1f), People v2 (founder R7).
 *
 * ONE definition for the broker portal: the /dashboard/settings page gate (checkOrgSettingsAccess), the sidebar entry and
 * the server actions in lib/actions/orgContacts.ts all read these lists. The database rule is
 * the same set, in public._org_people_caller and the gates of org_contact_save /
 * org_people_invite (migration 20261020200000): kinds 'admin', 'broker', 'it_admin', each with
 * an active license. A parity test (__tests__/billing-login-4007/peopleRoles.test.tsx) reads
 * that SQL and fails if the two drift.
 *
 * Client-safe: no server imports here (the sidebar is a client component).
 */

/** May open People and add, change or remove IT, office and MSP contacts. */
export const PEOPLE_ROLES = ['admin', 'it_admin', 'broker'] as const;

/** May change the billing contact. Not an IT admin: billing details are Broker/Admin only (3855). */
export const PEOPLE_BILLING_ROLES = ['admin', 'broker'] as const;

/**
 * May set the IT contact and IT provider (MSP), which creates or promotes an IT admin. Not a
 * broker (founder R7, 2026-10-20). Keepr staff also may, in the admin portal.
 */
export const PEOPLE_IT_ROLES = ['admin', 'it_admin'] as const;

/** May write a person's phone from People. Not an IT admin (SR R3). */
export const PEOPLE_PHONE_ROLES = ['admin', 'broker'] as const;

export function mayUsePeople(role: string | null | undefined): boolean {
  return !!role && (PEOPLE_ROLES as readonly string[]).includes(role);
}

export function mayEditBillingPeople(role: string | null | undefined): boolean {
  return !!role && (PEOPLE_BILLING_ROLES as readonly string[]).includes(role);
}

export function mayEditItPeople(role: string | null | undefined): boolean {
  return !!role && (PEOPLE_IT_ROLES as readonly string[]).includes(role);
}

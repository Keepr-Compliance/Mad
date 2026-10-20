/**
 * Who may use People (the brokerage's IT, office and MSP contacts, its billing contact and the
 * one billing-only login) — BACKLOG-4007 PR-4, founder e8571c1f.
 *
 * ONE definition for the broker portal: the /dashboard/people page gate, the sidebar entry and
 * the server actions in lib/actions/orgContacts.ts all read these two lists. The database rule
 * is the same set, in public._org_contact_caller (migration 20261020180000): 'broker' kind =
 * role broker or admin, 'it_admin' kind = role it_admin, both with an active license. A parity
 * test (__tests__/billing-login-4007/peopleRoles.test.ts) reads that SQL and fails if the two
 * drift.
 *
 * Client-safe: no server imports here (the sidebar is a client component).
 */

/** May open People and add, change or remove IT, office and MSP contacts. */
export const PEOPLE_ROLES = ['admin', 'it_admin', 'broker'] as const;

/**
 * May also change the billing contact and turn the billing-only login on or off. Not an IT
 * admin: billing details are Broker/Admin only (3855).
 */
export const PEOPLE_BILLING_ROLES = ['admin', 'broker'] as const;

export function mayUsePeople(role: string | null | undefined): boolean {
  return !!role && (PEOPLE_ROLES as readonly string[]).includes(role);
}

export function mayEditBillingPeople(role: string | null | undefined): boolean {
  return !!role && (PEOPLE_BILLING_ROLES as readonly string[]).includes(role);
}

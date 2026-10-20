/**
 * Roles shown the Pay button on a suspended brokerage's Billing page (BACKLOG-3853). Agents never
 * reach the page. 'billing_contact' is the brokerage's billing-only login (BACKLOG-4007 PR-4):
 * not a database role, the page passes it for that person.
 */
export const ORG_PAYER_ROLES: readonly string[] = ['broker', 'admin', 'it_admin', 'billing_contact'];

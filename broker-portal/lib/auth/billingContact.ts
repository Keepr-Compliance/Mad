/**
 * Is this person their brokerage's billing-only login? — BACKLOG-4007 PR-4.
 *
 * The billing-only login is an organization member with no license ('unassigned', floor via
 * 'unlicensed') who is linked from the brokerage's live billing contact. It holds no seat and
 * may open Billing (view and pay) on top of the floor (dashboard, My Account, Support). Nothing
 * else.
 *
 * The database answers, for the signed-in caller only: `org_billing_contact_login(p_org)`
 * (migration 20261020180000, SECURITY DEFINER, GRANT authenticated). org_contacts has no client
 * grants, so this RPC is the only read.
 *
 * Asked only for floor via 'unlicensed'. Everyone else reads false without a call. A failed
 * read is false (fail closed): the person keeps the floor.
 *
 * Edge-safe: imports one type. Middleware calls it.
 */

import type { PortalAccess } from '@keepr/shared';

/** The role string the Billing page and its banner use for this person. Never a database role. */
export const BILLING_CONTACT_ROLE = 'billing_contact';

interface RpcReader {
  rpc: (_fn: string, _args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
}

/** The access this question is ever asked for. */
export function mayBeBillingContact(access: PortalAccess | undefined | null): access is Extract<PortalAccess, { kind: 'floor' }> {
  return !!access && access.kind === 'floor' && access.via === 'unlicensed';
}

export async function readBillingContactLogin(
  client: RpcReader,
  access: PortalAccess | undefined | null
): Promise<boolean> {
  if (!mayBeBillingContact(access)) return false;
  try {
    const { data, error } = await client.rpc('org_billing_contact_login', { p_org: access.organizationId });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

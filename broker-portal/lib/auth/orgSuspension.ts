/**
 * Is this person's BROKERAGE suspended? — BACKLOG-3853 PR-2B.
 *
 * A suspended brokerage is `org_deals.status = 'suspended'`, asked through
 * `org_billing_suspended(p_org)` (migration 20261018230000, SECURITY DEFINER,
 * GRANT authenticated, returns a boolean). This is NOT BACKLOG-3878's signal:
 * suspending a brokerage leaves every member's own licence 'active', so
 * lib/auth/suspension.ts reads false for all of them.
 *
 * Asked only for an access that routes on a brokerage: kind 'full', and floor via
 * 'brokerage' (an agent). Everyone else is never asked: 'unknown' has no
 * organization, a personal organization has no deal, and an unlicensed or
 * deactivated member already sees the floor only.
 *
 * Returns true / false, or null when the read failed. Pages and middleware treat
 * null as not suspended and log ORG_SUSPENSION_READ_FAILED: every data path is
 * refused in the database on its own (plan 2cafe0ef §2); the portal only explains.
 *
 * Edge-safe: imports one type. Middleware calls it.
 */

import type { PortalAccess } from '@keepr/shared';

/** The only thing ever logged for a failed read: a static code, never the error. */
export const ORG_SUSPENSION_READ_FAILED = 'org_suspension_read_failed';

/** The text the member trigger carries as its HINT (plan v2 G5). */
export const BROKERAGE_SUSPENDED_ERROR = 'This brokerage account is suspended. Contact Keepr to restore it.';

interface RpcReader {
  rpc: (_fn: string, _args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
}

/** The brokerage this access routes on, or null when it routes on none. */
export function brokerageOrgOf(access: PortalAccess | undefined | null): string | null {
  if (!access) return null;
  if (access.kind === 'full') return access.organizationId;
  if (access.kind === 'floor' && access.via === 'brokerage') return access.organizationId;
  return null;
}

/** An access with no brokerage is never asked and reads false. null = the read failed. */
export async function readOrgBillingSuspended(client: RpcReader, access: PortalAccess | undefined | null): Promise<boolean | null> {
  const org = brokerageOrgOf(access);
  if (!org) return false;
  return readOrgBillingSuspendedFor(client, org);
}

/**
 * The same question for one organization id. BACKLOG-4007 PR-4: the Billing page asks it for
 * the billing-only login, whose access (floor via 'unlicensed') brokerageOrgOf never names.
 */
export async function readOrgBillingSuspendedFor(client: RpcReader, org: string): Promise<boolean | null> {
  try {
    const { data, error } = await client.rpc('org_billing_suspended', { p_org: org });
    if (error) return null;
    return data === true;
  } catch {
    return null;
  }
}

/**
 * The member trigger's refusal (_billing_guard_member_while_suspended):
 * `RAISE EXCEPTION 'account_suspended' USING ERRCODE = 'P0001'`. Code AND message,
 * as isInviteSeatRefusal matches its own.
 */
export function isBrokerageSuspendedError(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && error.code === 'P0001' && error.message === 'account_suspended';
}

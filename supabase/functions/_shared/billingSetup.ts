/**
 * BACKLOG-4012: no one joins a brokerage through directory sync or SCIM while its billing
 * setup is pending (a 'draft' deal that is not $0).
 *
 * The database is the enforcement: the member trigger _billing_guard_idp_join_while_setup_pending
 * refuses the write with `billing_setup_incomplete` (SQLSTATE P0001). This module only lets the
 * Edge Functions recognise that refusal and ask the same question up front
 * (_billing_org_join_blocked, service_role only).
 *
 * No jsr imports: the client is injected so the module runs under jest as well as Deno.
 */

/** The trigger's message, also written to scim_sync_log.error_message. */
export const BILLING_SETUP_INCOMPLETE = "billing_setup_incomplete";

/** SCIM 403 detail while the brokerage's billing setup is pending. */
export const BILLING_SETUP_DETAIL =
  "This brokerage has not finished billing setup in Keepr. Users can be provisioned once setup is complete.";

/** The member trigger's refusal: code AND message. */
export function isBillingSetupIncompleteError(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  return !!error && error.code === "P0001" && error.message === BILLING_SETUP_INCOMPLETE;
}

// deno-lint-ignore no-explicit-any
type RpcClient = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: any }> };

/**
 * Are joins into this brokerage on hold? A failed read answers false (fail open): the trigger
 * still refuses every join, so a read error can only cost a clean skip, never admit anyone.
 */
export async function readJoinsBlocked(client: RpcClient, orgId: string): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("_billing_org_join_blocked", { p_org: orgId });
    if (error) {
      console.error(`[billing-setup] could not read join hold for org ${orgId}: ${error.message}`);
      return false;
    }
    return data === true;
  } catch (err) {
    console.error(`[billing-setup] could not read join hold for org ${orgId}:`, err);
    return false;
  }
}

/** organizations.directory_sync_error while people are held back (shown in the staff IdP panel). */
export function billingSkipMessage(skipped: number): string {
  return `Billing setup not finished: ${skipped} ${skipped === 1 ? "person" : "people"} not added yet.`;
}

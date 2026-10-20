/**
 * Brokerage billing setup — BACKLOG-4007 PR-3. One reader for "is this brokerage waiting for its
 * broker to finish the Billing step", used by the setup guide, the dashboard banner and the sign-in
 * callbacks.
 *
 * Source: broker_get_billing_setup(p_org) (migration 20261020100000 §9), called with the
 * SIGNED-IN user's client. It answers only a broker/admin with an active license in that
 * organization (IT admin, agent, other organizations -> 42501), so it is asked only for those roles.
 * state comes from org_deals.status: 'draft' -> 'waiting_for_setup'.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PortalAccess } from '@/lib/auth/membership';

/** broker_get_billing_setup's success shape (migration 20261020100000:684-701). */
export interface BillingSetupView {
  success: true;
  state: 'waiting_for_setup' | 'active' | 'canceling' | 'canceled' | 'suspended' | string;
  version: number;
  plan_name: string | null;
  seats: number;
  unit_price_cents: number | null;
  monthly_total_cents: number | null;
  start_date: string;
  billing_starts_on: string;
  account_manager: string | null;
  contact: { name: string; email: string; phone: string | null } | null;
  company: {
    legal_name: string;
    address_line1: string;
    address_line2: string | null;
    city: string;
    region: string | null;
    postal_code: string;
    country: string;
    po_number: string | null;
  } | null;
  me: { name: string; email: string } | null;
}

/** The setup guide (app/dashboard/setup/page.tsx). */
export const SETUP_GUIDE_PATH = '/dashboard/setup';

/** Roles the Billing step is for (3855 rule: billing details are Broker/Admin only). */
export const SETUP_ROLES = ['broker', 'admin'] as const;

export function setupRoleOf(access: PortalAccess | null | undefined): { organizationId: string; role: string } | null {
  if (!access || access.kind !== 'full') return null;
  if (!(SETUP_ROLES as readonly string[]).includes(access.role)) return null;
  return { organizationId: access.organizationId, role: access.role };
}

/** The Billing step's data, or null (no deal, not allowed, read failed). Never throws. */
export async function readBillingSetup(
  supabase: Pick<SupabaseClient, 'rpc'>,
  organizationId: string
): Promise<BillingSetupView | null> {
  try {
    const { data, error } = await supabase.rpc('broker_get_billing_setup', { p_org: organizationId });
    if (error) {
      console.warn('[billing/setup] broker_get_billing_setup failed', { code: error.code ?? 'unknown' });
      return null;
    }
    const v = data as BillingSetupView | { success: false } | null;
    return v && v.success === true ? v : null;
  } catch {
    return null;
  }
}

/**
 * Whether the setup guide has anything to show for this deal: it is waiting for setup, or it is
 * active with a billing start date. Canceled, suspended, canceling and dateless deals show
 * "nothing to set up".
 */
export function setupGuideApplies(view: Pick<BillingSetupView, 'state' | 'billing_starts_on'>): boolean {
  return view.state === 'waiting_for_setup' || (view.state === 'active' && !!view.billing_starts_on);
}

/** True only when the deal is known to be waiting for this broker/admin. Fails closed to false. */
export async function billingSetupPending(
  supabase: Pick<SupabaseClient, 'rpc'>,
  access: PortalAccess | null | undefined
): Promise<boolean> {
  const who = setupRoleOf(access);
  if (!who) return false;
  const view = await readBillingSetup(supabase, who.organizationId);
  return view?.state === 'waiting_for_setup';
}

/**
 * Where a sign-in should land for this membership: the setup guide while the deal waits for this
 * broker/admin, else null (the caller keeps its own destination). `licenseStatus` omitted = known
 * active (full portal access). Never throws; a failed read is null (the dashboard banner remains).
 */
export async function setupLanding(
  supabase: Pick<SupabaseClient, 'rpc'>,
  who: { organizationId: string | null | undefined; role: string | null | undefined; licenseStatus?: string | null }
): Promise<string | null> {
  if (!who.organizationId || !who.role || !(SETUP_ROLES as readonly string[]).includes(who.role)) return null;
  if (who.licenseStatus !== undefined && who.licenseStatus !== 'active') return null;
  const view = await readBillingSetup(supabase, who.organizationId);
  return view?.state === 'waiting_for_setup' ? SETUP_GUIDE_PATH : null;
}

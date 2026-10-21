/**
 * The brokerage plan's end, as the broker portal shows it — BACKLOG-4019.
 *
 * Read with the signed-in user's client through public.broker_get_plan_end, which admits an
 * active Broker or Admin of the brokerage, and anyone the auto-renew caller rule admits (the
 * Admin and the billing contact, including the billing-only login). can_change comes from the
 * database (the same rule set_org_auto_renew enforces); the page never decides it from a role.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface PlanEnd {
  state: 'none' | 'renewing' | 'ending' | 'ended';
  /** ISO time: the period end when ending, the end when ended; null otherwise. */
  endsOn: string | null;
  /** ISO time: the current period's end (the date auto-renew off would end the plan). */
  periodEnd: string | null;
  canChange: boolean;
  version: number | null;
}

/** null when the read fails or this person may not read it: the page then shows nothing. */
export async function readPlanEnd(client: SupabaseClient, organizationId: string): Promise<PlanEnd | null> {
  try {
    const { data, error } = await client.rpc('broker_get_plan_end', { p_org: organizationId });
    if (error || !data) return null;
    const d = data as { state?: string; ends_on?: string | null; period_end?: string | null; can_change?: boolean; version?: number | null };
    const state = d.state === 'renewing' || d.state === 'ending' || d.state === 'ended' ? d.state : 'none';
    return { state, endsOn: d.ends_on ?? null, periodEnd: d.period_end ?? null, canChange: d.can_change === true, version: typeof d.version === 'number' ? d.version : null };
  } catch {
    return null;
  }
}

/** "2026-10-30T12:00:00+00:00" -> "Oct 30, 2026", in Pacific time (the business date). */
export function formatPlanDate(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
}

/** The one line the dashboard and the Billing page show; null when there is nothing to say. */
export function planEndLine(p: PlanEnd | null): string | null {
  if (!p) return null;
  const date = formatPlanDate(p.endsOn);
  if (p.state === 'ending') {
    const on = date ? `on ${date}` : 'at the end of this billing period';
    return p.canChange ? `Your plan ends ${on}. Turn auto-renew back on in Billing.` : `Your plan ends ${on}. Contact support to keep it.`;
  }
  if (p.state === 'ended') {
    return `Your plan ended${date ? ` on ${date}` : ''}. Contact support to restart it.`;
  }
  return null;
}

/** Errors set_org_auto_renew can return, as sentences. */
const AUTO_RENEW_MESSAGES: Record<string, string> = {
  not_authorized: 'You do not have permission to change auto-renew.',
  deal_suspended: 'Contact Keepr to change your plan.',
  version_conflict: 'Your plan changed. Reload the page and try again.',
  no_subscription: 'Billing has not started yet. Try again in a minute.',
  already_ended: 'Your plan has already ended. Contact support to restart it.',
  deal_canceled: 'Your plan has already ended. Contact support to restart it.',
  deal_not_started: 'Billing has not started yet.',
  impersonation: 'Write operations are not allowed during impersonation sessions',
};

export function autoRenewErrorMessage(code: string | null | undefined): string {
  return (code && AUTO_RENEW_MESSAGES[code]) || 'Something went wrong. Nothing was changed.';
}

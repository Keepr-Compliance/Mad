/**
 * Brokerage deal rules for the admin-portal Billing card (BACKLOG-3853 PR-2A).
 *
 * The database decides (admin_save_deal); these helpers only mirror its rules for
 * the on-screen readout and turn its error codes into sentences.
 */

/** Shape returned by public.admin_get_org_billing(p_org). */
export interface OrgBilling {
  billing_live: boolean;
  is_test: boolean;
  list_price_cents: number | null;
  cap_pct: number;
  can_manage: boolean;
  can_approve: boolean;
  can_suspend: boolean;
  assigned_seats: number;
  deal: OrgDeal | null;
  seat_line: { unit_price_cents: number; list_price_cents_at_save: number | null; pct_off: number | null } | null;
  stripe: { stripe_mode: string; status: string | null; current_period_end: string | null; cancel_at_period_end: boolean } | null;
  account_managers: Array<{ id: string; name: string | null; email: string | null }>;
  log: Array<{ created_at: string; action: string; detail: Record<string, unknown>; actor: string | null }>;
}

export interface OrgDeal {
  organization_id: string;
  stripe_mode: 'test' | 'live';
  status: 'draft' | 'active' | 'suspended' | 'canceling' | 'canceled';
  seats: number;
  start_date: string;
  account_manager_id: string | null;
  billing_contact_name: string | null;
  billing_contact_email: string | null;
  suspended_at: string | null;
  suspended_reason: 'non_payment' | 'other' | null;
  suspended_note: string | null;
  version: number;
}

/**
 * The Billing card is shown only while brokerage billing is switched on, or for a
 * test organization (SR R14 (c)). Everything else stays dark.
 */
export function shouldShowBillingCard(b: OrgBilling | null | undefined): b is OrgBilling {
  return !!b && (b.billing_live === true || b.is_test === true);
}

/** "24.99" -> 2499. Returns null for anything that is not a non-negative amount with at most 2 decimals. */
export function centsFromDollars(input: string): number | null {
  const s = input.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

/** Percent below list, rounded to 2 decimals: the same formula as org_deal_lines.pct_off. */
export function pctOff(listCents: number, priceCents: number): number {
  return Math.round((10000 * (listCents - priceCents)) / listCents) / 100;
}

export type PriceCheck =
  | { kind: 'at_list' }
  | { kind: 'above_list' }
  | { kind: 'within_cap'; pct: number }
  | { kind: 'kept'; pct: number }
  | { kind: 'approver'; pct: number }
  | { kind: 'needs_approval'; pct: number };

/** Mirror of admin_save_deal's cap rule, for the readout under the price field. */
export function checkPrice(args: {
  listCents: number;
  priceCents: number;
  capPct: number;
  canApprove: boolean;
  currentCents: number | null;
}): PriceCheck {
  const { listCents, priceCents, capPct, canApprove, currentCents } = args;
  if (priceCents === listCents) return { kind: 'at_list' };
  if (priceCents > listCents) return { kind: 'above_list' };
  const pct = pctOff(listCents, priceCents);
  if (pct <= capPct) return { kind: 'within_cap', pct };
  if (canApprove) return { kind: 'approver', pct };
  if (currentCents != null && priceCents >= currentCents) return { kind: 'kept', pct };
  return { kind: 'needs_approval', pct };
}

const MESSAGES: Record<string, string> = {
  reason_required: 'Enter a reason. Every deal change is logged with who and why.',
  billing_contact_required: 'Enter the billing contact email. Invoices are sent there.',
  invalid_price: 'Enter a price per seat.',
  invalid_account_manager: 'The account manager must be a Keepr Sales user.',
  discount_needs_approval: 'This price is deeper than the Sales cap. A Super Admin has to save it.',
  no_price: 'The price book has no seat price. Nothing was saved.',
  billing_not_live: 'Brokerage billing is not switched on yet. Only test organizations can have a deal.',
  invalid_stripe_mode: 'This portal has no billing mode configured. Nothing was saved.',
  stripe_mode_mismatch: 'This deal was set up in a different billing mode. Nothing was saved.',
  invalid_seats: 'Enter at least 1 seat.',
  seats_below_assigned: 'More licenses are assigned than that. Unassign some before lowering the seats.',
  no_plan: 'Assign a plan to this organization first.',
  version_conflict: 'Someone else changed this deal. Reload the page and try again.',
  no_deal: 'This organization has no deal yet.',
  deal_not_active: 'Only an active deal can be suspended.',
  not_suspended: 'This organization is not suspended.',
  invalid_reason: 'Choose a suspension reason.',
  not_authorized: 'You do not have permission to do this.',
  mode_not_configured: 'This portal has no billing mode configured (STRIPE_MODE). Nothing was saved.',
  note_required: 'Enter a note. It is saved in the change log.',
};

export function dealErrorMessage(code: string | null | undefined, detail?: { pct_off?: number; cap_pct?: number; assigned?: number }): string {
  if (!code) return 'Something went wrong. Nothing was saved.';
  if (code === 'discount_needs_approval' && detail?.pct_off != null && detail?.cap_pct != null) {
    return `This price is ${detail.pct_off}% below list, deeper than the Sales cap of ${detail.cap_pct}%. A Super Admin has to save it.`;
  }
  if (code === 'seats_below_assigned' && detail?.assigned != null) {
    return `${detail.assigned} licenses are assigned. Unassign some before going below ${detail.assigned} seats.`;
  }
  return MESSAGES[code] ?? 'Something went wrong. Nothing was saved.';
}

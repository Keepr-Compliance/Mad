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
  /** BACKLOG-4007: the one business date (Pacific) every "today" rule uses, yyyy-mm-dd. */
  business_date: string;
  deal: OrgDeal | null;
  /** From deal status only: 'draft' -> 'waiting_for_setup'. null when there is no deal. */
  state: 'waiting_for_setup' | 'active' | 'suspended' | 'canceling' | 'canceled' | null;
  contact: OrgBillingContact | null;
  company: OrgBillingCompany | null;
  terms_accepted: { at: string; deal_version: number; terms_version: string; by: string | null } | null;
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
  /** Day Stripe billing starts; set when the broker finishes setup. */
  billing_starts_on: string | null;
  setup_completed_at: string | null;
  billing_contact_id: string | null;
}

export interface OrgBillingContact {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  has_login: boolean;
}

export interface OrgBillingCompany {
  legal_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  po_number: string | null;
}

/** Badge for the deal state. Keyed on deal.status (never on setup_completed_at). */
export const DEAL_STATUS_BADGE: Record<OrgDeal['status'], { label: string; hue: 'green' | 'red' | 'amber' | 'gray' }> = {
  draft: { label: 'Waiting for customer setup', hue: 'amber' },
  active: { label: 'Active', hue: 'green' },
  suspended: { label: 'Suspended', hue: 'red' },
  canceling: { label: 'Cancel pending', hue: 'amber' },
  canceled: { label: 'Canceled', hue: 'gray' },
};

/** "2026-10-24" -> "Oct 24, 2026". A date with no time: never shifted by the viewer's time zone. */
export function formatDay(day: string | null | undefined, fallback = 'Not set'): string {
  const m = day ? /^(\d{4})-(\d{2})-(\d{2})/.exec(day) : null;
  if (!m) return fallback;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

/** The start date can be chosen on a new deal and changed while it waits for customer setup. */
export function startDateEditable(deal: OrgDeal | null): boolean {
  return !deal || deal.status === 'draft';
}

/**
 * Client mirror of _billing_save_deal's start-date rule: today (business date) or later.
 * A waiting deal whose date is unchanged is not re-checked (the database skips it too).
 * Returns an error code or null. Dates are yyyy-mm-dd strings and compare as strings.
 */
export function checkStartDate(value: string, businessDate: string, existing: string | null): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'invalid_start_date';
  if (existing != null && value === existing) return null;
  if (value < businessDate) return 'start_date_past';
  return null;
}

/** The Stripe subscription line on the Billing card. */
export function subscriptionLine(b: OrgBilling): { value: string; help?: string } | null {
  const deal = b.deal;
  if (!deal) return null;
  if (deal.status === 'draft') {
    return { value: 'Not started', help: `Starts when the broker finishes billing setup, or ${formatDay(deal.start_date)} if later.` };
  }
  const status = b.stripe?.status ?? null;
  if (status === 'trialing') {
    return { value: `Billing starts ${formatDay(deal.billing_starts_on ?? deal.start_date)}` };
  }
  if (!status) return { value: 'Not created yet' };
  return { value: status.charAt(0).toUpperCase() + status.slice(1).replace('_', ' ') };
}

/**
 * The Billing card is shown only while brokerage billing is switched on, or for a
 * test organization (SR R14 (c)). Everything else stays dark.
 */
export function shouldShowBillingCard(b: OrgBilling | null | undefined): b is OrgBilling {
  return !!b && (b.billing_live === true || b.is_test === true);
}

/**
 * Create Organization: is brokerage billing live? Same switch as the Billing card
 * (billing_live, read via admin_get_brokerage_billing_live). There is no organization yet,
 * so the card's is_test half does not apply. A failed read (e.g. the function is not
 * deployed on that environment) counts as off, the same way the card stays hidden when
 * admin_get_org_billing cannot be read.
 */
export function billingLiveForNewOrg(read: { data: unknown; error: unknown }): boolean {
  return !read.error && read.data === true;
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
  /** Seat price already on the deal, or null when there is no deal or it is canceled. */
  currentCents: number | null;
  seats: number;
  currentSeats: number | null;
}): PriceCheck {
  const { listCents, priceCents, capPct, canApprove, currentCents, seats, currentSeats } = args;
  if (priceCents === listCents) return { kind: 'at_list' };
  if (priceCents > listCents) return { kind: 'above_list' };
  const pct = pctOff(listCents, priceCents);
  if (pct <= capPct) return { kind: 'within_cap', pct };
  if (canApprove) return { kind: 'approver', pct };
  // Founder ruling: Sales may keep an approved deep price or raise it toward list, and lower the
  // seats; raising the seats or lowering the price needs a Super Admin.
  if (currentCents != null && priceCents >= currentCents && currentSeats != null && seats <= currentSeats) {
    return { kind: 'kept', pct };
  }
  return { kind: 'needs_approval', pct };
}

const MESSAGES: Record<string, string> = {
  reason_required: 'Enter a reason. Every deal change is logged with who and why.',
  billing_contact_required: 'Enter a valid billing contact email.',
  start_date_past: 'Pick today or a later start date.',
  start_date_locked: 'The start date is locked once the customer has finished setup.',
  invalid_start_date: 'Enter a start date.',
  invalid_price: 'Enter a price per seat.',
  invalid_account_manager: 'The account manager must be a Keepr Sales or Super Admin user.',
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

/** What the change log records for a deal created without a typed reason. */
export const NEW_DEAL_REASON = 'Deal created';

/**
 * The reason sent with a save. A NEW deal (no deal row yet) needs none: the log gets
 * "Deal created". Every edit, including restarting a canceled deal, needs a typed reason;
 * null means refuse the save.
 */
export function resolveDealReason(hasDeal: boolean, typed: string): string | null {
  if (!hasDeal) return NEW_DEAL_REASON;
  return typed.trim() ? typed : null;
}

/** Entries the change log shows before "Show more". */
export const CHANGE_LOG_PAGE = 5;

/** Newest-first log: the first CHANGE_LOG_PAGE entries, or all of them once expanded. */
export function visibleChangeLog<T>(log: readonly T[], expanded: boolean): { visible: T[]; hidden: number } {
  if (expanded || log.length <= CHANGE_LOG_PAGE) return { visible: [...log], hidden: 0 };
  return { visible: log.slice(0, CHANGE_LOG_PAGE), hidden: log.length - CHANGE_LOG_PAGE };
}

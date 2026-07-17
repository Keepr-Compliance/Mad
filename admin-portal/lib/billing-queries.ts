/**
 * Billing & Credits queries — support-facing, READ-ONLY (BACKLOG-2020).
 *
 * Server-side data layer for the "Billing & Credits" section on the user
 * detail page. All reads use the service-role client and are scoped to a
 * single viewed user. Nothing here mutates state — grant/refund/suspend
 * flows are separate tickets (BACKLOG-2016 / 2078 / 2077).
 *
 * Data sources (all cloud-native, already live):
 * - RPC get_credit_balance(p_user_id)   → current credit balance (a stock)
 * - RPC get_next_unlock_quote(p_user_id)→ current PAYG tier price + ladder position
 * - credit_ledger        → append-only money/credit ledger (never deleted)
 * - transaction_unlocks  → paid entitlements (drives the PAYG tier ladder)
 * - credit_pricing_tiers → the PAYG discount ladder definition
 *
 * Stripe receipt links: admin-portal has no Stripe SDK/secret. Rather than
 * fetch charge.receipt_url live per row (heavy; would couple this portal to
 * Stripe), we surface the stripe_payment_intent_id (stored on ledger.metadata)
 * as a deep link into the Stripe Dashboard, where support can view/resend the
 * receipt. See stripeDashboardPaymentUrl() and the task report for the tradeoff.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A ledger entry as displayed in the support ledger table.
 *
 * entry_type is constrained by credit_ledger_type_ck to exactly
 * `purchase | debit | adjustment` — there is NO 'grant' entry type. Grants are
 * recorded as `adjustment` rows with amount > 0; clawbacks/corrections as
 * `adjustment` with amount < 0. `funding_source='grant'` appears only on debit
 * rows (a debit that consumed a previously granted credit — consumption, not
 * issuance).
 */
export interface CreditLedgerRow {
  id: string;
  entry_type: string; // purchase | debit | adjustment
  amount: number; // signed credit delta
  reason: string | null;
  unit_price_cents: number | null;
  funding_source: string | null; // e.g. purchase | grant (on debit rows)
  /** Pre-resolved Stripe Dashboard payment URL (purchase rows), or null. */
  stripe_dashboard_url: string | null;
  /** Raw Stripe payment_intent id (purchase rows), for display, or null. */
  stripe_payment_intent_id: string | null;
  created_at: string;
}

/** A transaction unlock (paid entitlement) as displayed in the refunds summary. */
export interface UnlockRow {
  id: string;
  local_transaction_id: string | null;
  funding_source: string | null;
  counts_toward_tier: boolean;
  unlocked_at: string;
  refunded_at: string | null;
}

/** One band of the PAYG discount ladder. */
export interface PricingTierRow {
  id: string;
  min_units: number;
  max_units: number | null;
  unit_price_cents: number;
  currency: string;
}

/** Shape returned by get_next_unlock_quote. */
export interface UnlockQuote {
  next_unit_index: number;
  unit_price_cents: number;
  currency: string;
  pricing_tier_id: string;
  current_band_max_units: number | null;
  units_until_next_band: number | null;
  next_band_unit_price_cents: number | null;
}

/** Everything the BillingCreditsCard needs, assembled server-side. */
export interface BillingData {
  creditBalance: number;
  ledger: CreditLedgerRow[];
  unlocks: UnlockRow[];
  pricingTiers: PricingTierRow[];
  quote: UnlockQuote | null;
  // Derived summary figures
  lifetimePaidUnlocks: number;
  grossPaidCents: number;
  grantsIssued: number;
  paidUnlocksThisYear: number;
  /**
   * True if ANY underlying read failed. A support money surface must never make
   * a transient error look like "no billing history", so the card renders a
   * visible degraded/error banner when this is set.
   */
  hasErrors: boolean;
  /** Human-readable list of which reads failed (for the degraded banner). */
  errorMessages: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Format cents as USD (e.g. 1499 → "$14.99"). Null/undefined → fallback. */
export function formatCents(cents: number | null | undefined, fallback = '--'): string {
  if (cents === null || cents === undefined) return fallback;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

/** Signed credit delta with an explicit + on positive values (e.g. "+1", "-1"). */
export function formatDelta(amount: number): string {
  if (amount > 0) return `+${amount}`;
  return String(amount);
}

/**
 * Display chip (human label + Tailwind classes) for a ledger row, keyed on
 * entry_type AND the sign of the amount.
 *
 * entry_type is only ever purchase | debit | adjustment (see CreditLedgerRow).
 * A positive adjustment is a support GRANT; a negative adjustment is a
 * clawback/correction — these must read differently, so we branch on the sign.
 */
export function entryChip(
  entryType: string,
  amount: number
): { label: string; classes: string } {
  switch (entryType) {
    case 'purchase':
      return { label: 'purchase', classes: 'bg-green-100 text-green-800' };
    case 'debit':
      return { label: 'debit', classes: 'bg-blue-100 text-blue-800' };
    case 'adjustment':
      return amount >= 0
        ? { label: 'grant', classes: 'bg-indigo-100 text-indigo-800' }
        : { label: 'clawback', classes: 'bg-orange-100 text-orange-800' };
    default:
      return { label: entryType, classes: 'bg-gray-100 text-gray-600' };
  }
}

/**
 * Deep link to a payment in the Stripe Dashboard.
 *
 * The account runs in TEST mode at launch (see broker-portal/lib/stripe.ts);
 * mode='live' once activated. Support opens the payment there to view or resend
 * the receipt (charge.receipt_url) — we do not fetch it live to keep this
 * portal free of the Stripe SDK/secret.
 *
 * `mode` MUST be resolved server-side and passed in explicitly. It is derived
 * from STRIPE_DASHBOARD_MODE, which is NOT a NEXT_PUBLIC_ var, so it would read
 * `undefined` (→ always test-mode) inside a client component. Callers use
 * resolveStripeDashboardMode() in a server context.
 */
export function stripeDashboardPaymentUrl(
  paymentIntentId: string,
  mode: 'test' | 'live'
): string {
  const segment = mode === 'live' ? '' : 'test/';
  return `https://dashboard.stripe.com/${segment}payments/${paymentIntentId}`;
}

/**
 * Resolve the Stripe Dashboard mode from server-side env. Call this only in a
 * server context (getBillingData). Defaults to 'test' at launch.
 */
export function resolveStripeDashboardMode(): 'test' | 'live' {
  return process.env.STRIPE_DASHBOARD_MODE === 'live' ? 'live' : 'test';
}

/** Find the pricing tier band that a given (1-based) unit index falls into. */
export function tierForUnitIndex(
  tiers: PricingTierRow[],
  unitIndex: number
): PricingTierRow | null {
  return (
    tiers.find(
      (t) =>
        unitIndex >= t.min_units &&
        (t.max_units === null || unitIndex <= t.max_units)
    ) ?? null
  );
}

/** Read the Stripe payment_intent id out of a ledger row's metadata blob. */
export function extractPaymentIntentId(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  if (!metadata) return null;
  const pi = metadata['stripe_payment_intent_id'];
  return typeof pi === 'string' && pi.length > 0 ? pi : null;
}

// ---------------------------------------------------------------------------
// Server-side fetch
// ---------------------------------------------------------------------------

interface RawLedgerRow {
  id: string;
  entry_type: string;
  amount: number;
  reason: string | null;
  unit_price_cents: number | null;
  funding_source: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/**
 * Load all billing/credit data for a single user.
 *
 * Uses the service-role client (RLS-bypassing) — call only from trusted
 * server contexts (the user-detail server component). Returns a fully
 * assembled, display-ready shape. Never throws on partial failure: missing
 * data degrades to empty tables / zeroed summaries so the tab still renders.
 */
export async function getBillingData(
  supabase: SupabaseClient,
  userId: string
): Promise<BillingData> {
  // UTC calendar-year boundary to match credit_period_start() (also UTC).
  const yearStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), 0, 1)
  ).toISOString();

  const dashboardMode = resolveStripeDashboardMode();

  const [balanceRes, quoteRes, ledgerRes, unlocksRes, tiersRes] = await Promise.all([
    supabase.rpc('get_credit_balance', { p_user_id: userId }),
    supabase.rpc('get_next_unlock_quote', { p_user_id: userId }),
    supabase
      .from('credit_ledger')
      .select(
        'id, entry_type, amount, reason, unit_price_cents, funding_source, metadata, created_at'
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
    supabase
      .from('transaction_unlocks')
      .select(
        'id, local_transaction_id, funding_source, counts_toward_tier, unlocked_at, refunded_at'
      )
      .eq('user_id', userId)
      .order('unlocked_at', { ascending: false }),
    supabase
      .from('credit_pricing_tiers')
      .select('id, min_units, max_units, unit_price_cents, currency')
      .eq('scope', 'individual')
      .is('effective_to', null)
      .order('min_units', { ascending: true }),
  ]);

  // A support money surface must never make a transient read error look like
  // "no billing history". Track every failing read so the card can surface a
  // visible degraded state instead of a silent empty section.
  const errorMessages: string[] = [];
  if (balanceRes.error) errorMessages.push(`Credit balance: ${balanceRes.error.message}`);
  if (quoteRes.error) errorMessages.push(`PAYG quote: ${quoteRes.error.message}`);
  if (ledgerRes.error) errorMessages.push(`Ledger: ${ledgerRes.error.message}`);
  if (unlocksRes.error) errorMessages.push(`Unlocks: ${unlocksRes.error.message}`);
  if (tiersRes.error) errorMessages.push(`Pricing tiers: ${tiersRes.error.message}`);

  const rawLedger = (ledgerRes.data ?? []) as RawLedgerRow[];
  const ledger: CreditLedgerRow[] = rawLedger.map((r) => {
    const pi = extractPaymentIntentId(r.metadata);
    return {
      id: r.id,
      entry_type: r.entry_type,
      amount: r.amount,
      reason: r.reason,
      unit_price_cents: r.unit_price_cents,
      funding_source: r.funding_source,
      stripe_payment_intent_id: pi,
      // Resolve the Stripe Dashboard URL SERVER-SIDE (env is not NEXT_PUBLIC_).
      stripe_dashboard_url: pi ? stripeDashboardPaymentUrl(pi, dashboardMode) : null,
      created_at: r.created_at,
    };
  });

  const unlocks = (unlocksRes.data ?? []) as UnlockRow[];
  const pricingTiers = (tiersRes.data ?? []) as PricingTierRow[];

  // A "paid" unlock counts toward the tier ladder and is not refunded.
  const paidUnlocks = unlocks.filter(
    (u) => u.counts_toward_tier && u.refunded_at === null
  );
  const paidUnlocksThisYear = paidUnlocks.filter(
    (u) => u.unlocked_at >= yearStart
  ).length;

  // Gross paid $ = sum of unit_price_cents on purchase ledger entries.
  const grossPaidCents = ledger
    .filter((l) => l.entry_type === 'purchase' && l.unit_price_cents !== null)
    .reduce((sum, l) => sum + (l.unit_price_cents ?? 0), 0);

  // Grants ISSUED = credit-ADDING adjustment rows. There is NO 'grant'
  // entry_type (credit_ledger_type_ck allows only purchase|debit|adjustment);
  // a support grant is an `adjustment` with amount > 0. Debit rows whose
  // funding_source='grant' are CONSUMPTION of a granted credit, not issuance.
  const grantsIssued = ledger.filter(
    (l) => l.entry_type === 'adjustment' && l.amount > 0
  ).length;

  const rawQuote = Array.isArray(quoteRes.data) ? quoteRes.data[0] : quoteRes.data;

  return {
    creditBalance: typeof balanceRes.data === 'number' ? balanceRes.data : 0,
    ledger,
    unlocks,
    pricingTiers,
    quote: (rawQuote as UnlockQuote | null) ?? null,
    lifetimePaidUnlocks: paidUnlocks.length,
    grossPaidCents,
    grantsIssued,
    paidUnlocksThisYear,
    hasErrors: errorMessages.length > 0,
    errorMessages,
  };
}

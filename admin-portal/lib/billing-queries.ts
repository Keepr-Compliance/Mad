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

/** A ledger entry as displayed in the support ledger table. */
export interface CreditLedgerRow {
  id: string;
  entry_type: string; // purchase | grant | debit | adjustment
  amount: number; // signed credit delta
  reason: string | null;
  unit_price_cents: number | null;
  funding_source: string | null; // purchase | grant | ...
  stripe_payment_intent_id: string | null; // from metadata (purchase rows)
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

/** Tailwind chip classes for a ledger entry type. */
export function entryTypeChipClasses(entryType: string): string {
  switch (entryType) {
    case 'purchase':
      return 'bg-green-100 text-green-800';
    case 'grant':
      return 'bg-indigo-100 text-indigo-800';
    case 'debit':
      return 'bg-blue-100 text-blue-800';
    case 'adjustment':
      return 'bg-yellow-100 text-yellow-800';
    default:
      return 'bg-gray-100 text-gray-600';
  }
}

/**
 * Deep link to a payment in the Stripe Dashboard.
 *
 * The account runs in TEST mode at launch (see broker-portal/lib/stripe.ts);
 * STRIPE_DASHBOARD_MODE can be set to 'live' once activated. Support opens the
 * payment there to view or resend the receipt (charge.receipt_url) — we do not
 * fetch it live to keep this portal free of the Stripe SDK/secret.
 */
export function stripeDashboardPaymentUrl(
  paymentIntentId: string,
  mode: string = process.env.STRIPE_DASHBOARD_MODE ?? 'test'
): string {
  const segment = mode === 'live' ? '' : 'test/';
  return `https://dashboard.stripe.com/${segment}payments/${paymentIntentId}`;
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
  const yearStart = new Date(new Date().getUTCFullYear(), 0, 1).toISOString();

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

  const rawLedger = (ledgerRes.data ?? []) as RawLedgerRow[];
  const ledger: CreditLedgerRow[] = rawLedger.map((r) => ({
    id: r.id,
    entry_type: r.entry_type,
    amount: r.amount,
    reason: r.reason,
    unit_price_cents: r.unit_price_cents,
    funding_source: r.funding_source,
    stripe_payment_intent_id: extractPaymentIntentId(r.metadata),
    created_at: r.created_at,
  }));

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

  // Grants ISSUED = credit-adding grant entries (entry_type 'grant').
  // NOT debit rows whose funding_source='grant' — those are debits that
  // consumed a previously granted credit, not a new grant.
  const grantsIssued = ledger.filter((l) => l.entry_type === 'grant').length;

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
  };
}

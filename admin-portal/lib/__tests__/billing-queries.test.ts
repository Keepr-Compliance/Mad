/**
 * Billing & Credits query-helper tests (BACKLOG-2020).
 *
 * Covers the pure display/derivation helpers used by the support-facing
 * Billing & Credits tab. The server fetch (getBillingData) is not tested here
 * as it requires a live Supabase client.
 */

import { describe, it, expect } from 'vitest';
import {
  formatCents,
  formatDelta,
  entryChip,
  stripeDashboardPaymentUrl,
  tierForUnitIndex,
  extractPaymentIntentId,
  getBillingData,
  ledgerView,
  INITIAL_LEDGER_COUNT,
  type PricingTierRow,
} from '../billing-queries';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('formatCents', () => {
  it('formats cents as USD', () => {
    expect(formatCents(1499)).toBe('$14.99');
    expect(formatCents(1300)).toBe('$13.00');
    expect(formatCents(0)).toBe('$0.00');
  });

  it('returns the fallback for null/undefined', () => {
    expect(formatCents(null)).toBe('--');
    expect(formatCents(undefined)).toBe('--');
    expect(formatCents(null, 'n/a')).toBe('n/a');
  });
});

describe('formatDelta', () => {
  it('prefixes positive amounts with +', () => {
    expect(formatDelta(1)).toBe('+1');
    expect(formatDelta(5)).toBe('+5');
  });

  it('leaves negative and zero as-is', () => {
    expect(formatDelta(-1)).toBe('-1');
    expect(formatDelta(0)).toBe('0');
  });
});

describe('entryChip', () => {
  it('labels purchase and debit by entry type', () => {
    expect(entryChip('purchase', 1).label).toBe('purchase');
    expect(entryChip('purchase', 1).classes).toContain('green');
    expect(entryChip('debit', -1).label).toBe('debit');
    expect(entryChip('debit', -1).classes).toContain('blue');
  });

  it('renders a positive adjustment as a distinct "grant" chip', () => {
    const chip = entryChip('adjustment', 1);
    expect(chip.label).toBe('grant');
    expect(chip.classes).toContain('indigo');
  });

  it('renders a negative adjustment as a distinct "clawback" chip', () => {
    const chip = entryChip('adjustment', -1);
    expect(chip.label).toBe('clawback');
    expect(chip.classes).toContain('orange');
    // grant vs clawback must not collide visually
    expect(chip.classes).not.toBe(entryChip('adjustment', 1).classes);
  });

  it('falls back to gray for unknown types', () => {
    expect(entryChip('mystery', 0).classes).toContain('gray');
  });
});

describe('stripeDashboardPaymentUrl', () => {
  it('builds a test-mode dashboard URL', () => {
    expect(stripeDashboardPaymentUrl('pi_123', 'test')).toBe(
      'https://dashboard.stripe.com/test/payments/pi_123'
    );
  });

  it('omits the test segment in live mode', () => {
    expect(stripeDashboardPaymentUrl('pi_123', 'live')).toBe(
      'https://dashboard.stripe.com/payments/pi_123'
    );
  });
});

describe('tierForUnitIndex', () => {
  const tiers: PricingTierRow[] = [
    { id: 'a', min_units: 1, max_units: 3, unit_price_cents: 1499, currency: 'usd' },
    { id: 'b', min_units: 4, max_units: 10, unit_price_cents: 1300, currency: 'usd' },
    { id: 'c', min_units: 26, max_units: null, unit_price_cents: 1100, currency: 'usd' },
  ];

  it('finds the band a unit index falls into', () => {
    expect(tierForUnitIndex(tiers, 2)?.id).toBe('a');
    expect(tierForUnitIndex(tiers, 4)?.id).toBe('b');
    expect(tierForUnitIndex(tiers, 10)?.id).toBe('b');
  });

  it('handles the open-ended top band (max_units null)', () => {
    expect(tierForUnitIndex(tiers, 100)?.id).toBe('c');
  });

  it('returns null when no band matches', () => {
    expect(tierForUnitIndex(tiers, 15)).toBeNull();
  });
});

describe('extractPaymentIntentId', () => {
  it('reads the payment_intent id from metadata', () => {
    expect(
      extractPaymentIntentId({ stripe_payment_intent_id: 'pi_abc' })
    ).toBe('pi_abc');
  });

  it('returns null when absent, empty, or non-string', () => {
    expect(extractPaymentIntentId(null)).toBeNull();
    expect(extractPaymentIntentId({})).toBeNull();
    expect(extractPaymentIntentId({ stripe_payment_intent_id: '' })).toBeNull();
    expect(extractPaymentIntentId({ stripe_payment_intent_id: 123 })).toBeNull();
  });
});

describe('ledgerView (ledger truncation / show-all)', () => {
  it('truncates to the default page size when collapsed', () => {
    const v = ledgerView(20, false);
    expect(v.visibleCount).toBe(INITIAL_LEDGER_COUNT);
    expect(v.hasMore).toBe(true);
  });

  it('reveals all rows when expanded', () => {
    const v = ledgerView(20, true);
    expect(v.visibleCount).toBe(20);
    expect(v.hasMore).toBe(true); // control still shown as "Show less"
  });

  it('shows no control and all rows when total <= page size', () => {
    const v = ledgerView(3, false);
    expect(v.visibleCount).toBe(3);
    expect(v.hasMore).toBe(false);
  });

  it('handles exactly the page size (no control)', () => {
    const v = ledgerView(INITIAL_LEDGER_COUNT, false);
    expect(v.visibleCount).toBe(INITIAL_LEDGER_COUNT);
    expect(v.hasMore).toBe(false);
  });

  it('handles an empty ledger', () => {
    const v = ledgerView(0, false);
    expect(v.visibleCount).toBe(0);
    expect(v.hasMore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getBillingData derivation — fixtures mirror the LIVE credit_ledger shape.
//
// credit_ledger_type_ck constrains entry_type to purchase|debit|adjustment.
// A support GRANT is an `adjustment` with amount > 0 (there is NO 'grant'
// entry_type). funding_source='grant' appears only on debit rows (consumption
// of a granted credit). These fixtures would have caught the original bug where
// grantsIssued counted entry_type==='grant' (always 0) and mis-counted
// grant-funded debits.
// ---------------------------------------------------------------------------

/** Row shapes as returned by each read, so we can assemble a fake client. */
interface FakeTables {
  credit_ledger: unknown[];
  transaction_unlocks: unknown[];
  credit_pricing_tiers: unknown[];
}

function makeFakeSupabase(
  tables: FakeTables,
  rpcs: { get_credit_balance?: number; get_next_unlock_quote?: unknown[] } = {},
  errors: Record<string, { message: string }> = {}
): SupabaseClient {
  const builder = (table: keyof FakeTables) => {
    const result = {
      data: errors[table] ? null : tables[table],
      error: errors[table] ?? null,
    };
    // Every chained method returns the same thenable builder.
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      order: () => chain,
      then: (resolve: (v: typeof result) => unknown) => resolve(result),
    };
    return chain;
  };

  return {
    from: (table: keyof FakeTables) => builder(table),
    rpc: (name: string) => {
      const data =
        name === 'get_credit_balance'
          ? (rpcs.get_credit_balance ?? 0)
          : (rpcs.get_next_unlock_quote ?? []);
      const result = { data: errors[name] ? null : data, error: errors[name] ?? null };
      return Promise.resolve(result);
    },
  } as unknown as SupabaseClient;
}

describe('getBillingData — grant/summary derivation', () => {
  // Realistic ledger for one user: 3 grants (adjustment +1), 1 clawback
  // (adjustment -1), 1 purchase (+1, $14.99), 2 debits funded from a grant,
  // 1 debit funded from a purchase.
  const ledgerRows = [
    { id: 'g1', entry_type: 'adjustment', amount: 1, reason: 'support grant', unit_price_cents: null, funding_source: null, metadata: {}, created_at: '2026-07-10T00:00:00Z' },
    { id: 'g2', entry_type: 'adjustment', amount: 1, reason: 'support grant', unit_price_cents: null, funding_source: null, metadata: {}, created_at: '2026-07-11T00:00:00Z' },
    { id: 'g3', entry_type: 'adjustment', amount: 1, reason: 'support grant', unit_price_cents: null, funding_source: null, metadata: {}, created_at: '2026-07-12T00:00:00Z' },
    { id: 'c1', entry_type: 'adjustment', amount: -1, reason: 'clawback', unit_price_cents: null, funding_source: null, metadata: {}, created_at: '2026-07-13T00:00:00Z' },
    { id: 'p1', entry_type: 'purchase', amount: 1, reason: null, unit_price_cents: 1499, funding_source: null, metadata: { stripe_payment_intent_id: 'pi_abc' }, created_at: '2026-07-14T00:00:00Z' },
    { id: 'd1', entry_type: 'debit', amount: -1, reason: null, unit_price_cents: null, funding_source: 'grant', metadata: {}, created_at: '2026-07-15T00:00:00Z' },
    { id: 'd2', entry_type: 'debit', amount: -1, reason: null, unit_price_cents: null, funding_source: 'grant', metadata: {}, created_at: '2026-07-16T00:00:00Z' },
    { id: 'd3', entry_type: 'debit', amount: -1, reason: null, unit_price_cents: 1499, funding_source: 'purchase', metadata: {}, created_at: '2026-07-17T00:00:00Z' },
  ];

  const unlockRows = [
    { id: 'u1', local_transaction_id: 'tx-1', funding_source: 'purchase', counts_toward_tier: true, unlocked_at: '2026-07-14T00:00:00Z', refunded_at: null },
    { id: 'u2', local_transaction_id: 'tx-2', funding_source: 'purchase', counts_toward_tier: true, unlocked_at: '2026-07-15T00:00:00Z', refunded_at: '2026-07-16T00:00:00Z' },
  ];

  it('counts grants as positive adjustments only (not grant-funded debits, not entry_type=grant)', async () => {
    const supabase = makeFakeSupabase(
      { credit_ledger: ledgerRows, transaction_unlocks: unlockRows, credit_pricing_tiers: [] },
      { get_credit_balance: 2 }
    );
    const data = await getBillingData(supabase, 'user-1');

    // 3 positive adjustments = 3 grants. The two funding_source='grant' debits
    // are consumption, NOT issuance, and must not inflate the count.
    expect(data.grantsIssued).toBe(3);
    expect(data.creditBalance).toBe(2);
    // Gross paid = the single purchase row's unit_price.
    expect(data.grossPaidCents).toBe(1499);
    // One non-refunded paid unlock; the refunded one is excluded.
    expect(data.lifetimePaidUnlocks).toBe(1);
    expect(data.hasErrors).toBe(false);
    // Purchase row gets a resolved Stripe dashboard URL server-side.
    const purchase = data.ledger.find((l) => l.id === 'p1');
    expect(purchase?.stripe_dashboard_url).toContain('dashboard.stripe.com');
    expect(purchase?.stripe_dashboard_url).toContain('pi_abc');
  });

  it('flags hasErrors + collects messages when a read fails (no silent empty)', async () => {
    const supabase = makeFakeSupabase(
      { credit_ledger: [], transaction_unlocks: [], credit_pricing_tiers: [] },
      {},
      { credit_ledger: { message: 'connection reset' } }
    );
    const data = await getBillingData(supabase, 'user-1');
    expect(data.hasErrors).toBe(true);
    expect(data.errorMessages.some((m) => m.includes('connection reset'))).toBe(true);
  });
});

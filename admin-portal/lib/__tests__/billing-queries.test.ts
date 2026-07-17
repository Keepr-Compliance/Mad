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
  entryTypeChipClasses,
  stripeDashboardPaymentUrl,
  tierForUnitIndex,
  extractPaymentIntentId,
  type PricingTierRow,
} from '../billing-queries';

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

describe('entryTypeChipClasses', () => {
  it('maps known entry types to distinct colors', () => {
    expect(entryTypeChipClasses('purchase')).toContain('green');
    expect(entryTypeChipClasses('grant')).toContain('indigo');
    expect(entryTypeChipClasses('debit')).toContain('blue');
    expect(entryTypeChipClasses('adjustment')).toContain('yellow');
  });

  it('falls back to gray for unknown types', () => {
    expect(entryTypeChipClasses('mystery')).toContain('gray');
  });
});

describe('stripeDashboardPaymentUrl', () => {
  it('builds a test-mode dashboard URL by default', () => {
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

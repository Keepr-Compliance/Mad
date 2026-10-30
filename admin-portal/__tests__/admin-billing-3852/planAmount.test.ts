/**
 * BACKLOG-3852 C5: the price line on the user's Plan card, swept over every deal/Stripe state.
 * Fixtures are the admin_get_org_billing captures in ../onboarding-4007/fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { ACTIVE, ACTIVE_DEAL, WAITING } from '../onboarding-4007/fixtures';
import { planAmountLine } from '@/lib/billing/planAmount';
import type { OrgBilling, OrgDeal } from '@/lib/billing/dealRules';

const stripe = (status: string, over: Partial<NonNullable<OrgBilling['stripe']>> = {}) => ({ ...ACTIVE.stripe!, status, ...over });
const withDeal = (status: OrgDeal['status'], over: Partial<OrgBilling> = {}): OrgBilling => ({
  ...ACTIVE, deal: { ...ACTIVE_DEAL, status }, ...over,
});

describe('planAmountLine', () => {
  const PRICE = '$24.99 per seat / month';
  it('active: price and next invoice date', () => {
    expect(planAmountLine(ACTIVE)).toBe(`${PRICE} · next invoice Nov 19, 2026`);
  });
  it('trialing: price and the billing start day', () => {
    const b = withDeal('active', { stripe: stripe('trialing'), deal: { ...ACTIVE_DEAL, billing_starts_on: '2026-11-25' } });
    expect(planAmountLine(b)).toBe(`${PRICE} · billing starts Nov 25, 2026`);
  });
  it('auto-renew off (canceling): price and the end date', () => {
    expect(planAmountLine(withDeal('canceling'))).toBe(`${PRICE} · ends Nov 19, 2026`);
  });
  it('suspended: price only', () => {
    expect(planAmountLine(withDeal('suspended'))).toBe(PRICE);
  });
  it('active with no period end yet: price only', () => {
    expect(planAmountLine({ ...ACTIVE, stripe: null })).toBe(PRICE);
  });
  it.each([
    ['draft deal', WAITING],
    ['canceled deal', withDeal('canceled')],
    ['no deal', { ...ACTIVE, deal: null, state: null } as OrgBilling],
    ['no price line', { ...ACTIVE, seat_line: null } as OrgBilling],
    ['Billing card hidden (billing off, not a test org)', { ...ACTIVE, billing_live: false, is_test: false } as OrgBilling],
    ['read failed (null)', null],
  ])('%s: no line', (_name, b) => {
    expect(planAmountLine(b as OrgBilling | null)).toBeNull();
  });
});

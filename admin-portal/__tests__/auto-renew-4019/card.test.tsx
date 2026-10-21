/**
 * BACKLOG-4019 C-UI1: the staff Billing card's auto-renew readout and buttons.
 * CANCELING is admin_get_org_billing captured on keepr-test 2026-10-21 for "Test Brokerage Alpha"
 * right after set_org_auto_renew(off) in a rolled-back transaction: deal.status 'canceling',
 * version 3, status_before_suspension null, state 'canceling', the Stripe mirror unchanged
 * (current_period_end 2026-11-19T21:29:07+00:00) — the ACTIVE fixture with those fields.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ACTIVE, ACTIVE_DEAL, WAITING } from '../onboarding-4007/fixtures';
import type { OrgBilling } from '@/lib/billing/dealRules';
import { autoRenewAction, autoRenewField, autoRenewState, dealBadge } from '@/lib/billing/dealRules';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ getAuthenticatedUser: async () => ({ user: null, supabase: null }) }));

const CANCELING: OrgBilling = {
  ...ACTIVE,
  state: 'canceling',
  deal: { ...ACTIVE_DEAL, status: 'canceling', version: 3, status_before_suspension: null },
};
const SUSPENDED_CANCELING: OrgBilling = {
  ...CANCELING,
  state: 'suspended',
  deal: { ...CANCELING.deal!, status: 'suspended', status_before_suspension: 'canceling', suspended_reason: 'other', suspended_at: '2026-10-21T00:00:00+00:00' },
};
const CANCELED: OrgBilling = {
  ...ACTIVE,
  state: 'canceled',
  deal: { ...ACTIVE_DEAL, status: 'canceled', version: 4, status_before_suspension: null },
  stripe: { ...ACTIVE.stripe!, status: 'canceled', cancel_at_period_end: true },
};

async function card(billing: OrgBilling) {
  const { BrokerageBillingCard } = await import('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard');
  return renderToStaticMarkup(<BrokerageBillingCard organizationId="o1" organizationName="Org" planName="Team" billing={billing} />);
}

describe('auto-renew on the Billing card (BACKLOG-4019)', () => {
  it('active: Auto-renew "On" and "Turn off auto-renew"', async () => {
    const html = await card(ACTIVE);
    expect(html).toContain('Auto-renew');
    expect(html).toContain('>On<');
    expect(html).toContain('Turn off auto-renew');
    expect(html).not.toContain('Turn auto-renew back on');
  });
  it('canceling: badge "Ends Nov 19, 2026", field "Off · ends Nov 19, 2026", "Turn auto-renew back on"', async () => {
    const html = await card(CANCELING);
    expect(html).toContain('Ends Nov 19, 2026');
    expect(html).toContain('Off · ends Nov 19, 2026');
    expect(html).toContain('Turn auto-renew back on');
    expect(html).not.toContain('Turn off auto-renew');
    expect(html).not.toContain('Cancel pending');
  });
  it('suspended while canceling: the field still reads Off, the turn-on button stays', async () => {
    const html = await card(SUSPENDED_CANCELING);
    expect(html).toContain('Off · ends Nov 19, 2026');
    expect(html).toContain('Turn auto-renew back on');
  });
  it('canceled: "Ended", no auto-renew button', async () => {
    const html = await card(CANCELED);
    expect(html).toContain('Ended Nov 19, 2026');
    expect(html).not.toContain('Turn off auto-renew');
    expect(html).not.toContain('Turn auto-renew back on');
  });
  it('no billing.manage (Support, Executive): readout only, no buttons', async () => {
    const html = await card({ ...CANCELING, can_manage: false });
    expect(html).toContain('Off · ends Nov 19, 2026');
    expect(html).not.toContain('Turn auto-renew back on');
  });
  it('waiting for setup: no auto-renew field or button', async () => {
    const html = await card(WAITING);
    expect(html).not.toContain('Auto-renew');
  });
});

describe('dealRules auto-renew helpers', () => {
  it('state, field, action, badge', () => {
    expect(autoRenewState(ACTIVE)).toBe('renewing');
    expect(autoRenewState(SUSPENDED_CANCELING)).toBe('ending');
    expect(autoRenewState(CANCELED)).toBe('ended');
    expect(autoRenewState(WAITING)).toBeNull();
    expect(autoRenewAction({ ...ACTIVE, stripe: null })).toBeNull();
    expect(autoRenewAction(CANCELING)).toBe('on');
    expect(autoRenewAction({ ...CANCELING, stripe: { ...CANCELING.stripe!, status: 'canceled' } })).toBeNull();
    expect(autoRenewField(CANCELING)).toBe('Off · ends Nov 19, 2026');
    expect(dealBadge(CANCELING)).toEqual({ label: 'Ends Nov 19, 2026', hue: 'amber' });
    expect(dealBadge(ACTIVE)).toEqual({ label: 'Active', hue: 'green' });
  });
});

/**
 * BACKLOG-3852 (b) / C6: the confirm text for turning auto-renew off.
 * During the free period (Stripe status trialing) it must say it ends before the first invoice.
 */
import { describe, expect, it, vi } from 'vitest';
import { ACTIVE } from '../onboarding-4007/fixtures';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ getAuthenticatedUser: async () => ({ user: null, supabase: null }) }));

const TRIALING = { ...ACTIVE, stripe: { ...ACTIVE.stripe!, status: 'trialing' } };

describe('autoRenewOffBody', () => {
  it('trialing: ends before the first invoice, with the date', async () => {
    const { autoRenewOffBody } = await import('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard');
    expect(autoRenewOffBody(TRIALING)).toBe('It ends on Nov 19, 2026, before the first invoice.');
  });
  it('active: billing stops, members keep access', async () => {
    const { autoRenewOffBody } = await import('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard');
    const text = autoRenewOffBody(ACTIVE);
    expect(text).toBe('Billing stops on Nov 19, 2026. Members keep access until then.');
    expect(text).not.toContain('before the first invoice');
  });
  it('trialing with no period end: names the end of the billing period', async () => {
    const { autoRenewOffBody } = await import('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard');
    expect(autoRenewOffBody({ ...TRIALING, stripe: { ...TRIALING.stripe, current_period_end: null } })).toBe(
      'It ends on the end of the billing period, before the first invoice.'
    );
  });
});

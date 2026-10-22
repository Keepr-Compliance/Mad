/**
 * BACKLOG-4007 PR-2: the Billing card shows the deal state, the start date, the Stripe
 * subscription line and the billing contact with phone.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ACTIVE, ACTIVE_DEAL, WAITING } from './fixtures';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ getAuthenticatedUser: async () => ({ user: null, supabase: null }) }));

async function card(billing: typeof WAITING) {
  const { BrokerageBillingCard } = await import('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard');
  return renderToStaticMarkup(<BrokerageBillingCard organizationId="o1" organizationName="Org" planName="Team" billing={billing} />);
}

describe('Billing card (BACKLOG-4007)', () => {
  it('waiting deal: state badge, not started, contact not set yet', async () => {
    const html = await card(WAITING);
    expect(html).toContain('Waiting for customer setup');
    expect(html).toContain('Not started');
    expect(html).toContain('Not set yet. The broker sets it in setup.');
    expect(html).toContain('Oct 24, 2026');
    expect(html).not.toContain('>Draft<');
  });
  it('active deal: "Active", contact with "Phone not set"', async () => {
    const html = await card(ACTIVE);
    expect(html).toContain('>Active<');
    expect(html).not.toContain('Billing active');
    expect(html).not.toContain('Waiting for customer setup');
    expect(html).toContain('billing@example.test · Phone not set');
  });
  it('contact with phone and billing-only login', async () => {
    const html = await card({ ...ACTIVE, contact: { ...ACTIVE.contact!, phone: '+15550100', has_login: true } });
    expect(html).toContain('billing@example.test · +15550100 · billing-only login');
  });
  it('trialing subscription reads "Billing starts <date>", never the raw status', async () => {
    const html = await card({
      ...ACTIVE,
      deal: { ...ACTIVE_DEAL, billing_starts_on: '2026-11-01' },
      stripe: { ...ACTIVE.stripe!, status: 'trialing' },
    });
    expect(html).toContain('Billing starts Nov 1, 2026');
    expect(html.toLowerCase()).not.toContain('trialing');
  });
});

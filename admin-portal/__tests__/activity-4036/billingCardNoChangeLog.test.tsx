/**
 * BACKLOG-4036 (founder decision, pm_comments on 4036): Activity is the only list on the
 * organization page. The Billing card no longer renders its "Change log", even when
 * admin_get_org_billing still returns log rows.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/actions/brokerageBilling', () => ({
  reinstateOrgAction: vi.fn(), saveDealAction: vi.fn(), setAutoRenewAction: vi.fn(), suspendOrgAction: vi.fn(),
}));

import { BrokerageBillingCard } from '@/app/dashboard/organizations/[id]/components/BrokerageBillingCard';
import type { OrgBilling } from '@/lib/billing/dealRules';

// admin_get_org_billing shape for an org with no deal, plus log rows as the function returns them.
const BILLING = {
  billing_live: true, is_test: true, list_price_cents: 2499, cap_pct: 20,
  can_manage: true, can_approve: false, can_suspend: true, assigned_seats: 0,
  deal: null, seat_line: null, stripe: null, account_managers: [], contact: null, company: null, terms_accepted: null,
  business_date: '2026-10-21', state: null,
  log: [
    {
      created_at: '2026-10-21T16:32:49+00:00',
      action: 'auto_renew_off',
      detail: { note: 'Asked by broker' },
      actor: 'Pat Doe',
    },
    {
      created_at: '2026-10-21T16:30:00+00:00',
      action: 'member_role_changed',
      detail: { from: 'agent', to: 'admin' },
      actor: 'Pat Doe',
    },
  ],
} as unknown as OrgBilling;

describe('Billing card without the Change log (BACKLOG-4036)', () => {
  it('renders no Change log and none of the log rows', () => {
    const html = renderToStaticMarkup(<BrokerageBillingCard organizationId="o1" organizationName="Org" planName="Team" billing={BILLING} />);
    expect(html).toContain('Billing');
    expect(html).not.toContain('Change log');
    expect(html).not.toContain('Asked by broker');
    expect(html).not.toContain('member_role_changed');
  });
});

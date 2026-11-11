// @vitest-environment jsdom
/**
 * BACKLOG-4209: the staff reason dialog's note field says it is internal. True for all three
 * dialogs (suspend, auto-renew on/off, reinstate): the note goes to billing_change_log and
 * org_deals.suspended_note, which no customer email template or broker-portal page reads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ACTIVE, ACTIVE_DEAL } from '../onboarding-4007/fixtures';
import type { OrgBilling } from '@/lib/billing/dealRules';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/actions/brokerageBilling', () => ({
  reinstateOrgAction: vi.fn(), saveDealAction: vi.fn(), suspendOrgAction: vi.fn(), setAutoRenewAction: vi.fn(),
}));

const LABEL = /^Internal note \(won't be sent to the customer\)/;
const SUSPENDED: OrgBilling = {
  ...ACTIVE, state: 'suspended',
  deal: { ...ACTIVE_DEAL, status: 'suspended', status_before_suspension: 'active', suspended_at: '2026-11-01T17:00:00+00:00', suspended_reason: 'other', suspended_note: 'x' },
};
const CANCELING: OrgBilling = { ...ACTIVE, state: 'canceling', deal: { ...ACTIVE_DEAL, status: 'canceling', version: 3, status_before_suspension: null } };

afterEach(cleanup);

async function open(billing: OrgBilling, button: string) {
  const { BrokerageBillingCard } = await import('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard');
  render(<BrokerageBillingCard organizationId="org-active" organizationName="Org" planName="Team" billing={billing} />);
  fireEvent.click(screen.getByRole('button', { name: button }));
}

describe('staff reason dialog note label', () => {
  it.each([
    ['suspend', ACTIVE, 'Suspend organization'],
    ['auto-renew off', ACTIVE, 'Turn off auto-renew'],
    ['auto-renew on', CANCELING, 'Turn auto-renew back on'],
    ['reinstate', SUSPENDED, 'Reinstate organization'],
  ] as const)('%s dialog labels the note as internal', async (_n, billing, button) => {
    await open(billing, button);
    expect(screen.getByLabelText(LABEL)).toBeTruthy();
  });
});

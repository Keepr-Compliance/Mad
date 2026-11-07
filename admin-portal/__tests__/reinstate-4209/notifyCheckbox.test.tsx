// @vitest-environment jsdom
/**
 * BACKLOG-4209: "Email the billing contact" on the staff "Reinstate organization" dialog.
 * The whole BrokerageBillingCard is rendered with the actions module mocked, so the assertion is on
 * the exact call the card makes (organizationId, note, notify).
 * SUSPENDED is the onboarding-4007 ACTIVE fixture (captured from keepr-test) with the deal suspended;
 * its billing_contact_email is 'billing@example.test'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ACTIVE, ACTIVE_DEAL } from '../onboarding-4007/fixtures';
import type { OrgBilling } from '@/lib/billing/dealRules';

const reinstateOrgAction = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/actions/brokerageBilling', () => ({
  reinstateOrgAction: (...a: unknown[]) => reinstateOrgAction(...a),
  saveDealAction: vi.fn(),
  suspendOrgAction: vi.fn(),
  setAutoRenewAction: vi.fn(),
}));

const SUSPENDED: OrgBilling = {
  ...ACTIVE,
  state: 'suspended',
  deal: { ...ACTIVE_DEAL, status: 'suspended', status_before_suspension: 'active', suspended_at: '2026-11-01T17:00:00+00:00', suspended_reason: 'other', suspended_note: 'p4209' },
};
const SUSPENDED_NO_CONTACT: OrgBilling = { ...SUSPENDED, deal: { ...SUSPENDED.deal!, billing_contact_email: null } };

beforeEach(() => {
  reinstateOrgAction.mockReset();
  reinstateOrgAction.mockResolvedValue({ ok: true, error: null });
});
afterEach(cleanup);

async function openReinstateDialog(billing: OrgBilling) {
  const { BrokerageBillingCard } = await import('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard');
  render(<BrokerageBillingCard organizationId="org-active" organizationName="Org" planName="Team" billing={billing} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reinstate organization' }));
  fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'paid by transfer' } });
}
const submit = () => {
  const buttons = screen.getAllByRole('button', { name: 'Reinstate organization' });
  fireEvent.click(buttons[buttons.length - 1]);
};

describe('Reinstate organization: Email the billing contact', () => {
  it('A-re1: checked by default with the contact email; submit sends notify true', async () => {
    await openReinstateDialog(SUSPENDED);
    const box = screen.getByRole('checkbox', { name: 'Email the billing contact' });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('billing@example.test')).toBeTruthy();
    submit();
    await waitFor(() => expect(reinstateOrgAction).toHaveBeenCalledTimes(1));
    expect(reinstateOrgAction).toHaveBeenCalledWith('org-active', 'paid by transfer', true);
  });

  it('A-re2: unticked -> submit sends notify false', async () => {
    await openReinstateDialog(SUSPENDED);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Email the billing contact' }));
    submit();
    await waitFor(() => expect(reinstateOrgAction).toHaveBeenCalledTimes(1));
    expect(reinstateOrgAction).toHaveBeenCalledWith('org-active', 'paid by transfer', false);
  });

  it('A-re3: no billing contact email -> no checkbox, one line, notify false', async () => {
    await openReinstateDialog(SUSPENDED_NO_CONTACT);
    expect(screen.queryByRole('checkbox', { name: 'Email the billing contact' })).toBeNull();
    expect(screen.getByText('No billing contact email on file, so no email is sent.')).toBeTruthy();
    submit();
    await waitFor(() => expect(reinstateOrgAction).toHaveBeenCalledTimes(1));
    expect(reinstateOrgAction).toHaveBeenCalledWith('org-active', 'paid by transfer', false);
  });
});

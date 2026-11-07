// @vitest-environment jsdom
/**
 * BACKLOG-4045 follow-up: "Email the billing contact" on the staff "Turn auto-renew back on" dialog.
 * The whole BrokerageBillingCard is rendered with the actions module mocked, so the assertion is on
 * the exact call the card makes (organizationId, on, note, version, notify).
 * CANCELING is the 4019 card fixture (ACTIVE from onboarding-4007, captured from keepr-test, with the
 * deal set to canceling, version 3); its billing_contact_email is 'billing@example.test'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ACTIVE, ACTIVE_DEAL } from '../onboarding-4007/fixtures';
import type { OrgBilling } from '@/lib/billing/dealRules';

const setAutoRenewAction = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/actions/brokerageBilling', () => ({
  reinstateOrgAction: vi.fn(),
  saveDealAction: vi.fn(),
  suspendOrgAction: vi.fn(),
  setAutoRenewAction: (...a: unknown[]) => setAutoRenewAction(...a),
}));

const CANCELING: OrgBilling = {
  ...ACTIVE,
  state: 'canceling',
  deal: { ...ACTIVE_DEAL, status: 'canceling', version: 3, status_before_suspension: null },
};
const NO_CONTACT: OrgBilling = { ...CANCELING, deal: { ...CANCELING.deal!, billing_contact_email: null } };

beforeEach(() => {
  setAutoRenewAction.mockReset();
  setAutoRenewAction.mockResolvedValue({ ok: true, error: null });
});
afterEach(cleanup);

async function openOnDialog(billing: OrgBilling) {
  const { BrokerageBillingCard } = await import('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard');
  render(<BrokerageBillingCard organizationId="org-active" organizationName="Org" planName="Team" billing={billing} />);
  fireEvent.click(screen.getByRole('button', { name: 'Turn auto-renew back on' }));
  fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'asked by phone' } });
}
const submit = () => {
  const buttons = screen.getAllByRole('button', { name: 'Turn auto-renew back on' });
  fireEvent.click(buttons[buttons.length - 1]);
};

describe('Turn auto-renew back on: Email the billing contact', () => {
  it('A1: checked by default; submit sends notify true', async () => {
    await openOnDialog(CANCELING);
    const box = screen.getByRole('checkbox', { name: 'Email the billing contact' });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('billing@example.test')).toBeTruthy();
    submit();
    await waitFor(() => expect(setAutoRenewAction).toHaveBeenCalledTimes(1));
    expect(setAutoRenewAction).toHaveBeenCalledWith('org-active', true, 'asked by phone', 3, true);
  });

  it('A2: unticked -> submit sends notify false', async () => {
    await openOnDialog(CANCELING);
    const box = screen.getByRole('checkbox', { name: 'Email the billing contact' });
    fireEvent.click(box);
    expect((box as HTMLInputElement).checked).toBe(false);
    submit();
    await waitFor(() => expect(setAutoRenewAction).toHaveBeenCalledTimes(1));
    expect(setAutoRenewAction).toHaveBeenCalledWith('org-active', true, 'asked by phone', 3, false);
  });

  it('A4: no billing contact email -> no checkbox, one line, notify false', async () => {
    await openOnDialog(NO_CONTACT);
    expect(screen.queryByRole('checkbox', { name: 'Email the billing contact' })).toBeNull();
    expect(screen.getByText('No billing contact email on file, so no email is sent.')).toBeTruthy();
    submit();
    await waitFor(() => expect(setAutoRenewAction).toHaveBeenCalledTimes(1));
    expect(setAutoRenewAction).toHaveBeenCalledWith('org-active', true, 'asked by phone', 3, false);
  });

  it('A1b: the off dialog offers no checkbox', async () => {
    const { BrokerageBillingCard } = await import('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard');
    render(<BrokerageBillingCard organizationId="org-active" organizationName="Org" planName="Team" billing={ACTIVE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off auto-renew' }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/billing contact email/)).toBeNull();
  });
});

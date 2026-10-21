// @vitest-environment jsdom
/**
 * BACKLOG-4007 People v2 (founder 723b63de): People's "Invite new person" reuses the Users
 * page's InviteUserDialog. With `people` set: organization locked, role preset and read-only,
 * phone field (staff with billing.manage), submit to the People action (never inviteUser).
 * Without `people` the dialog is unchanged (role select).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const mockInviteUser = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/actions/inviteUser', () => ({ inviteUser: (...a: unknown[]) => mockInviteUser(...a) }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
    return { from: () => chain };
  },
}));

import { InviteUserDialog, type PeopleInviteMode } from '@/app/dashboard/users/components/InviteUserDialog';
import { PHONE_ERROR, formatBillingPhoneInput, isValidBillingPhone } from '@keepr/shared';

const ORG = { id: 'o1', name: 'Fixture Realty' };
const PHONE_RULE = { isValid: isValidBillingPhone, format: formatBillingPhoneInput, error: PHONE_ERROR };

function people(over: Partial<PeopleInviteMode> = {}): PeopleInviteMode {
  return {
    slot: 'billing',
    phoneAllowed: true,
    phoneRule: PHONE_RULE,
    submit: vi.fn(async () => ({ ok: true as const, emailSent: true, inviteLink: 'https://portal.example.test/invite/tok' })),
    ...over,
  };
}

function fillNames() {
  fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: 'pay@example.test' } });
  fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Pat' } });
  fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Payer' } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InviteUserDialog in People mode', () => {
  it('billing: organization locked, role "Billing only (no seat)", phone required, People submit', async () => {
    const p = people();
    render(<InviteUserDialog lockedOrganization={ORG} onClose={vi.fn()} onInvited={vi.fn()} people={p} />);
    expect((screen.getByLabelText('Organization') as HTMLInputElement).value).toBe('Fixture Realty');
    expect((screen.getByLabelText('Role') as HTMLInputElement).value).toBe('Billing only (no seat)');
    expect(screen.queryByRole('combobox')).toBeNull();
    fillNames();
    expect((screen.getByText('Send Invitation') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '2025550161' } });
    expect((screen.getByText('Send Invitation') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => fireEvent.click(screen.getByText('Send Invitation')));
    expect(p.submit).toHaveBeenCalledWith({ email: 'pay@example.test', firstName: 'Pat', lastName: 'Payer', phone: '(202) 555-0161' });
    expect(mockInviteUser).not.toHaveBeenCalled();
    expect(screen.getByText('Invitation Sent')).toBeTruthy();
  });

  it('MSP: role "IT admin", the company is asked for; a refusal is worded', async () => {
    const p = people({ slot: 'msp', companyName: 'Fixture IT Co', submit: vi.fn(async () => ({ ok: false as const, error: 'seat_limit_reached' })) });
    render(<InviteUserDialog lockedOrganization={ORG} onClose={vi.fn()} onInvited={vi.fn()} people={p} />);
    expect((screen.getByLabelText('Role') as HTMLInputElement).value).toBe('IT admin');
    expect((screen.getByLabelText('IT provider company') as HTMLInputElement).value).toBe('Fixture IT Co');
    fillNames();
    await act(async () => fireEvent.click(screen.getByText('Send Invitation')));
    expect(p.submit).toHaveBeenCalledWith({ email: 'pay@example.test', firstName: 'Pat', lastName: 'Payer', phone: '', companyName: 'Fixture IT Co' });
    expect(screen.getByText('No license is free. The IT contact uses a seat.')).toBeTruthy();
  });

  it('no phone field when the caller may not write phones', () => {
    render(<InviteUserDialog lockedOrganization={ORG} onClose={vi.fn()} onInvited={vi.fn()} people={people({ slot: 'it', phoneAllowed: false })} />);
    expect(screen.queryByLabelText(/Phone/)).toBeNull();
  });

  it('without people: the role select and inviteUser, as before', async () => {
    mockInviteUser.mockResolvedValue({ success: true, inviteLink: 'https://portal.example.test/invite/x', emailSent: true, flow: 'org' });
    render(<InviteUserDialog lockedOrganization={ORG} onClose={vi.fn()} onInvited={vi.fn()} />);
    expect(screen.getByRole('combobox')).toBeTruthy();
    expect(screen.queryByLabelText(/Phone/)).toBeNull();
    fillNames();
    await act(async () => fireEvent.click(screen.getByText('Send Invitation')));
    expect(mockInviteUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'pay@example.test', role: 'agent', organizationId: 'o1' }));
  });
});

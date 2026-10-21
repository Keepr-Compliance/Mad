/**
 * BACKLOG-4007 People v2 (broker portal):
 *  - J1 InviteUserModal in People mode (founder 723b63de): role preset and read-only, phone field,
 *    submit goes to the People action, never inviteUser, no "Invite without a license". Without
 *    `people` the modal is unchanged (role select, inviteUser).
 *  - J2 My Account phone: saved through my_phone_set (the person's own row).
 *  - J3 Users-page removal of the live billing contact: the database refusal is worded with the
 *    founder sentence (R9). Error text transcribed from keepr-test control
 *    R9_users_page_removal_refused: "billing_contact_member".
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

const mockInviteUser = jest.fn();
const mockRpc = jest.fn();
const mockFrom = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }) }));
jest.mock('@/lib/actions/inviteUser', () => ({ inviteUser: (...a: unknown[]) => mockInviteUser(...a) }));
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: async () => null }));
jest.mock('@/lib/auth/memberAccess', () => ({
  requireActiveOrgRole: async () => ({ ok: true, role: 'admin' }),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: mockRpc,
    from: mockFrom,
    auth: { getUser: async () => ({ data: { user: { id: 'u-admin' } } }) },
  }),
}));

import InviteUserModal, { type PeopleInviteMode } from '@/components/users/InviteUserModal';
import { MyPhoneCard } from '@/components/account/MyPhoneCard';
import { removeUser } from '@/lib/actions/removeUser';
import { PHONE_ERROR, formatBillingPhoneInput, isValidBillingPhone } from '@/lib/billing/phone';

const PHONE_RULE = { isValid: isValidBillingPhone, format: formatBillingPhoneInput, error: PHONE_ERROR };

function people(over: Partial<PeopleInviteMode> = {}): PeopleInviteMode {
  return {
    slot: 'billing',
    phoneAllowed: true,
    phoneRule: PHONE_RULE,
    submit: jest.fn(async () => ({ ok: true as const, emailSent: true, inviteLink: 'https://portal.example.test/invite/tok' })),
    ...over,
  };
}

const EMAIL_LABEL = 'Email Address';
function typeEmail(value: string) {
  fireEvent.change(screen.getByLabelText(EMAIL_LABEL), { target: { value } });
}

beforeEach(() => jest.clearAllMocks());

describe('J1 InviteUserModal in People mode', () => {
  it('billing: role preset "Billing only (no seat)", phone required, submit to the People action', async () => {
    const p = people();
    render(<InviteUserModal isOpen onClose={jest.fn()} organizationId="org-1" people={p} />);
    expect(screen.getByLabelText('Role')).toHaveValue('Billing only (no seat)');
    expect(screen.getByLabelText('Role')).toBeDisabled();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    typeEmail('pay@example.test');
    expect(screen.getByText('Send Invite')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '2025550141' } });
    expect(screen.getByText('Send Invite')).not.toBeDisabled();
    await act(async () => fireEvent.click(screen.getByText('Send Invite')));
    expect(p.submit).toHaveBeenCalledWith({ email: 'pay@example.test', firstName: '', lastName: '', phone: '(202) 555-0141' });
    expect(mockInviteUser).not.toHaveBeenCalled();
    expect(screen.getByText('Invitation Email Sent')).toBeInTheDocument();
  });

  it('MSP for an IT admin caller: role "IT admin", company required, no phone field', async () => {
    const p = people({ slot: 'msp', phoneAllowed: false, companyName: 'Fixture IT Co' });
    render(<InviteUserModal isOpen onClose={jest.fn()} organizationId="org-1" people={p} />);
    expect(screen.getByLabelText('Role')).toHaveValue('IT admin');
    expect(screen.queryByLabelText(/Phone/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('IT provider company')).toHaveValue('Fixture IT Co');
    typeEmail('it@example.test');
    await act(async () => fireEvent.click(screen.getByText('Send Invite')));
    expect(p.submit).toHaveBeenCalledWith({ email: 'it@example.test', firstName: '', lastName: '', phone: '', companyName: 'Fixture IT Co' });
  });

  it('a refusal is worded (seat_limit_reached) and the out-of-licenses "Invite without a license" is not offered', async () => {
    const p = people({ slot: 'it', submit: jest.fn(async () => ({ ok: false as const, error: 'seat_limit_reached' })) });
    render(<InviteUserModal isOpen onClose={jest.fn()} organizationId="org-1" people={p} allowInviteWithoutLicense />);
    typeEmail('it@example.test');
    await act(async () => fireEvent.click(screen.getByText('Send Invite')));
    expect(screen.getByText('No license is free. The IT contact uses a seat.')).toBeInTheDocument();
    expect(screen.queryByText(/Invite without a license/)).not.toBeInTheDocument();
  });

  it('without people: the role select and inviteUser, as before', async () => {
    mockInviteUser.mockResolvedValue({ inviteLink: 'https://portal.example.test/invite/x', emailSent: true });
    render(<InviteUserModal isOpen onClose={jest.fn()} organizationId="org-1" />);
    expect(screen.getByRole('combobox', { name: 'Role' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Phone/)).not.toBeInTheDocument();
    typeEmail('a@example.test');
    await act(async () => fireEvent.click(screen.getByText('Send Invite')));
    expect(mockInviteUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@example.test', role: 'agent', organizationId: 'org-1' }));
  });
});

describe('J2 My Account phone', () => {
  it('loads with my_phone_get and saves with my_phone_set', async () => {
    mockRpc.mockImplementation(async (fn: string) =>
      fn === 'my_phone_get'
        ? { data: { phone: '+12025550142' }, error: null }
        : { data: { success: true, phone: '+12025550143' }, error: null }
    );
    await act(async () => {
      render(<MyPhoneCard />);
    });
    expect(screen.getByLabelText('Phone number')).toHaveValue('(202) 555-0142');
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '2025550143' } });
    await act(async () => fireEvent.click(screen.getByText('Save phone')));
    expect(mockRpc).toHaveBeenCalledWith('my_phone_set', { p_phone: '(202) 555-0143' });
    expect(screen.getByText('Phone saved.')).toBeInTheDocument();
  });

  it('a billing contact cannot clear their phone: the refusal is worded', async () => {
    mockRpc.mockImplementation(async (fn: string) =>
      fn === 'my_phone_get'
        ? { data: { phone: '+12025550144' }, error: null }
        : { data: { success: false, error: 'billing_contact_phone_required' }, error: null }
    );
    await act(async () => {
      render(<MyPhoneCard />);
    });
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '' } });
    await act(async () => fireEvent.click(screen.getByText('Save phone')));
    expect(screen.getByText('You are a billing contact, so a phone is required.')).toBeInTheDocument();
  });

  it('read-only (support session): no Save', async () => {
    mockRpc.mockResolvedValue({ data: { phone: null }, error: null });
    await act(async () => {
      render(<MyPhoneCard readOnly />);
    });
    expect(screen.queryByText('Save phone')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Phone number')).toBeDisabled();
  });
});

describe('J3 Users-page removal of the live billing contact', () => {
  function members(deleteError: { message: string } | null) {
    mockFrom.mockImplementation(() => {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, {
        select: chain,
        eq: chain,
        in: chain,
        not: chain,
        neq: chain,
        single: async () => ({ data: { id: 'm-pay', user_id: 'u-pay', role: 'agent', organization_id: 'org-1' }, error: null }),
        delete: () => ({ eq: async () => ({ error: deleteError }) }),
      });
      return q;
    });
  }

  it('refused with "Pick another billing contact first."', async () => {
    members({ message: 'billing_contact_member' });
    expect(await removeUser({ memberId: 'm-pay' })).toEqual({ success: false, error: 'Pick another billing contact first.' });
  });

  it('any other delete error keeps the old wording', async () => {
    members({ message: 'something else' });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await removeUser({ memberId: 'm-pay' })).toEqual({ success: false, error: 'Failed to remove user' });
  });
});

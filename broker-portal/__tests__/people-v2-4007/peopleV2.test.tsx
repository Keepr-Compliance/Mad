/**
 * BACKLOG-4007 People v2 (broker portal):
 *  - J1 InviteUserModal: the Users page invite (role select, inviteUser). People's "Invite new
 *    person" moved into the People popup (@keepr/ui OrgPeoplePanel), so the modal has no People
 *    mode any more.
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

import InviteUserModal from '@/components/users/InviteUserModal';
import { MyPhoneCard } from '@/components/account/MyPhoneCard';
import { removeUser } from '@/lib/actions/removeUser';


const EMAIL_LABEL = 'Email Address';
function typeEmail(value: string) {
  fireEvent.change(screen.getByLabelText(EMAIL_LABEL), { target: { value } });
}

beforeEach(() => jest.clearAllMocks());

describe('J1 InviteUserModal (People invites now live in the People popup)', () => {
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

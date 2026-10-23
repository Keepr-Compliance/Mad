/**
 * BACKLOG-3991 C18 / U1-U10: "Edit name" on the user details card, and the modal.
 *
 * The button shows only when the page's database answer says the brokerage manages
 * names by hand (namesEditable) AND the caller may edit this target (admin /
 * it_admin, not their own row, an admin never an it_admin, never a deactivated
 * member). The database stays the authority; these pin what the card shows.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockRefresh = jest.fn();
const mockSetMemberName = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh, push: jest.fn() }) }));
jest.mock('@/lib/actions/memberName', () => ({ setMemberName: (...a: unknown[]) => mockSetMemberName(...a) }));
jest.mock('@/lib/actions/memberLicense', () => ({ setMemberLicense: jest.fn() }));
jest.mock('@/lib/actions/updateUserRole', () => ({ updateUserRole: jest.fn() }));
jest.mock('@/lib/actions/deactivateUser', () => ({ deactivateUser: jest.fn() }));
jest.mock('@/lib/actions/removeUser', () => ({ removeUser: jest.fn() }));

import UserDetailsCard, { type MemberDetailsData } from '@/components/users/UserDetailsCard';
import EditNameModal from '@/components/users/EditNameModal';
import { MEMBER_NAME_ERRORS, MEMBER_NAME_NOTE } from '@/lib/users/memberName';
import type { MemberLicenseStatus, Role } from '@/lib/types/users';

beforeEach(() => {
  mockRefresh.mockReset();
  mockSetMemberName.mockReset();
});
afterEach(cleanup);

function member(over: Partial<MemberDetailsData> = {}): MemberDetailsData {
  return {
    id: 'member-1',
    user_id: 'user-1',
    role: 'agent',
    license_status: 'active',
    invited_email: null,
    invited_at: null,
    joined_at: '2024-01-15T10:00:00Z',
    provisioned_by: 'invite',
    provisioned_at: null,
    scim_synced_at: null,
    provisioning_metadata: null,
    idp_groups: null,
    invited_by: null,
    last_invited_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-15T00:00:00Z',
    user: {
      id: 'user-1',
      email: 'ann@fixture.example.test',
      first_name: 'Ann',
      last_name: 'Lee',
      display_name: 'Ann Lee',
      avatar_url: null,
      last_login_at: null,
      created_at: '2024-01-15T10:00:00Z',
      last_sso_login_at: null,
      last_sso_provider: null,
      is_managed: false,
    },
    ...over,
  };
}

const editButton = () => screen.queryByRole('button', { name: 'Edit name' });

function renderCard(opts: { namesEditable?: boolean; callerRole?: Role; m?: MemberDetailsData; currentUserId?: string }) {
  render(
    <UserDetailsCard
      member={opts.m ?? member()}
      currentUserId={opts.currentUserId ?? 'caller-1'}
      currentUserRole={opts.callerRole ?? 'admin'}
      namesEditable={opts.namesEditable ?? true}
    />
  );
}

describe('C18 when the button shows', () => {
  it('U1 admin, manual brokerage, another member -> shown', () => {
    renderCard({});
    expect(editButton()).toBeInTheDocument();
  });

  it('U2 directory-managed brokerage (namesEditable false) -> hidden', () => {
    renderCard({ namesEditable: false });
    expect(editButton()).toBeNull();
  });

  it('namesEditable omitted -> hidden (the page sends it on purpose)', () => {
    render(<UserDetailsCard member={member()} currentUserId="caller-1" currentUserRole="admin" />);
    expect(editButton()).toBeNull();
  });

  it.each(['broker', 'agent'] as Role[])('U3 %s caller -> hidden', (role) => {
    renderCard({ callerRole: role });
    expect(editButton()).toBeNull();
  });

  it('U3 own row -> hidden', () => {
    renderCard({ currentUserId: 'user-1' });
    expect(editButton()).toBeNull();
  });

  it('U3 admin viewing an it_admin -> hidden; it_admin viewing an it_admin -> shown', () => {
    renderCard({ m: member({ role: 'it_admin' }) });
    expect(editButton()).toBeNull();
    cleanup();
    renderCard({ m: member({ role: 'it_admin' }), callerRole: 'it_admin' });
    expect(editButton()).toBeInTheDocument();
  });

  it.each(['suspended', 'expired'] as MemberLicenseStatus[])('U3b deactivated target (%s) -> hidden', (status) => {
    renderCard({ m: member({ license_status: status }) });
    expect(editButton()).toBeNull();
  });

  it("an 'unassigned' target -> shown", () => {
    renderCard({ m: member({ license_status: 'unassigned' }) });
    expect(editButton()).toBeInTheDocument();
  });

  it('U10 unclaimed invite -> shown, prefilled with the invite names', () => {
    renderCard({
      m: member({ user_id: null, user: undefined, license_status: 'pending', invited_email: 'inv@fixture.example.test', invited_first_name: 'Ivy', invited_last_name: 'Nash' }),
    });
    fireEvent.click(editButton()!);
    expect(screen.getByLabelText('First name')).toHaveValue('Ivy');
    expect(screen.getByLabelText('Last name')).toHaveValue('Nash');
  });
});

describe('the modal', () => {
  function renderModal() {
    const onClose = jest.fn();
    render(<EditNameModal isOpen onClose={onClose} memberId="member-1" initialFirstName="Ann" initialLastName="Lee" />);
    return onClose;
  }

  it('U4 prefilled, with the note', () => {
    renderModal();
    expect(screen.getByLabelText('First name')).toHaveValue('Ann');
    expect(screen.getByLabelText('Last name')).toHaveValue('Lee');
    expect(screen.getByText(MEMBER_NAME_NOTE)).toBeInTheDocument();
    expect(MEMBER_NAME_NOTE).toBe('Updates from Microsoft or Google at the next sign-in.');
  });

  it('U6 success -> action called with the typed names, refresh, close', async () => {
    mockSetMemberName.mockResolvedValue({ success: true, displayName: 'Bo Lee' });
    const onClose = renderModal();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Bo' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(mockSetMemberName).toHaveBeenCalledWith({ memberId: 'member-1', firstName: 'Bo', lastName: 'Lee' });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('U7 refused -> inline error, inputs kept, not closed', async () => {
    mockSetMemberName.mockResolvedValue({ success: false, error: MEMBER_NAME_ERRORS.directoryManaged });
    const onClose = renderModal();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(MEMBER_NAME_ERRORS.directoryManaged);
    expect(screen.getByLabelText('First name')).toHaveValue('Ann');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('U8 both empty -> inline error, no call', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: ' ' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(MEMBER_NAME_ERRORS.invalidName);
    expect(mockSetMemberName).not.toHaveBeenCalled();
  });
});

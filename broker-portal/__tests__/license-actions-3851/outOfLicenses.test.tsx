/**
 * BACKLOG-3851 PR-2b: the out-of-licenses prompt and the licence modals — REAL renders.
 *
 * C6  OutOfLicensesNotice wording by the CALLER's role.
 * C3  (modal side) InviteUserModal: outOfSeats -> the notice, no red banner,
 *     the form stays open, no refresh.
 * C7  ReactivateUserModal: seat_limit_reached -> notice, modal open, no
 *     refresh; success -> refresh + close.
 * C8  UnassignLicenseModal: success -> refresh + close; a returned error is
 *     shown. (last_manager cannot be produced through the portal; its text is
 *     not counted as coverage.)
 * Resend: outOfSeats -> the notice on the Users list instead of "Failed to resend".
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockRefresh = jest.fn();
const mockSetMemberLicense = jest.fn();
const mockInviteUser = jest.fn();
const mockResendInvite = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh, push: jest.fn() }) }));
jest.mock('@/lib/actions/memberLicense', () => ({ setMemberLicense: (...a: unknown[]) => mockSetMemberLicense(...a) }));
jest.mock('@/lib/actions/inviteUser', () => ({ inviteUser: (...a: unknown[]) => mockInviteUser(...a) }));
jest.mock('@/lib/actions/resendInvite', () => ({ resendInvite: (...a: unknown[]) => mockResendInvite(...a) }));
jest.mock('@/components/users/EditRoleModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/users/BulkEditRoleModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/users/DeactivateUserModal', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/users/RemoveUserModal', () => ({ __esModule: true, default: () => null }));

import OutOfLicensesNotice from '@/components/users/OutOfLicensesNotice';
import InviteUserModal from '@/components/users/InviteUserModal';
import ReactivateUserModal from '@/components/users/ReactivateUserModal';
import UnassignLicenseModal from '@/components/users/UnassignLicenseModal';
import UserListClient from '@/components/users/UserListClient';
import type { OrganizationMember } from '@/lib/types/users';

const ADMIN_TEXT = /Free a license or/;
const INVITEE = 'new@fixture.invalid';
const emailField = () => screen.getByLabelText('Email Address');
const IT_ADMIN_TEXT = 'Ask a Broker or Admin to add a seat.';

beforeEach(() => {
  mockRefresh.mockReset();
  mockSetMemberLicense.mockReset();
  mockInviteUser.mockReset();
  mockResendInvite.mockReset();
});
afterEach(cleanup);

describe('C6: OutOfLicensesNotice', () => {
  it('admin: free a license or contact Keepr support (PR-2f: a button that opens the support form)', () => {
    render(<OutOfLicensesNotice callerRole="admin" />);
    expect(screen.getByText("You're out of licenses")).toBeInTheDocument();
    expect(screen.getByText(ADMIN_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'contact Keepr support' })).toBeInTheDocument();
    expect(screen.queryByText(IT_ADMIN_TEXT)).toBeNull();
  });

  it('it_admin: ask a Broker or Admin, and no Support link', () => {
    render(<OutOfLicensesNotice callerRole="it_admin" />);
    expect(screen.getByText("You're out of licenses")).toBeInTheDocument();
    expect(screen.getByText(IT_ADMIN_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'contact Keepr support' })).toBeNull();
    expect(screen.queryByText(ADMIN_TEXT)).toBeNull();
  });
});

describe('C3 (modal): InviteUserModal out of seats', () => {
  async function submit(callerRole: string) {
    render(<InviteUserModal isOpen onClose={jest.fn()} organizationId="org-1" callerRole={callerRole} />);
    fireEvent.change(emailField(), { target: { value: INVITEE } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    });
  }

  it('admin: notice shown, no red banner, form still open, no refresh', async () => {
    mockInviteUser.mockResolvedValue({ success: false, outOfSeats: true });
    await submit('admin');
    expect(screen.getByTestId('out-of-licenses')).toHaveTextContent("You're out of licenses");
    expect(screen.getByText(ADMIN_TEXT)).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(emailField()).toHaveValue(INVITEE);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('it_admin wording in the modal', async () => {
    mockInviteUser.mockResolvedValue({ success: false, outOfSeats: true });
    await submit('it_admin');
    expect(screen.getByText(IT_ADMIN_TEXT)).toBeInTheDocument();
  });

  it('any other error keeps the red banner and no notice', async () => {
    mockInviteUser.mockResolvedValue({ success: false, error: 'Failed to create invitation' });
    await submit('admin');
    expect(screen.getByText('Failed to create invitation')).toBeInTheDocument();
    expect(screen.queryByTestId('out-of-licenses')).toBeNull();
  });
});

describe('C7: ReactivateUserModal', () => {
  it('seat_limit_reached -> notice in the modal, stays open, no refresh', async () => {
    mockSetMemberLicense.mockResolvedValue({ success: false, outOfSeats: true });
    const onClose = jest.fn();
    render(<ReactivateUserModal isOpen onClose={onClose} memberId="m1" memberName="Ann" callerRole="admin" orgHasFreeSeat />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    });
    expect(mockSetMemberLicense).toHaveBeenCalledWith({ memberId: 'm1', action: 'reactivate' });
    expect(screen.getByTestId('out-of-licenses')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('success -> refresh and close', async () => {
    mockSetMemberLicense.mockResolvedValue({ success: true, licenseStatus: 'active' });
    const onClose = jest.fn();
    render(<ReactivateUserModal isOpen onClose={onClose} memberId="m1" memberName="Ann" callerRole="admin" orgHasFreeSeat={null} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('C8: UnassignLicenseModal', () => {
  it('success -> refresh and close', async () => {
    mockSetMemberLicense.mockResolvedValue({ success: true, licenseStatus: 'unassigned' });
    const onClose = jest.fn();
    render(<UnassignLicenseModal isOpen onClose={onClose} memberId="m1" memberName="Ann" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unassign' }));
    });
    expect(mockSetMemberLicense).toHaveBeenCalledWith({ memberId: 'm1', action: 'unassign' });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a returned error is shown; modal stays open, no refresh', async () => {
    mockSetMemberLicense.mockResolvedValue({ success: false, error: 'Failed to update license' });
    const onClose = jest.fn();
    render(<UnassignLicenseModal isOpen onClose={onClose} memberId="m1" memberName="Ann" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unassign' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to update license');
    expect(onClose).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe('Resend out of seats on the Users list', () => {
  const invite = {
    id: 'm2', organization_id: 'org-1', user_id: null, role: 'agent', license_status: 'pending',
    invited_email: 'invitee@fixture.invalid', invitation_token: 'tok', invitation_expires_at: null, invited_by: null,
    invited_at: '2024-01-01T00:00:00Z', joined_at: null, last_invited_at: null,
    created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
  } as unknown as OrganizationMember;

  it('shows the notice instead of "Failed to resend"', async () => {
    mockResendInvite.mockResolvedValue({ success: false, outOfSeats: true });
    render(<UserListClient initialMembers={[invite]} currentUserId="u0" currentUserRole="admin" organizationId="org-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Actions for/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Resend Invite' }));
    });
    await waitFor(() => expect(screen.getByTestId('out-of-licenses')).toBeInTheDocument());
    expect(screen.queryByText(/Failed to resend/)).toBeNull();
  });
});

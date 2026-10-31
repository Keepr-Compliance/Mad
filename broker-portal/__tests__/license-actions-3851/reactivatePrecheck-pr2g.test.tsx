/**
 * BACKLOG-3851 PR-2g: the Reactivate dialog knows before the click whether a
 * licence is free.
 *
 * P1  full org: the out-of-licenses notice shows on open, no Reactivate button,
 *     only Close; nothing is sent to the server.
 * P2  free seat (or not known): Reactivate shows, no notice.
 * P3  backstop: free on open, refused on click -> the notice (seat taken in between).
 * P4  the prop reaches the dialog from the Users list and from the user details card.
 * P5  the seat rule mirrors member_row_holds_seat + the seat trigger, boundaries swept.
 * P6  the page loader: reads the org's seat columns, reuses loaded rows, null on a failed read.
 *
 * Row shapes are the columns the pages select (app/dashboard/users/page.tsx,
 * organization_members select) and the trigger reads (organizations.max_seats,
 * organizations.personal_owner_user_id).
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockRefresh = jest.fn();
const mockSetMemberLicense = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh, push: jest.fn() }) }));
jest.mock('@/lib/actions/memberLicense', () => ({ setMemberLicense: (...a: unknown[]) => mockSetMemberLicense(...a) }));
jest.mock('@/lib/actions/inviteUser', () => ({ inviteUser: jest.fn() }));
jest.mock('@/lib/actions/resendInvite', () => ({ resendInvite: jest.fn() }));
jest.mock('@/lib/actions/updateUserRole', () => ({ updateUserRole: jest.fn() }));
jest.mock('@/lib/actions/deactivateUser', () => ({ deactivateUser: jest.fn() }));
jest.mock('@/lib/actions/removeUser', () => ({ removeUser: jest.fn() }));

import ReactivateUserModal from '@/components/users/ReactivateUserModal';
import UserListClient from '@/components/users/UserListClient';
import UserDetailsCard, { type MemberDetailsData } from '@/components/users/UserDetailsCard';
import { loadOrgHasFreeSeat, memberRowHoldsSeat, orgHasFreeSeat, type SeatRow } from '@/lib/users/seatAvailability';
import type { OrganizationMember } from '@/lib/types/users';

beforeEach(() => {
  mockRefresh.mockReset();
  mockSetMemberLicense.mockReset();
});
afterEach(cleanup);

const reactivateButton = () => screen.queryByRole('button', { name: 'Reactivate' });

function renderModal(orgHasFreeSeat: boolean | null, callerRole = 'admin') {
  const onClose = jest.fn();
  render(
    <ReactivateUserModal
      isOpen
      onClose={onClose}
      memberId="m1"
      memberName="Ann"
      callerRole={callerRole}
      organizationName="Fixture Realty"
      orgHasFreeSeat={orgHasFreeSeat}
    />
  );
  return onClose;
}

describe('P1: full org', () => {
  it('opens with the notice, no Reactivate button, only Close', () => {
    const onClose = renderModal(false);
    expect(screen.getByTestId('out-of-licenses')).toHaveTextContent("You're out of licenses");
    expect(screen.getByRole('button', { name: 'contact Keepr support' })).toBeInTheDocument();
    expect(reactivateButton()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    // The footer button (the header X is also labelled Close).
    fireEvent.click(screen.getByText('Close', { selector: 'button' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockSetMemberLicense).not.toHaveBeenCalled();
  });

  it('it_admin caller gets the it_admin wording', () => {
    renderModal(false, 'it_admin');
    expect(screen.getByText('Ask a Broker or Admin to add a seat.')).toBeInTheDocument();
    expect(reactivateButton()).toBeNull();
  });
});

describe('P2: free seat or not known', () => {
  it.each([[true], [null]])('orgHasFreeSeat=%s: Reactivate and Cancel, no notice', (free) => {
    renderModal(free);
    expect(reactivateButton()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByTestId('out-of-licenses')).toBeNull();
  });
});

describe('P3: the server refusal stays as the backstop', () => {
  it('free on open, refused on click -> notice, modal open, no refresh', async () => {
    mockSetMemberLicense.mockResolvedValue({ success: false, outOfSeats: true });
    const onClose = renderModal(true);
    expect(screen.queryByTestId('out-of-licenses')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    });
    expect(mockSetMemberLicense).toHaveBeenCalledWith({ memberId: 'm1', action: 'reactivate' });
    expect(screen.getByTestId('out-of-licenses')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

function suspendedMember(): OrganizationMember {
  return {
    id: 'm1', organization_id: 'org-1', user_id: 'u1', role: 'agent', license_status: 'suspended',
    invited_email: null, invitation_token: null, invitation_expires_at: null, invited_by: null,
    invited_at: '2024-01-01T00:00:00Z', joined_at: '2024-01-01T00:00:00Z', last_invited_at: null,
    created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    user: { id: 'u1', email: 'ann@fixture.invalid', first_name: 'Ann', last_name: 'Fixture', display_name: null, avatar_url: null },
  } as unknown as OrganizationMember;
}

describe('P4: the pages pass the seat state through', () => {
  it.each([[false, true], [true, false]])('Users list, orgHasFreeSeat=%s -> notice on open: %s', (free, notice) => {
    render(
      <UserListClient
        initialMembers={[suspendedMember()]}
        currentUserId="u0"
        currentUserRole="admin"
        organizationId="org-1"
        orgHasFreeSeat={free}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /Actions for/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reactivate User' }));
    expect(!!screen.queryByTestId('out-of-licenses')).toBe(notice);
    expect(!!reactivateButton()).toBe(!notice);
  });

  it.each([[false, true], [true, false]])('details card, orgHasFreeSeat=%s -> notice on open: %s', (free, notice) => {
    const m = suspendedMember() as unknown as Record<string, unknown>;
    const detail = {
      ...m, provisioned_by: 'invite', provisioned_at: null, scim_synced_at: null, provisioning_metadata: null, idp_groups: null,
      user: { ...(m.user as object), last_login_at: null, created_at: '2024-01-01T00:00:00Z', last_sso_login_at: null, last_sso_provider: null, is_managed: false },
    } as unknown as MemberDetailsData;
    render(<UserDetailsCard member={detail} currentUserId="u0" currentUserRole="admin" orgHasFreeSeat={free} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate User' }));
    expect(!!screen.queryByTestId('out-of-licenses')).toBe(notice);
    expect(!!reactivateButton()).toBe(!notice);
  });
});

const NOW = Date.parse('2026-10-18T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const row = (license_status: string, opts: Partial<SeatRow> = {}): SeatRow => ({
  license_status, invitation_expires_at: null, user_id: null, ...opts,
});

describe('P5: seat rule (member_row_holds_seat + _enforce_member_seat_limit)', () => {
  it.each<[string, SeatRow, boolean]>([
    ['active', row('active', { user_id: 'u' }), true],
    ['pending, claimed', row('pending', { user_id: 'u', invitation_expires_at: iso(NOW - 1000) }), true],
    ['pending, no expiry', row('pending'), true],
    ['pending, expires exactly now', row('pending', { invitation_expires_at: iso(NOW) }), true],
    ['pending, expires 1ms later', row('pending', { invitation_expires_at: iso(NOW + 1) }), true],
    ['pending, expired 1ms ago', row('pending', { invitation_expires_at: iso(NOW - 1) }), false],
    ['unassigned', row('unassigned', { user_id: 'u' }), false],
    ['suspended', row('suspended', { user_id: 'u' }), false],
    ['expired', row('expired', { user_id: 'u' }), false],
    ['null status', row(null as unknown as string), false],
  ])('%s holds a seat: %s', (_label, r, holds) => {
    expect(memberRowHoldsSeat(r, NOW)).toBe(holds);
  });

  const team = { max_seats: 2, personal_owner_user_id: null };
  const active = row('active', { user_id: 'u' });

  it('used = max - 1 -> free; used = max -> full; used > max -> full', () => {
    expect(orgHasFreeSeat(team, [active], NOW)).toBe(true);
    expect(orgHasFreeSeat(team, [active, active], NOW)).toBe(false);
    expect(orgHasFreeSeat(team, [active, active, active], NOW)).toBe(false);
  });

  it('an unexpired unclaimed invite fills the last seat; an expired one does not', () => {
    expect(orgHasFreeSeat(team, [active, row('pending', { invitation_expires_at: iso(NOW + 60_000) })], NOW)).toBe(false);
    expect(orgHasFreeSeat(team, [active, row('pending', { invitation_expires_at: iso(NOW - 60_000) })], NOW)).toBe(true);
  });

  it('suspended, expired and unassigned rows do not count', () => {
    const rows = [active, row('suspended', { user_id: 'a' }), row('expired', { user_id: 'b' }), row('unassigned', { user_id: 'c' })];
    expect(orgHasFreeSeat(team, rows, NOW)).toBe(true);
  });

  it.each([[null], [0], [-1]])('max_seats=%s -> no limit', (max) => {
    expect(orgHasFreeSeat({ max_seats: max, personal_owner_user_id: null }, [active, active, active], NOW)).toBe(true);
  });

  it('max_seats=1 with one active -> full', () => {
    expect(orgHasFreeSeat({ max_seats: 1, personal_owner_user_id: null }, [active], NOW)).toBe(false);
  });

  it('personal organization -> no limit', () => {
    expect(orgHasFreeSeat({ max_seats: 1, personal_owner_user_id: 'owner' }, [active, active], NOW)).toBe(true);
  });
});

describe('P6: page loader', () => {
  function fakeClient(answers: { org: unknown; orgError?: unknown; members?: unknown; membersError?: unknown }) {
    const tables: string[] = [];
    const client = {
      from(table: string) {
        tables.push(table);
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: () => (table === 'organization_members'
            ? Promise.resolve({ data: answers.members ?? null, error: answers.membersError ?? null })
            : builder),
          maybeSingle: async () => ({ data: answers.org, error: answers.orgError ?? null }),
        };
        return builder;
      },
    };
    return { client: client as never, tables };
  }

  const full = { max_seats: 1, personal_owner_user_id: null };
  const activeRow = { id: 'x', license_status: 'active', invitation_expires_at: null, user_id: 'u' };

  it('reuses rows the page already loaded (no members query)', async () => {
    const { client, tables } = fakeClient({ org: full });
    await expect(loadOrgHasFreeSeat(client, 'org-1', [activeRow])).resolves.toBe(false);
    expect(tables).toEqual(['organizations']);
  });

  it('reads the member rows when none are passed', async () => {
    const { client, tables } = fakeClient({ org: full, members: [] });
    await expect(loadOrgHasFreeSeat(client, 'org-1')).resolves.toBe(true);
    expect(tables).toEqual(['organizations', 'organization_members']);
  });

  it('a failed read -> null (not known)', async () => {
    await expect(loadOrgHasFreeSeat(fakeClient({ org: null, orgError: { message: 'x' } }).client, 'org-1')).resolves.toBeNull();
    await expect(loadOrgHasFreeSeat(fakeClient({ org: full, membersError: { message: 'x' } }).client, 'org-1')).resolves.toBeNull();
  });
});

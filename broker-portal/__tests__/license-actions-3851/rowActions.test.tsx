/**
 * BACKLOG-3851 PR-2b: which licence actions a member row shows — REAL renders.
 *
 * C5  the list menu (UserActionsDropdown, reached through UserTableRow and
 *     UserCard exactly as UserListClient mounts them).
 * C11 the detail page (UserDetailsCard).
 * Both are checked against ONE expectation table (the plan's s2a table), so a
 * component that keeps its own `=== 'suspended'` check, or shows Deactivate on
 * a deactivated row or on an invite, goes red here.
 *
 * 'expired' has no producer today (0 rows on prod): latent coverage, kept
 * because it is cheap.
 *
 * Switch: MEMBER_LICENSE_ASSIGN_UNASSIGN_ENABLED (lib/users/memberLicenseActions.ts).
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }) }));
jest.mock('@/lib/actions/memberLicense', () => ({ setMemberLicense: jest.fn() }));
jest.mock('@/lib/actions/updateUserRole', () => ({ updateUserRole: jest.fn() }));
jest.mock('@/lib/actions/deactivateUser', () => ({ deactivateUser: jest.fn() }));
jest.mock('@/lib/actions/removeUser', () => ({ removeUser: jest.fn() }));

import UserTableRow from '@/components/users/UserTableRow';
import UserCard from '@/components/users/UserCard';
import UserDetailsCard, { type MemberDetailsData } from '@/components/users/UserDetailsCard';
import { memberRowActions, MEMBER_LICENSE_ASSIGN_UNASSIGN_ENABLED } from '@/lib/users/memberLicenseActions';
import type { OrganizationMember } from '@/lib/types/users';

afterEach(cleanup);

type Status = 'active' | 'unassigned' | 'suspended' | 'expired' | 'pending';
type Licence = 'Assign license' | 'Unassign license' | 'Reactivate User' | null;

/** The plan's s2a table, written out. */
const EXPECTED: Record<Status, { licence: Licence; deactivate: boolean }> = {
  active: { licence: 'Unassign license', deactivate: true },
  unassigned: { licence: 'Assign license', deactivate: true },
  suspended: { licence: 'Reactivate User', deactivate: false },
  expired: { licence: 'Reactivate User', deactivate: false },
  pending: { licence: null, deactivate: false },
};
const STATUSES = Object.keys(EXPECTED) as Status[];
const LICENCE_LABELS = ['Assign license', 'Unassign license', 'Reactivate User'];

function expectedFor(status: Status, targetRole: string, callerRole: string) {
  const e = EXPECTED[status];
  const blocked = targetRole === 'it_admin' && callerRole !== 'it_admin';
  return { licence: blocked ? null : e.licence, deactivate: e.deactivate };
}

function listMember(status: Status, role: string): OrganizationMember {
  const claimed = status !== 'pending';
  return {
    id: 'm1',
    organization_id: 'org-1',
    user_id: claimed ? 'u1' : null,
    role,
    license_status: status,
    invited_email: claimed ? null : 'invitee@fixture.invalid',
    invitation_token: claimed ? null : 'tok',
    invitation_expires_at: null,
    invited_by: null,
    invited_at: '2024-01-01T00:00:00Z',
    joined_at: claimed ? '2024-01-01T00:00:00Z' : null,
    last_invited_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    user: claimed
      ? { id: 'u1', email: 'ann@fixture.invalid', first_name: 'Ann', last_name: 'Fixture', display_name: null, avatar_url: null }
      : undefined,
  } as unknown as OrganizationMember;
}

function menuItems(): string[] {
  fireEvent.click(screen.getByRole('button', { name: /Actions for/ }));
  return within(screen.getByRole('menu'))
    .getAllByRole('menuitem')
    .map((b) => b.textContent ?? '');
}

function assertMenu(items: string[], exp: { licence: Licence; deactivate: boolean }) {
  const shownLicence = items.filter((i) => LICENCE_LABELS.includes(i));
  expect(shownLicence).toEqual(exp.licence ? [exp.licence] : []);
  expect(items.includes('Deactivate User')).toBe(exp.deactivate);
}

const CASES = STATUSES.flatMap((status) =>
  (['admin', 'it_admin'] as const).flatMap((callerRole) =>
    (['agent', 'it_admin'] as const).map((targetRole) => [status, callerRole, targetRole] as const)
  )
);

describe('C5: list menu (real render)', () => {
  it.each(CASES)('table row: %s row, caller %s, target %s', (status, callerRole, targetRole) => {
    render(
      <table>
        <tbody>
          <UserTableRow
            member={listMember(status, targetRole)}
            isSelected={false}
            isCurrentUser={false}
            canManage
            onToggleSelect={jest.fn()}
            onEditRole={jest.fn()}
            onResendInvite={jest.fn()}
            onDeactivate={jest.fn()}
            onRemove={jest.fn()}
            callerRole={callerRole}
            onLicenseAction={jest.fn()}
          />
        </tbody>
      </table>
    );
    assertMenu(menuItems(), expectedFor(status, targetRole, callerRole));
  });

  it.each(CASES)('card: %s row, caller %s, target %s', (status, callerRole, targetRole) => {
    render(
      <UserCard
        member={listMember(status, targetRole)}
        isCurrentUser={false}
        canManage
        callerRole={callerRole}
        onLicenseAction={jest.fn()}
      />
    );
    assertMenu(menuItems(), expectedFor(status, targetRole, callerRole));
  });

  it('clicking the licence item hands the action to the list', () => {
    const onLicenseAction = jest.fn();
    render(
      <UserCard member={listMember('suspended', 'agent')} isCurrentUser={false} canManage callerRole="admin" onLicenseAction={onLicenseAction} />
    );
    fireEvent.click(screen.getByRole('button', { name: /Actions for/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reactivate User' }));
    expect(onLicenseAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'reactivate');
  });
});

function detailMember(status: Status, role: string): MemberDetailsData {
  const m = listMember(status, role) as unknown as Record<string, unknown>;
  return {
    ...m,
    provisioned_by: 'invite',
    provisioned_at: null,
    scim_synced_at: null,
    provisioning_metadata: null,
    idp_groups: null,
    user: m.user
      ? { ...(m.user as object), last_login_at: null, created_at: '2024-01-01T00:00:00Z', last_sso_login_at: null, last_sso_provider: null, is_managed: false }
      : undefined,
  } as unknown as MemberDetailsData;
}

describe('C11: detail page (real render, same table)', () => {
  it.each(CASES)('%s row, caller %s, target %s', (status, callerRole, targetRole) => {
    render(<UserDetailsCard member={detailMember(status, targetRole)} currentUserId="u-caller" currentUserRole={callerRole} />);
    const exp = expectedFor(status, targetRole, callerRole);
    const buttons = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(buttons.filter((b) => LICENCE_LABELS.includes(b))).toEqual(exp.licence ? [exp.licence] : []);
    expect(buttons.includes('Deactivate')).toBe(exp.deactivate);
  });
});

describe('release switch: MEMBER_LICENSE_ASSIGN_UNASSIGN_ENABLED', () => {
  it('ships ON', () => {
    expect(MEMBER_LICENSE_ASSIGN_UNASSIGN_ENABLED).toBe(true);
  });

  it('OFF hides Assign and Unassign only; Reactivate and Deactivate are unchanged', () => {
    const row = (licenseStatus: string) => ({ licenseStatus, isClaimed: true, targetRole: 'agent', callerRole: 'admin' });
    expect(memberRowActions(row('active'), false)).toEqual({ licenseAction: null, showDeactivate: true });
    expect(memberRowActions(row('unassigned'), false)).toEqual({ licenseAction: null, showDeactivate: true });
    expect(memberRowActions(row('suspended'), false)).toEqual({ licenseAction: 'reactivate', showDeactivate: false });
    expect(memberRowActions(row('expired'), false)).toEqual({ licenseAction: 'reactivate', showDeactivate: false });
  });
});

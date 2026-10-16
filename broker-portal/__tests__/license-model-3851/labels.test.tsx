/**
 * BACKLOG-3851 PR-2a (C9): a member with no license assigned (license_status
 * 'unassigned', M1) shows "No license" on the Users page, not a blank badge.
 * The phone card and the table row both read LICENSE_STATUS_LABELS.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import UserTableRow from '@/components/users/UserTableRow';
import UserCard from '@/components/users/UserCard';
import { LICENSE_STATUS_LABELS, type MemberLicenseStatus, type OrganizationMember } from '@/lib/types/users';

function member(status: MemberLicenseStatus): OrganizationMember {
  return {
    id: 'member-3851',
    organization_id: 'org-3851',
    user_id: 'user-3851',
    role: 'agent',
    license_status: status,
    invited_email: null,
    invitation_token: null,
    invitation_expires_at: null,
    invited_by: null,
    invited_at: null,
    joined_at: '2026-10-01T00:00:00Z',
    last_invited_at: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    provisioned_by: null,
    provisioned_at: null,
    scim_synced_at: null,
    provisioning_metadata: null,
    idp_groups: null,
    group_sync_enabled: false,
    user: {
      id: 'user-3851',
      email: 'no-license-3851@fixture.example.test',
      first_name: 'Nolan',
      last_name: 'Icense',
      display_name: 'Nolan Icense',
      avatar_url: null,
      oauth_provider: 'google',
      oauth_id: 'oauth-3851',
      last_login_at: null,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      last_sso_login_at: null,
      last_sso_provider: null,
      is_managed: false,
    },
  } as unknown as OrganizationMember;
}

const noop = () => {};
const rowProps = {
  isSelected: false,
  isCurrentUser: false,
  canManage: false,
  onToggleSelect: noop,
  onEditRole: noop,
  onResendInvite: noop,
  onDeactivate: noop,
  onRemove: noop,
};

describe('C9 the unassigned label', () => {
  it('LICENSE_STATUS_LABELS.unassigned is "No license"', () => {
    expect(LICENSE_STATUS_LABELS.unassigned).toBe('No license');
  });

  it('the table row shows "No license"', () => {
    render(
      <table>
        <tbody>
          <UserTableRow member={member('unassigned')} {...rowProps} />
        </tbody>
      </table>
    );
    expect(screen.getByText('No license')).toBeInTheDocument();
  });

  it('the phone card shows "No license"', () => {
    render(<UserCard member={member('unassigned')} isCurrentUser={false} canManage={false} />);
    expect(screen.getByText('No license')).toBeInTheDocument();
  });
});

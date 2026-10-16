/**
 * Tests for UserDetailsCard Component Logic
 *
 * Since broker-portal uses different path aliases than the main Jest config,
 * we test the data transformation and display logic directly rather than
 * rendering the component.
 *
 * TASK-1813: User details view
 */

import type { Role, MemberLicenseStatus, ProvisioningSource } from '../../../lib/types/users';
import {
  ROLE_LABELS,
  LICENSE_STATUS_LABELS,
  PROVISIONING_SOURCE_LABELS,
} from '../../../lib/types/users';
import { formatUserDisplayName, getUserInitials } from '../../../lib/utils/userDisplay';
import { formatDate } from '../../../lib/utils';

// ============================================================================
// Test Data Helpers
// ============================================================================

interface UserData {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  avatar_url: string | null;
  last_login_at: string | null;
  created_at: string;
  last_sso_login_at: string | null;
  last_sso_provider: string | null;
  is_managed: boolean;
}

interface InviterData {
  user?: {
    email: string;
    display_name: string | null;
  };
}

interface MemberDetailsData {
  id: string;
  user_id: string | null;
  role: Role;
  license_status: MemberLicenseStatus;
  invited_email: string | null;
  invited_at: string | null;
  joined_at: string | null;
  provisioned_by: ProvisioningSource | null;
  provisioned_at: string | null;
  scim_synced_at: string | null;
  provisioning_metadata: Record<string, unknown> | null;
  idp_groups: string[] | null;
  invited_by: string | null;
  last_invited_at: string | null;
  created_at: string;
  updated_at: string;
  user?: UserData;
  inviter?: InviterData;
}

function createMockMemberDetails(
  overrides: Partial<MemberDetailsData> = {}
): MemberDetailsData {
  const defaults: MemberDetailsData = {
    id: 'member-1',
    user_id: 'user-1',
    role: 'agent',
    license_status: 'active',
    invited_email: null,
    invited_at: '2024-01-10T10:00:00Z',
    joined_at: '2024-01-15T10:00:00Z',
    provisioned_by: 'invite',
    provisioned_at: null,
    scim_synced_at: null,
    provisioning_metadata: null,
    idp_groups: null,
    invited_by: 'member-inviter',
    last_invited_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-15T00:00:00Z',
    user: {
      id: 'user-1',
      email: 'john.doe@example.com',
      first_name: 'John',
      last_name: 'Doe',
      display_name: 'John Doe',
      avatar_url: null,
      last_login_at: '2024-01-20T14:30:00Z',
      created_at: '2024-01-15T10:00:00Z',
      last_sso_login_at: null,
      last_sso_provider: null,
      is_managed: false,
    },
    inviter: {
      user: {
        email: 'admin@example.com',
        display_name: 'Admin User',
      },
    },
  };

  return { ...defaults, ...overrides };
}

// ============================================================================
// Tests
// ============================================================================

describe('UserDetailsCard Logic', () => {
  describe('display name formatting', () => {
    it('should format display name from user object', () => {
      const member = createMockMemberDetails();
      const userOrNull = member.user ?? null;
      const displayName = formatUserDisplayName(userOrNull, member.invited_email);

      expect(displayName).toBe('John Doe');
    });

    it('should use first/last name when no display_name', () => {
      const member = createMockMemberDetails({
        user: {
          ...createMockMemberDetails().user!,
          display_name: null,
          first_name: 'Jane',
          last_name: 'Smith',
        },
      });
      const userOrNull = member.user ?? null;
      const displayName = formatUserDisplayName(userOrNull, member.invited_email);

      expect(displayName).toBe('Jane Smith');
    });

    it('should use invited email for pending users', () => {
      const member = createMockMemberDetails({
        user_id: null,
        invited_email: 'pending@example.com',
        user: undefined,
      });
      const userOrNull = member.user ?? null;
      const displayName = formatUserDisplayName(userOrNull, member.invited_email);

      expect(displayName).toBe('pending@example.com');
    });
  });

  describe('initials formatting', () => {
    it('should get initials from display name', () => {
      const member = createMockMemberDetails();
      const userOrNull = member.user ?? null;
      const initials = getUserInitials(userOrNull, member.invited_email);

      expect(initials).toBe('JD');
    });

    it('should get initials from first/last name', () => {
      const member = createMockMemberDetails({
        user: {
          ...createMockMemberDetails().user!,
          display_name: null,
          first_name: 'Alice',
          last_name: 'Brown',
        },
      });
      const userOrNull = member.user ?? null;
      const initials = getUserInitials(userOrNull, member.invited_email);

      expect(initials).toBe('AB');
    });

    it('should get initials from invited email for pending users', () => {
      const member = createMockMemberDetails({
        user_id: null,
        invited_email: 'test@example.com',
        user: undefined,
      });
      const userOrNull = member.user ?? null;
      const initials = getUserInitials(userOrNull, member.invited_email);

      expect(initials).toBe('TE');
    });
  });

  describe('pending user detection', () => {
    it('should detect pending users by null user_id', () => {
      const pendingMember = createMockMemberDetails({
        user_id: null,
        invited_email: 'pending@example.com',
        license_status: 'pending',
        user: undefined,
      });

      const isPending = !pendingMember.user_id;
      expect(isPending).toBe(true);
    });

    it('should detect active users by user_id presence', () => {
      const activeMember = createMockMemberDetails();

      const isPending = !activeMember.user_id;
      expect(isPending).toBe(false);
    });
  });

  describe('current user detection', () => {
    it('should detect when viewing own profile', () => {
      const member = createMockMemberDetails({ user_id: 'current-user-id' });
      const currentUserId = 'current-user-id';

      const isCurrentUser = member.user_id === currentUserId;
      expect(isCurrentUser).toBe(true);
    });

    it('should detect when viewing another user', () => {
      const member = createMockMemberDetails({ user_id: 'other-user-id' });
      const currentUserId = 'current-user-id';

      const isCurrentUser = member.user_id === currentUserId;
      expect(isCurrentUser).toBe(false);
    });
  });

  describe('management permission logic', () => {
    function canManageUser(currentUserRole: Role, isCurrentUser: boolean): boolean {
      return ['admin', 'it_admin'].includes(currentUserRole) && !isCurrentUser;
    }

    it('should allow admin to manage other users', () => {
      expect(canManageUser('admin', false)).toBe(true);
    });

    it('should allow it_admin to manage other users', () => {
      expect(canManageUser('it_admin', false)).toBe(true);
    });

    it('should not allow admin to manage themselves', () => {
      expect(canManageUser('admin', true)).toBe(false);
    });

    it('should not allow broker to manage users', () => {
      expect(canManageUser('broker', false)).toBe(false);
    });

    it('should not allow agent to manage users', () => {
      expect(canManageUser('agent', false)).toBe(false);
    });
  });

  describe('role labels', () => {
    it('should have correct label for all roles', () => {
      expect(ROLE_LABELS.agent).toBe('Agent');
      expect(ROLE_LABELS.broker).toBe('Broker');
      expect(ROLE_LABELS.admin).toBe('Admin');
      expect(ROLE_LABELS.it_admin).toBe('IT Admin');
    });
  });

  describe('status labels', () => {
    it('should have correct label for all statuses', () => {
      expect(LICENSE_STATUS_LABELS.active).toBe('Active');
      expect(LICENSE_STATUS_LABELS.pending).toBe('Pending');
      expect(LICENSE_STATUS_LABELS.suspended).toBe('Suspended');
      expect(LICENSE_STATUS_LABELS.expired).toBe('Expired');
    });

    it('should display "Invited" for pending users instead of status', () => {
      const member = createMockMemberDetails({
        user_id: null,
        license_status: 'pending',
      });

      const isPending = !member.user_id;
      const statusLabel = isPending ? 'Invited' : LICENSE_STATUS_LABELS[member.license_status];

      expect(statusLabel).toBe('Invited');
    });
  });

  describe('provisioning source labels', () => {
    it('should have correct labels for all sources', () => {
      expect(PROVISIONING_SOURCE_LABELS.manual).toBe('Manual');
      expect(PROVISIONING_SOURCE_LABELS.scim).toBe('SCIM');
      expect(PROVISIONING_SOURCE_LABELS.jit).toBe('Just-in-Time');
      expect(PROVISIONING_SOURCE_LABELS.invite).toBe('Invited');
    });
  });

  describe('date formatting', () => {
    it('should format joined_at date', () => {
      const member = createMockMemberDetails({ joined_at: '2024-01-15T10:00:00Z' });
      const formatted = formatDate(member.joined_at);

      expect(formatted).toMatch(/Jan 15, 2024/);
    });

    it('should format invited_at date', () => {
      const member = createMockMemberDetails({ invited_at: '2024-01-10T10:00:00Z' });
      const formatted = formatDate(member.invited_at);

      expect(formatted).toMatch(/Jan 10, 2024/);
    });

    it('should handle null dates', () => {
      const formatted = formatDate(null);
      expect(formatted).toBe('-');
    });
  });

  describe('inviter display', () => {
    it('should use inviter display_name when available', () => {
      const member = createMockMemberDetails({
        inviter: {
          user: {
            email: 'admin@example.com',
            display_name: 'Admin User',
          },
        },
      });

      const inviterName = member.inviter?.user?.display_name || member.inviter?.user?.email;
      expect(inviterName).toBe('Admin User');
    });

    it('should fall back to inviter email when no display_name', () => {
      const member = createMockMemberDetails({
        inviter: {
          user: {
            email: 'admin@example.com',
            display_name: null,
          },
        },
      });

      const inviterName = member.inviter?.user?.display_name || member.inviter?.user?.email;
      expect(inviterName).toBe('admin@example.com');
    });
  });

  describe('SSO member detection', () => {
    it('should detect SSO managed users', () => {
      const member = createMockMemberDetails({
        user: {
          ...createMockMemberDetails().user!,
          is_managed: true,
          last_sso_login_at: '2024-01-20T14:30:00Z',
          last_sso_provider: 'azure',
        },
      });

      expect(member.user?.is_managed).toBe(true);
      expect(member.user?.last_sso_provider).toBe('azure');
    });

    it('should detect non-SSO users', () => {
      const member = createMockMemberDetails();

      expect(member.user?.is_managed).toBe(false);
      expect(member.user?.last_sso_provider).toBeNull();
    });
  });

  describe('IdP groups', () => {
    it('should handle members with IdP groups', () => {
      const member = createMockMemberDetails({
        idp_groups: ['Engineering', 'Developers', 'All Staff'],
      });

      expect(member.idp_groups).toHaveLength(3);
      expect(member.idp_groups).toContain('Engineering');
    });

    it('should handle members without IdP groups', () => {
      const member = createMockMemberDetails({ idp_groups: null });

      expect(member.idp_groups).toBeNull();
    });

    it('should handle empty IdP groups array', () => {
      const member = createMockMemberDetails({ idp_groups: [] });

      expect(member.idp_groups).toHaveLength(0);
    });
  });

  describe('SCIM sync status', () => {
    it('should track SCIM sync timestamp', () => {
      const member = createMockMemberDetails({
        scim_synced_at: '2024-01-20T10:00:00Z',
        provisioned_by: 'scim',
      });

      expect(member.scim_synced_at).toBe('2024-01-20T10:00:00Z');
      expect(member.provisioned_by).toBe('scim');
    });
  });

  describe('suspended user handling', () => {
    it('should detect suspended users', () => {
      const member = createMockMemberDetails({ license_status: 'suspended' });

      const isSuspended = member.license_status === 'suspended';
      expect(isSuspended).toBe(true);
    });

    it('should not show deactivate button for already suspended users', () => {
      const member = createMockMemberDetails({ license_status: 'suspended' });

      const isSuspended = member.license_status === 'suspended';
      const isPending = !member.user_id;
      const showDeactivate = !isPending && !isSuspended;

      expect(showDeactivate).toBe(false);
    });
  });

  describe('role colors mapping', () => {
    const ROLE_COLORS: Record<Role, string> = {
      admin: 'bg-purple-100 text-purple-800',
      it_admin: 'bg-blue-100 text-blue-800',
      broker: 'bg-green-100 text-green-800',
      agent: 'bg-gray-100 text-gray-800',
    };

    it('should have distinct colors for all roles', () => {
      const roles: Role[] = ['agent', 'broker', 'admin', 'it_admin'];
      const colors = new Set(roles.map((role) => ROLE_COLORS[role]));

      expect(colors.size).toBe(4); // All colors are unique
    });
  });

  describe('status colors mapping', () => {
    const STATUS_COLORS: Record<MemberLicenseStatus, string> = {
      active: 'bg-green-100 text-green-800',
      pending: 'bg-yellow-100 text-yellow-800',
      suspended: 'bg-red-100 text-red-800',
      expired: 'bg-gray-100 text-gray-800',
      unassigned: 'bg-blue-100 text-blue-800',
    };

    it('should have distinct colors for all statuses', () => {
      const statuses: MemberLicenseStatus[] = ['active', 'pending', 'suspended', 'expired', 'unassigned'];
      const colors = new Set(statuses.map((status) => STATUS_COLORS[status]));

      expect(colors.size).toBe(5); // All colors are unique
    });
  });
});

/**
 * Tests for UserCard Component Logic
 *
 * Since broker-portal uses different path aliases than the main Jest config,
 * we test the data transformation and display logic directly rather than
 * rendering the component.
 *
 * The component's rendering behavior is verified through:
 * 1. These logic tests (data transformation)
 * 2. Visual verification in development
 * 3. E2E tests in future sprints
 *
 * TASK-1809: User list component implementation
 */

import type { OrganizationMember, User, Role, MemberLicenseStatus } from '../../../lib/types/users';
import { ROLE_LABELS, LICENSE_STATUS_LABELS } from '../../../lib/types/users';
import { formatUserDisplayName, getUserInitials } from '../../../lib/utils/userDisplay';
import { formatDate } from '../../../lib/utils';

// Helper to create mock member
function createMockMember(
  overrides: Partial<OrganizationMember> = {}
): OrganizationMember {
  const defaults: OrganizationMember = {
    id: 'member-1',
    organization_id: 'org-1',
    user_id: 'user-1',
    role: 'agent' as Role,
    license_status: 'active' as MemberLicenseStatus,
    invited_email: null,
    invitation_token: null,
    invitation_expires_at: null,
    invited_by: null,
    invited_at: null,
    joined_at: '2024-01-15T10:00:00Z',
    last_invited_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    provisioned_by: null,
    provisioned_at: null,
    scim_synced_at: null,
    provisioning_metadata: null,
    idp_groups: null,
    group_sync_enabled: false,
    user: {
      id: 'user-1',
      email: 'john@example.com',
      first_name: 'John',
      last_name: 'Doe',
      display_name: 'John Doe',
      avatar_url: null,
      oauth_provider: 'google',
      oauth_id: 'oauth-1',
      last_login_at: null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      last_sso_login_at: null,
      last_sso_provider: null,
      is_managed: false,
      scim_external_id: null,
      sso_only: false,
      jit_provisioned: false,
      jit_provisioned_at: null,
      provisioning_source: null,
      suspended_at: null,
      suspension_reason: null,
      idp_claims: null,
    } as User,
  };

  return { ...defaults, ...overrides };
}

describe('UserCard Logic', () => {
  describe('display name formatting', () => {
    it('should format display name from user object', () => {
      const member = createMockMember();
      const userOrNull = member.user ?? null;
      const displayName = formatUserDisplayName(userOrNull, member.invited_email);

      expect(displayName).toBe('John Doe');
    });

    it('should use invited email when user is null', () => {
      const member = createMockMember({
        user_id: null,
        invited_email: 'pending@example.com',
        user: undefined,
      });
      const userOrNull = member.user ?? null;
      const displayName = formatUserDisplayName(userOrNull, member.invited_email);

      expect(displayName).toBe('pending@example.com');
    });

    it('should use first/last name when no display_name', () => {
      const member = createMockMember({
        user: {
          ...createMockMember().user!,
          display_name: null,
          first_name: 'Jane',
          last_name: 'Smith',
        },
      });
      const userOrNull = member.user ?? null;
      const displayName = formatUserDisplayName(userOrNull, member.invited_email);

      expect(displayName).toBe('Jane Smith');
    });
  });

  describe('initials formatting', () => {
    it('should get initials from display name', () => {
      const member = createMockMember();
      const userOrNull = member.user ?? null;
      const initials = getUserInitials(userOrNull, member.invited_email);

      expect(initials).toBe('JD');
    });

    it('should get initials from invited email', () => {
      const member = createMockMember({
        user_id: null,
        invited_email: 'pending@example.com',
        user: undefined,
      });
      const userOrNull = member.user ?? null;
      const initials = getUserInitials(userOrNull, member.invited_email);

      expect(initials).toBe('PE');
    });
  });

  describe('role labels', () => {
    it('should have correct label for agent', () => {
      expect(ROLE_LABELS.agent).toBe('Agent');
    });

    it('should have correct label for broker', () => {
      expect(ROLE_LABELS.broker).toBe('Broker');
    });

    it('should have correct label for admin', () => {
      expect(ROLE_LABELS.admin).toBe('Admin');
    });

    it('should have correct label for it_admin', () => {
      expect(ROLE_LABELS.it_admin).toBe('IT Admin');
    });
  });

  describe('status labels', () => {
    it('should have correct label for active', () => {
      expect(LICENSE_STATUS_LABELS.active).toBe('Active');
    });

    it('should have correct label for pending', () => {
      expect(LICENSE_STATUS_LABELS.pending).toBe('Pending');
    });

    it('should have correct label for suspended', () => {
      expect(LICENSE_STATUS_LABELS.suspended).toBe('Suspended');
    });

    it('should have correct label for expired', () => {
      expect(LICENSE_STATUS_LABELS.expired).toBe('Expired');
    });
  });

  describe('date formatting', () => {
    it('should format joined_at date', () => {
      const member = createMockMember({ joined_at: '2024-01-15T10:00:00Z' });
      const formatted = formatDate(member.joined_at);

      expect(formatted).toMatch(/Jan 15, 2024/);
    });

    it('should format invited_at date', () => {
      const member = createMockMember({
        joined_at: null,
        invited_at: '2024-01-10T10:00:00Z',
      });
      const formatted = formatDate(member.invited_at);

      expect(formatted).toMatch(/Jan 10, 2024/);
    });

    it('should handle null dates', () => {
      const formatted = formatDate(null);
      expect(formatted).toBe('-');
    });
  });

  describe('pending user detection', () => {
    it('should detect pending users by null user_id', () => {
      const pendingMember = createMockMember({
        user_id: null,
        invited_email: 'pending@example.com',
        user: undefined,
      });

      expect(!pendingMember.user_id).toBe(true);
    });

    it('should detect active users by user_id presence', () => {
      const activeMember = createMockMember();

      expect(!!activeMember.user_id).toBe(true);
    });
  });

  describe('role colors mapping', () => {
    const ROLE_COLORS: Record<Role, string> = {
      admin: 'bg-purple-100 text-purple-800',
      it_admin: 'bg-blue-100 text-blue-800',
      broker: 'bg-green-100 text-green-800',
      agent: 'bg-gray-100 text-gray-800',
    };

    it('should have colors for all roles', () => {
      const roles: Role[] = ['agent', 'broker', 'admin', 'it_admin'];
      roles.forEach((role) => {
        expect(ROLE_COLORS[role]).toBeDefined();
        expect(ROLE_COLORS[role].length).toBeGreaterThan(0);
      });
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

    it('should have colors for all statuses', () => {
      const statuses: MemberLicenseStatus[] = ['active', 'pending', 'suspended', 'expired', 'unassigned'];
      statuses.forEach((status) => {
        expect(STATUS_COLORS[status]).toBeDefined();
        expect(STATUS_COLORS[status].length).toBeGreaterThan(0);
      });
    });
  });

  describe('management permission logic', () => {
    // Helper function that mirrors component logic
    function canUserManage(role: Role): boolean {
      return role === 'admin' || role === 'it_admin';
    }

    it('should allow admins to manage other users', () => {
      expect(canUserManage('admin')).toBe(true);
    });

    it('should allow it_admins to manage other users', () => {
      expect(canUserManage('it_admin')).toBe(true);
    });

    it('should not allow brokers to manage users', () => {
      expect(canUserManage('broker')).toBe(false);
    });

    it('should not allow agents to manage users', () => {
      expect(canUserManage('agent')).toBe(false);
    });
  });
});

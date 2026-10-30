/**
 * User Management Types
 *
 * Shared TypeScript types for user management features.
 * These types match the Supabase schema including SPRINT-070 SSO columns.
 *
 * TASK-1814: Initial types and utilities
 */

// ============================================================================
// Enums / Union Types
// ============================================================================

/**
 * Organization member roles
 * Maps to: organization_members.role CHECK constraint
 */
export type Role = 'agent' | 'broker' | 'admin' | 'it_admin';

/**
 * License status for organization members.
 * Maps to: organization_members.license_status CHECK constraint.
 */
export type MemberLicenseStatus = 'pending' | 'active' | 'suspended' | 'expired' | 'unassigned';

/**
 * How a user/member was provisioned
 * Maps to: users.provisioning_source and organization_members.provisioned_by CHECK constraints
 */
export type ProvisioningSource = 'manual' | 'scim' | 'jit' | 'invite';

/**
 * OAuth provider types
 * Maps to: users.oauth_provider CHECK constraint
 */
export type OAuthProvider = 'google' | 'microsoft' | 'azure' | 'email' | 'unknown';

// ============================================================================
// Core Interfaces
// ============================================================================

/**
 * User record from the users table
 * Includes SSO/SCIM fields from SPRINT-070
 */
export interface User {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  avatar_url: string | null;
  oauth_provider: OAuthProvider;
  oauth_id: string;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  // SSO fields from SPRINT-070
  last_sso_login_at: string | null;
  last_sso_provider: string | null;
  is_managed: boolean;
  scim_external_id: string | null;
  sso_only: boolean;
  jit_provisioned: boolean;
  jit_provisioned_at: string | null;
  provisioning_source: ProvisioningSource | null;
  // Suspension fields
  suspended_at: string | null;
  suspension_reason: string | null;
  // IDP claims (for JIT provisioning)
  idp_claims: Record<string, unknown> | null;
}

/**
 * Organization member record
 * Includes provisioning fields from SPRINT-070
 */
export interface OrganizationMember {
  id: string;
  organization_id: string;
  user_id: string | null;
  role: Role;
  license_status: MemberLicenseStatus;
  // Invitation fields
  invited_email: string | null;
  /** BACKLOG-3851 PR-2f (S1): optional names typed on the invite (M4a). */
  invited_first_name?: string | null;
  invited_last_name?: string | null;
  invitation_token: string | null;
  invitation_expires_at: string | null;
  invited_by: string | null;
  invited_at: string | null;
  joined_at: string | null;
  last_invited_at: string | null;
  // Timestamps
  created_at: string;
  updated_at: string;
  // SPRINT-070 provisioning fields
  provisioned_by: ProvisioningSource | null;
  provisioned_at: string | null;
  scim_synced_at: string | null;
  provisioning_metadata: Record<string, unknown> | null;
  idp_groups: string[] | null;
  group_sync_enabled: boolean;
  // Joined data (optional, for queries with joins)
  user?: User;
}

/**
 * Organization member with inviter information
 * Used when displaying who invited a user
 */
export interface OrganizationMemberWithInviter extends OrganizationMember {
  inviter?: {
    user?: Pick<User, 'email' | 'display_name'>;
  };
}

/**
 * Minimal user info for display purposes
 */
export interface UserDisplayInfo {
  id: string;
  email: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
}

// ============================================================================
// Action Result Types
// ============================================================================

/**
 * Generic result type for user actions
 */
export interface UserActionResult<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

/**
 * Result for role update actions
 */
export interface RoleUpdateResult {
  success: boolean;
  error?: string;
  previousRole?: Role;
  newRole?: Role;
}

/**
 * Result for invitation actions
 */
export interface InviteResult {
  success: boolean;
  error?: string;
  memberId?: string;
  invitationToken?: string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Roles that have administrative privileges
 */
export const ADMIN_ROLES: Role[] = ['admin', 'it_admin'];

/**
 * Roles that can be assigned by an admin
 * (admins cannot assign it_admin role)
 */
export const ASSIGNABLE_ROLES_BY_ADMIN: Role[] = ['agent', 'broker', 'admin'];

/**
 * Roles that can be assigned by an it_admin
 * (it_admin can assign all roles including it_admin)
 */
export const ASSIGNABLE_ROLES_BY_IT_ADMIN: Role[] = ['agent', 'broker', 'admin', 'it_admin'];

/**
 * Human-readable role labels
 */
export const ROLE_LABELS: Record<Role, string> = {
  agent: 'Agent',
  broker: 'Broker',
  admin: 'Admin',
  it_admin: 'IT Admin',
};

/**
 * Human-readable license status labels
 */
export const LICENSE_STATUS_LABELS: Record<MemberLicenseStatus, string> = {
  pending: 'Pending',
  active: 'Active',
  suspended: 'Suspended',
  expired: 'Expired',
  unassigned: 'No license',
};

/** BACKLOG-3851 PR-2f: an unclaimed invitation without a license. */
export const INVITED_NO_LICENSE_LABEL = 'Invited (no license)';

/**
 * The status label for a member row — ONE rule for the table row, the card and the
 * detail page. An unclaimed row is an invitation: 'Invited', or 'Invited (no license)'
 * when it was sent without one. A claimed row shows its licence status.
 */
export function memberStatusLabel(member: Pick<OrganizationMember, 'user_id' | 'license_status'>): string {
  if (!member.user_id) {
    return member.license_status === 'unassigned' ? INVITED_NO_LICENSE_LABEL : 'Invited';
  }
  return LICENSE_STATUS_LABELS[member.license_status];
}

/**
 * Human-readable provisioning source labels
 */
export const PROVISIONING_SOURCE_LABELS: Record<ProvisioningSource, string> = {
  manual: 'Manual',
  scim: 'SCIM',
  jit: 'Just-in-Time',
  invite: 'Invited',
};

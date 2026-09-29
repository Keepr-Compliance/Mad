/**
 * The Users list projection ships only rendered fields — BACKLOG-3541.
 *
 * `getOrganizationMembers()` used to spread the full fetched row straight
 * into a 'use client' component's props, so every column the SELECT named
 * serialized into the RSC payload regardless of whether anything rendered
 * it. `invitation_token` in particular is a working invite-acceptance URL
 * (UserActionsDropdown.tsx builds `${origin}/invite/${token}`), so it
 * shipped a live credential to every viewer who could load the list.
 *
 * The most likely wrong implementation of a later "fix" is a convenience
 * field, or a `select *`, or a `{ ...row }` spread, sneaking back into the
 * function that builds the client payload. This file imports the REAL
 * `projectListMember` and feeds it a row carrying every column the old wide
 * SELECT named (transcribed from the pre-fix `users/page.tsx`, not
 * invented), so a reintroduced field shows up as an unexpected key rather
 * than requiring a test author to remember to name it.
 */

import {
  projectListMember,
  type RawListMemberRow,
} from '@/lib/queries/userQueries';

/**
 * Every column the pre-BACKLOG-3541 SELECT in users/page.tsx named, on both
 * organization_members and the joined users row. Transcribed from the
 * original `getOrganizationMembers()` query, not shortened.
 */
const WIDE_ROW = {
  id: 'member-1',
  organization_id: 'org-1',
  user_id: 'user-1',
  role: 'agent',
  license_status: 'active',
  invited_email: 'invited@example.com',
  invitation_token: 'super-secret-invite-token',
  invitation_expires_at: '2024-02-01T00:00:00Z',
  invited_by: 'member-inviter',
  invited_at: '2024-01-10T00:00:00Z',
  joined_at: '2024-01-15T00:00:00Z',
  last_invited_at: '2024-01-12T00:00:00Z',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-20T00:00:00Z',
  provisioned_by: 'invite',
  provisioned_at: '2024-01-11T00:00:00Z',
  scim_synced_at: '2024-01-13T00:00:00Z',
  provisioning_metadata: { raw: 'scim-blob' },
  idp_groups: ['Engineering'],
  group_sync_enabled: true,
  user: {
    id: 'user-1',
    email: 'john@example.com',
    first_name: 'John',
    last_name: 'Doe',
    display_name: 'John Doe',
    avatar_url: 'https://example.com/avatar.png',
    oauth_provider: 'google',
    oauth_id: 'oauth-123',
    last_login_at: '2024-01-20T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-20T00:00:00Z',
    last_sso_login_at: '2024-01-19T00:00:00Z',
    last_sso_provider: 'azure',
    is_managed: true,
    scim_external_id: 'scim-ext-1',
    sso_only: true,
    jit_provisioned: true,
    jit_provisioned_at: '2024-01-05T00:00:00Z',
    provisioning_source: 'scim',
    suspended_at: null,
    suspension_reason: null,
    idp_claims: { groups: ['eng'] },
  },
} as unknown as RawListMemberRow;

const ALLOWED_TOP_LEVEL_KEYS = [
  'id',
  'user_id',
  'role',
  'license_status',
  'invited_email',
  'invited_at',
  'joined_at',
  'created_at',
  'user',
].sort();

const ALLOWED_USER_KEYS = [
  'email',
  'first_name',
  'last_name',
  'display_name',
  'avatar_url',
].sort();

describe('projectListMember', () => {
  it('emits exactly the allowed top-level keys', () => {
    const result = projectListMember(WIDE_ROW);
    expect(Object.keys(result).sort()).toEqual(ALLOWED_TOP_LEVEL_KEYS);
  });

  it('emits exactly the allowed nested user keys', () => {
    const result = projectListMember(WIDE_ROW);
    expect(Object.keys(result.user!).sort()).toEqual(ALLOWED_USER_KEYS);
  });

  it('never carries the invitation token, even though the row has one', () => {
    const result = projectListMember(WIDE_ROW);
    expect(result).not.toHaveProperty('invitation_token');
    expect(JSON.stringify(result)).not.toContain('super-secret-invite-token');
  });

  it('drops the other fields nothing in the list renders', () => {
    const result = projectListMember(WIDE_ROW);
    for (const key of [
      'organization_id',
      'invitation_expires_at',
      'invited_by',
      'last_invited_at',
      'updated_at',
      'provisioned_by',
      'provisioned_at',
      'scim_synced_at',
      'provisioning_metadata',
      'idp_groups',
      'group_sync_enabled',
    ]) {
      expect(result).not.toHaveProperty(key);
    }
    for (const key of [
      'id',
      'oauth_provider',
      'oauth_id',
      'last_login_at',
      'created_at',
      'updated_at',
      'last_sso_login_at',
      'last_sso_provider',
      'is_managed',
      'scim_external_id',
      'sso_only',
      'jit_provisioned',
      'jit_provisioned_at',
      'provisioning_source',
      'suspended_at',
      'suspension_reason',
      'idp_claims',
    ]) {
      expect(result.user).not.toHaveProperty(key);
    }
  });

  it('keeps every field the list client components read, with real values', () => {
    const result = projectListMember(WIDE_ROW);
    expect(result).toMatchObject({
      id: 'member-1',
      user_id: 'user-1',
      role: 'agent',
      license_status: 'active',
      invited_email: 'invited@example.com',
      invited_at: '2024-01-10T00:00:00Z',
      joined_at: '2024-01-15T00:00:00Z',
      created_at: '2024-01-01T00:00:00Z',
      user: {
        email: 'john@example.com',
        first_name: 'John',
        last_name: 'Doe',
        display_name: 'John Doe',
        avatar_url: 'https://example.com/avatar.png',
      },
    });
  });

  it('handles a Supabase join returning `user` as an array', () => {
    const arrayRow = { ...WIDE_ROW, user: [WIDE_ROW.user] } as unknown as RawListMemberRow;
    const result = projectListMember(arrayRow);
    expect(result.user?.email).toBe('john@example.com');
  });

  it('handles a pending invite with no joined user', () => {
    const pendingRow = { ...WIDE_ROW, user_id: null, user: null } as unknown as RawListMemberRow;
    const result = projectListMember(pendingRow);
    expect(result.user).toBeUndefined();
    expect(result.user_id).toBeNull();
  });
});

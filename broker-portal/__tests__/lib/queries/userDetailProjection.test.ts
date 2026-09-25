/**
 * The user-detail projection ships only rendered fields — BACKLOG-3541.
 *
 * `getUserDetails()` used to build the client-facing member with
 * `{ ...member, user: userData, inviter: inviterData }`. That spread leaked
 * every selected column, including `invited_by` — needed server-side only,
 * to look up the inviter — and `last_invited_at`, `updated_at`,
 * `provisioning_metadata`, none of which `UserDetailsCard.tsx` renders.
 *
 * The regression this file exists to catch is exactly that spread coming
 * back: `invited_by` must reach the projection (the caller needs it to
 * decide whether to look up an inviter) but must never appear on what the
 * projection returns.
 */

import {
  projectDetailMember,
  type RawDetailMemberRow,
} from '@/lib/queries/userQueries';

/**
 * Every column the pre-BACKLOG-3541 SELECT in users/[id]/page.tsx named, on
 * both organization_members and the joined users row. Transcribed from the
 * original `getUserDetails()` query, not shortened.
 */
const WIDE_ROW = {
  id: 'member-1',
  user_id: 'user-1',
  role: 'agent',
  license_status: 'active',
  invited_email: 'invited@example.com',
  invited_at: '2024-01-10T00:00:00Z',
  joined_at: '2024-01-15T00:00:00Z',
  provisioned_by: 'invite',
  provisioned_at: '2024-01-11T00:00:00Z',
  scim_synced_at: '2024-01-13T00:00:00Z',
  provisioning_metadata: { raw: 'scim-blob' },
  idp_groups: ['Engineering'],
  invited_by: 'member-inviter-id',
  last_invited_at: '2024-01-12T00:00:00Z',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-20T00:00:00Z',
  user: {
    id: 'user-1',
    email: 'john@example.com',
    first_name: 'John',
    last_name: 'Doe',
    display_name: 'John Doe',
    avatar_url: 'https://example.com/avatar.png',
    last_login_at: '2024-01-20T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
    last_sso_login_at: '2024-01-19T00:00:00Z',
    last_sso_provider: 'azure',
    is_managed: true,
  },
} as unknown as RawDetailMemberRow;

const INVITER = {
  user: {
    email: 'admin@example.com',
    display_name: 'Admin User',
  },
};

const ALLOWED_TOP_LEVEL_KEYS = [
  'id',
  'user_id',
  'role',
  'license_status',
  'invited_email',
  'invited_at',
  'joined_at',
  'provisioned_by',
  'provisioned_at',
  'scim_synced_at',
  'idp_groups',
  'created_at',
  'user',
  'inviter',
].sort();

const ALLOWED_USER_KEYS = [
  'email',
  'first_name',
  'last_name',
  'display_name',
  'avatar_url',
  'last_login_at',
  'last_sso_login_at',
  'last_sso_provider',
  'is_managed',
].sort();

describe('projectDetailMember', () => {
  it('emits exactly the allowed top-level keys', () => {
    const result = projectDetailMember(WIDE_ROW, INVITER);
    expect(Object.keys(result).sort()).toEqual(ALLOWED_TOP_LEVEL_KEYS);
  });

  it('emits exactly the allowed nested user keys', () => {
    const result = projectDetailMember(WIDE_ROW, INVITER);
    expect(Object.keys(result.user!).sort()).toEqual(ALLOWED_USER_KEYS);
  });

  // The regression this whole file exists to catch: invited_by is on the raw
  // row (the caller needs it to decide whether to look up an inviter), but
  // must never appear on what the projection hands the client.
  it('never carries invited_by, even though the row has one', () => {
    const result = projectDetailMember(WIDE_ROW, INVITER);
    expect(result).not.toHaveProperty('invited_by');
    expect(JSON.stringify(result)).not.toContain('member-inviter-id');
  });

  it('drops the other fields UserDetailsCard never renders', () => {
    const result = projectDetailMember(WIDE_ROW, INVITER);
    for (const key of ['provisioning_metadata', 'last_invited_at', 'updated_at']) {
      expect(result).not.toHaveProperty(key);
    }
    expect(result.user).not.toHaveProperty('id');
    expect(result.user).not.toHaveProperty('created_at');
  });

  it('keeps every field UserDetailsCard reads, with real values, and carries the resolved inviter through untouched', () => {
    const result = projectDetailMember(WIDE_ROW, INVITER);
    expect(result).toMatchObject({
      id: 'member-1',
      user_id: 'user-1',
      role: 'agent',
      license_status: 'active',
      invited_email: 'invited@example.com',
      invited_at: '2024-01-10T00:00:00Z',
      joined_at: '2024-01-15T00:00:00Z',
      provisioned_by: 'invite',
      provisioned_at: '2024-01-11T00:00:00Z',
      scim_synced_at: '2024-01-13T00:00:00Z',
      idp_groups: ['Engineering'],
      created_at: '2024-01-01T00:00:00Z',
      inviter: INVITER,
      user: {
        email: 'john@example.com',
        first_name: 'John',
        last_name: 'Doe',
        display_name: 'John Doe',
        avatar_url: 'https://example.com/avatar.png',
        last_login_at: '2024-01-20T00:00:00Z',
        last_sso_login_at: '2024-01-19T00:00:00Z',
        last_sso_provider: 'azure',
        is_managed: true,
      },
    });
  });

  it('handles a Supabase join returning `user` as an array', () => {
    const arrayRow = { ...WIDE_ROW, user: [WIDE_ROW.user] } as unknown as RawDetailMemberRow;
    const result = projectDetailMember(arrayRow);
    expect(result.user?.email).toBe('john@example.com');
  });

  it('handles a pending invite with no inviter resolved and no joined user', () => {
    const pendingRow = {
      ...WIDE_ROW,
      user_id: null,
      user: null,
      invited_by: null,
    } as unknown as RawDetailMemberRow;
    const result = projectDetailMember(pendingRow, undefined);
    expect(result.user).toBeUndefined();
    expect(result.inviter).toBeUndefined();
  });
});

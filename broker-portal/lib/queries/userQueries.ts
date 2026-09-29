/**
 * SELECTs and payload projections for the Users list and detail pages
 * — BACKLOG-3541.
 *
 * Both pages used to spread the full fetched row (`{...member, user: ... }`)
 * straight into a `'use client'` component's props, so every column the
 * SELECT named — rendered or not — serialized into the RSC payload every
 * viewer's browser received. `invitation_token` in particular is a working
 * invite-acceptance URL (`UserActionsDropdown.tsx` builds
 * `${origin}/invite/${token}`), so it shipped a live credential to every
 * viewer who could load the list, whether or not they could click anything.
 *
 * Fix: SELECT only the columns each page renders, and project each row
 * through an explicit field-by-field function before it reaches a client
 * prop — never a spread. A column later added back to a SELECT without a
 * matching line in its projection function stays server-side instead of
 * silently reaching the client.
 */

import type { MemberLicenseStatus, ProvisioningSource, Role } from '@/lib/types/users';

// ---------------------------------------------------------------------------
// List page (users/page.tsx)
// ---------------------------------------------------------------------------

export const USER_LIST_SELECT = `
  id,
  user_id,
  role,
  license_status,
  invited_email,
  invited_at,
  joined_at,
  created_at,
  user:users!organization_members_user_id_public_users_fkey (
    email,
    first_name,
    last_name,
    display_name,
    avatar_url
  )
`;

export interface ListMemberUser {
  email: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

/** The exact shape the Users list client components read. */
export interface ListMember {
  id: string;
  user_id: string | null;
  role: Role;
  license_status: MemberLicenseStatus;
  invited_email: string | null;
  invited_at: string | null;
  joined_at: string | null;
  created_at: string;
  user?: ListMemberUser;
}

/**
 * The row shape `USER_LIST_SELECT` returns. Deliberately permissive on the
 * joined `user` field (Supabase returns an array for some join shapes) —
 * this is the SERVER-SIDE row, not the client payload.
 */
export interface RawListMemberRow {
  id: string;
  user_id: string | null;
  role: Role;
  license_status: MemberLicenseStatus;
  invited_email: string | null;
  invited_at: string | null;
  joined_at: string | null;
  created_at: string;
  user?: ListMemberUser | ListMemberUser[] | null;
}

/**
 * Project a raw organization_members row (+ joined user) into exactly the
 * fields the Users list client components read. Field-by-field, never a
 * spread of `row` — a column reappearing on the row without a matching line
 * here stays out of the client payload instead of leaking by default.
 */
export function projectListMember(row: RawListMemberRow): ListMember {
  const user = Array.isArray(row.user) ? row.user[0] : row.user;
  return {
    id: row.id,
    user_id: row.user_id,
    role: row.role,
    license_status: row.license_status,
    invited_email: row.invited_email,
    invited_at: row.invited_at,
    joined_at: row.joined_at,
    created_at: row.created_at,
    user: user
      ? {
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          display_name: user.display_name,
          avatar_url: user.avatar_url,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Detail page (users/[id]/page.tsx)
// ---------------------------------------------------------------------------

export const USER_DETAIL_SELECT = `
  id,
  user_id,
  role,
  license_status,
  invited_email,
  invited_at,
  joined_at,
  provisioned_by,
  provisioned_at,
  scim_synced_at,
  idp_groups,
  invited_by,
  created_at,
  user:users!organization_members_user_id_public_users_fkey (
    email,
    first_name,
    last_name,
    display_name,
    avatar_url,
    last_login_at,
    last_sso_login_at,
    last_sso_provider,
    is_managed
  )
`;

export interface DetailMemberUser {
  email: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  avatar_url: string | null;
  last_login_at: string | null;
  last_sso_login_at: string | null;
  last_sso_provider: string | null;
  is_managed: boolean;
}

export interface DetailMemberInviter {
  user?: {
    email: string;
    display_name: string | null;
  };
}

/** The exact shape `UserDetailsCard.tsx` reads. */
export interface DetailMember {
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
  idp_groups: string[] | null;
  created_at: string;
  user?: DetailMemberUser;
  inviter?: DetailMemberInviter;
}

/**
 * The row shape `USER_DETAIL_SELECT` returns. `invited_by` is selected only
 * to drive the separate inviter lookup server-side — `projectDetailMember`
 * below never copies it into the returned `DetailMember`.
 */
export interface RawDetailMemberRow {
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
  idp_groups: string[] | null;
  invited_by: string | null;
  created_at: string;
  user?: DetailMemberUser | DetailMemberUser[] | null;
}

/**
 * Project a raw organization_members row (+ resolved inviter) into exactly
 * the fields `UserDetailsCard.tsx` reads. Field-by-field, never a spread of
 * `row` — `row.invited_by` in particular is used by the caller to look up
 * `inviter` but must never itself reach the client.
 */
export function projectDetailMember(
  row: RawDetailMemberRow,
  inviter?: DetailMemberInviter
): DetailMember {
  const user = Array.isArray(row.user) ? row.user[0] : row.user;
  return {
    id: row.id,
    user_id: row.user_id,
    role: row.role,
    license_status: row.license_status,
    invited_email: row.invited_email,
    invited_at: row.invited_at,
    joined_at: row.joined_at,
    provisioned_by: row.provisioned_by,
    provisioned_at: row.provisioned_at,
    scim_synced_at: row.scim_synced_at,
    idp_groups: row.idp_groups,
    created_at: row.created_at,
    user: user
      ? {
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          display_name: user.display_name,
          avatar_url: user.avatar_url,
          last_login_at: user.last_login_at,
          last_sso_login_at: user.last_sso_login_at,
          last_sso_provider: user.last_sso_provider,
          is_managed: user.is_managed,
        }
      : undefined,
    inviter,
  };
}

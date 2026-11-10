/**
 * BACKLOG-3976: the admin-portal role-change action. The permission, last-admin, identity-provider
 * and audit rules are enforced in the database (supabase/tests/backlog-3976 tests those); this
 * suite checks the action calls the RPC with the right arguments and words every refusal.
 * RPC shapes are transcribed from admin_update_org_member_role on keepr-test
 * (supabase/tests/backlog-3976/results-2026-11-09.txt).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ rpc }) }));

import { changeMemberRole } from '../changeMemberRole';
import { LAST_ADMIN_DEMOTE_REFUSED, ROLE_MANAGED_BY_IDP } from '../changeMemberRole.helpers';

const INPUT = { organizationId: 'org-1', userId: 'user-2', role: 'broker' as const };

beforeEach(() => rpc.mockReset());

describe('changeMemberRole', () => {
  it('calls admin_update_org_member_role and returns the old and new role', async () => {
    rpc.mockResolvedValue({ data: { success: true, old_role: 'agent', new_role: 'broker' }, error: null });
    const r = await changeMemberRole(INPUT);
    expect(rpc).toHaveBeenCalledWith('admin_update_org_member_role', {
      p_organization_id: 'org-1',
      p_user_id: 'user-2',
      p_role: 'broker',
    });
    expect(r).toEqual({ success: true, oldRole: 'agent', newRole: 'broker' });
  });

  it('words the server refusal for staff without users.edit', async () => {
    rpc.mockResolvedValue({ data: { success: false, error: 'insufficient_permissions' }, error: null });
    expect(await changeMemberRole(INPUT)).toEqual({ success: false, error: 'Not authorized to change roles' });
  });

  it("words the last-admin trigger's refusal", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'last_admin', code: 'P0001' } });
    expect(await changeMemberRole(INPUT)).toEqual({ success: false, error: LAST_ADMIN_DEMOTE_REFUSED });
  });

  it("words the identity provider trigger's refusal", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'managed_by_idp', code: '42501' } });
    expect(await changeMemberRole(INPUT)).toEqual({ success: false, error: ROLE_MANAGED_BY_IDP });
  });

  it('words a target outside the organization', async () => {
    rpc.mockResolvedValue({ data: { success: false, error: 'not_a_member' }, error: null });
    expect(await changeMemberRole(INPUT)).toEqual({
      success: false,
      error: 'This user is not a member of this organization',
    });
  });

  it('does not call the RPC with an unknown role', async () => {
    const r = await changeMemberRole({ ...INPUT, role: 'owner' as unknown as 'agent' });
    expect(rpc).not.toHaveBeenCalled();
    expect(r).toEqual({ success: false, error: 'Invalid role' });
  });
});

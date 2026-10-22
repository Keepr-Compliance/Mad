/**
 * BACKLOG-4007 PR-2: the org-invite server action sends no p_license_status, so
 * admin_invite_user's own default applies (the license comes from the brokerage's deal).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'staff-1', email: 'staff@example.test', user_metadata: {} } } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: { success: true, invitation_token: 'tok', org_name: 'Org A' }, error: null };
    },
  }),
}));

beforeEach(() => {
  rpcCalls.length = 0;
  delete process.env.BROKER_PORTAL_URL;
  delete process.env.INTERNAL_API_SECRET;
});

describe('inviteUser (org path)', () => {
  it('calls admin_invite_user without p_license_status', async () => {
    const { inviteUser } = await import('@/lib/actions/inviteUser');
    const res = await inviteUser({ email: 'a@example.test', firstName: 'A', lastName: 'B', role: 'admin', organizationId: 'org-a', planId: null });
    expect(res.success).toBe(true);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('admin_invite_user');
    expect(Object.keys(rpcCalls[0].args).sort()).toEqual(['p_email', 'p_invited_by', 'p_organization_id', 'p_plan_id', 'p_role']);
    expect(rpcCalls[0].args.p_organization_id).toBe('org-a');
    expect(rpcCalls[0].args.p_role).toBe('admin');
  });
});

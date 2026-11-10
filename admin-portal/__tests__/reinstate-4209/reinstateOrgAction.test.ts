/**
 * BACKLOG-4209 A-re4: reinstateOrgAction sends p_notify to admin_reinstate_org.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ getAuthenticatedUser: async () => ({ user: { id: 'staff-1' }, supabase: { rpc } }) }));

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { success: true }, error: null });
});

describe('reinstateOrgAction', () => {
  it('A-re4: notify false reaches the rpc as p_notify false', async () => {
    const { reinstateOrgAction } = await import('@/lib/actions/brokerageBilling');
    await reinstateOrgAction('org-1', ' paid ', false);
    expect(rpc).toHaveBeenCalledWith('admin_reinstate_org', { p_org: 'org-1', p_note: 'paid', p_notify: false });
  });

  it('A-re4b: notify defaults to true', async () => {
    const { reinstateOrgAction } = await import('@/lib/actions/brokerageBilling');
    await reinstateOrgAction('org-1', 'paid');
    expect(rpc).toHaveBeenCalledWith('admin_reinstate_org', { p_org: 'org-1', p_note: 'paid', p_notify: true });
  });
});

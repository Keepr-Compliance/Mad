/**
 * BACKLOG-4045 follow-up A3: setAutoRenewAction sends p_notify to set_org_auto_renew.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ getAuthenticatedUser: async () => ({ user: { id: 'staff-1' }, supabase: { rpc } }) }));

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { success: true, changed: true, version: 4 }, error: null });
});

describe('setAutoRenewAction', () => {
  it('A3: notify false reaches the rpc as p_notify false', async () => {
    const { setAutoRenewAction } = await import('@/lib/actions/brokerageBilling');
    await setAutoRenewAction('org-1', true, ' note ', 3, false);
    expect(rpc).toHaveBeenCalledWith('set_org_auto_renew', { p_org: 'org-1', p_on: true, p_note: 'note', p_expected_version: 3, p_notify: false });
  });

  it('A3b: notify defaults to true', async () => {
    const { setAutoRenewAction } = await import('@/lib/actions/brokerageBilling');
    await setAutoRenewAction('org-1', true, 'note', 3);
    expect(rpc).toHaveBeenCalledWith('set_org_auto_renew', { p_org: 'org-1', p_on: true, p_note: 'note', p_expected_version: 3, p_notify: true });
  });
});

/**
 * BACKLOG-3860 PR-3 — setSoloTrialAction (controls a, c, d).
 * The discriminator is the number of admin_set_solo_trial_setting calls, not only the return value.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const state: { canEdit: boolean; user: { id: string } | null; setReply: { data: unknown; error: unknown } } = {
  canEdit: true, user: { id: 'u1' }, setReply: { data: { enabled: true, days: 14 }, error: null },
};

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    user: state.user,
    supabase: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        if (fn === 'has_permission') {
          return { data: args.required_permission === 'billing.pricebook' ? state.canEdit : false, error: null };
        }
        if (fn === 'admin_set_solo_trial_setting') return state.setReply;
        return { data: null, error: { code: 'XX000', message: 'unexpected rpc ' + fn } };
      },
    },
  }),
}));

const writes = () => calls.filter((c) => c.fn === 'admin_set_solo_trial_setting');

describe('setSoloTrialAction', () => {
  beforeEach(() => {
    calls.length = 0;
    state.canEdit = true;
    state.user = { id: 'u1' };
    state.setReply = { data: { enabled: true, days: 14 }, error: null };
  });

  it('(a) refuses a caller without billing.pricebook and makes no write', async () => {
    state.canEdit = false;
    const { setSoloTrialAction } = await import('@/lib/actions/trialSetting');
    const res = await setSoloTrialAction(true, '14');
    expect(res).toEqual({ ok: false, error: 'Only a Super Admin can change the free trial.' });
    expect(writes()).toHaveLength(0);
    expect(calls.find((c) => c.fn === 'has_permission')?.args).toEqual({ check_user_id: 'u1', required_permission: 'billing.pricebook' });
  });

  it('(a) refuses a signed-out caller and makes no call', async () => {
    state.user = null;
    const { setSoloTrialAction } = await import('@/lib/actions/trialSetting');
    expect((await setSoloTrialAction(true, '14')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('(a)(d) a Super Admin write is exactly one database call with the typed values, and no separate audit write', async () => {
    const { setSoloTrialAction } = await import('@/lib/actions/trialSetting');
    const res = await setSoloTrialAction(true, '14');
    expect(res).toEqual({ ok: true, error: null });
    expect(calls.map((c) => c.fn)).toEqual(['has_permission', 'admin_set_solo_trial_setting']);
    expect(writes()[0].args).toEqual({ p_enabled: true, p_days: 14 });
  });

  it.each(['0', '91', '', '-1', '14.5', 'abc'])('(c) refuses days %j before any call', async (days) => {
    const { setSoloTrialAction } = await import('@/lib/actions/trialSetting');
    const res = await setSoloTrialAction(true, days);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Enter a whole number of days from 1 to 90.');
    expect(calls).toHaveLength(0);
  });

  it.each([['1', 1], ['90', 90]] as const)('(c) accepts days %s', async (days, n) => {
    const { setSoloTrialAction } = await import('@/lib/actions/trialSetting');
    expect((await setSoloTrialAction(false, days)).ok).toBe(true);
    expect(writes()[0].args).toEqual({ p_enabled: false, p_days: n });
  });

  it('refuses an on/off value that is not a boolean, before any call', async () => {
    const { setSoloTrialAction } = await import('@/lib/actions/trialSetting');
    expect((await setSoloTrialAction('true' as unknown as boolean, '14')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['42501', 'Only a Super Admin can change the free trial.'],
    ['22023', 'Enter a whole number of days from 1 to 90.'],
    ['P0002', 'The free trial setting is missing from the database. Nothing was changed.'],
    ['XX000', 'The free trial setting could not be saved. Nothing was changed.'],
  ])('maps a database refusal %s to plain words', async (code, message) => {
    state.setReply = { data: null, error: { code, message: 'raw' } };
    const { setSoloTrialAction } = await import('@/lib/actions/trialSetting');
    expect(await setSoloTrialAction(true, '14')).toEqual({ ok: false, error: message });
  });
});

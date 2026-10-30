/**
 * BACKLOG-3852 (c) / C7: the start date is at most 365 days after the business date,
 * in the form rule (checkStartDate) and in the save action (saveDealAction).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkStartDate, latestStartDate, dealErrorMessage } from '@/lib/billing/dealRules';
import { WAITING } from '../onboarding-4007/fixtures';

describe('checkStartDate cap', () => {
  it.each([
    ['2026-10-19', '2027-10-19', null],               // +365
    ['2026-10-19', '2027-10-18', null],               // +364
    ['2026-10-19', '2027-10-20', 'start_date_too_far'], // +366
    ['2028-03-01', '2029-03-01', null],               // +365 across a year with Feb 29 (2028)
    ['2028-03-01', '2029-03-02', 'start_date_too_far'],
    ['2027-03-01', '2028-02-29', null],               // +365 landing on a leap day
    ['2027-03-01', '2028-03-01', 'start_date_too_far'],
  ])('business date %s, start %s -> %s', (today, value, want) => {
    expect(checkStartDate(value, today, null)).toBe(want);
  });
  it('an unchanged existing date far ahead is not re-checked; a changed one is', () => {
    expect(checkStartDate('2030-01-01', '2026-10-19', '2030-01-01')).toBeNull();
    expect(checkStartDate('2030-01-02', '2026-10-19', '2030-01-01')).toBe('start_date_too_far');
  });
  it('latestStartDate is +365 days; has its own sentence', () => {
    expect(latestStartDate('2026-10-19')).toBe('2027-10-19');
    expect(dealErrorMessage('start_date_too_far')).not.toBe('Something went wrong. Nothing was saved.');
  });
});

const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let billing: unknown = WAITING;
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    user: { id: 'u1' },
    supabase: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return fn === 'admin_get_org_billing' ? { data: billing, error: null } : { data: { success: true, version: 1 }, error: null };
      },
    },
  }),
}));

const INPUT = {
  organizationId: '00000000-0000-0000-0000-000000000000', seats: 5, unitPriceCents: 2499, accountManagerId: null,
  reason: 'Deal created', expectedVersion: null, startDate: null as string | null,
};

describe('saveDealAction start date cap (server side)', () => {
  beforeEach(() => { calls.length = 0; billing = WAITING; process.env.STRIPE_MODE = 'test'; });
  const run = async (startDate: string | null) => {
    const { saveDealAction } = await import('@/lib/actions/brokerageBilling');
    return saveDealAction({ ...INPUT, startDate });
  };

  it('refuses 366 days out and never calls admin_save_deal', async () => {
    const res = await run('2027-10-20'); // WAITING.business_date 2026-10-19 + 366
    expect(res).toEqual({ ok: false, error: dealErrorMessage('start_date_too_far') });
    expect(calls.map((c) => c.fn)).toEqual(['admin_get_org_billing']);
  });
  it('allows exactly 365 days out', async () => {
    const res = await run('2027-10-19');
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.fn)).toEqual(['admin_get_org_billing', 'admin_save_deal']);
    expect(calls[1].args.p_start_date).toBe('2027-10-19');
  });
  it('an unchanged existing far date still saves', async () => {
    billing = { ...WAITING, deal: { ...WAITING.deal!, start_date: '2030-01-01' } };
    expect((await run('2030-01-01')).ok).toBe(true);
  });
  it('startDate null (kept): no extra read, saves', async () => {
    expect((await run(null)).ok).toBe(true);
    expect(calls.map((c) => c.fn)).toEqual(['admin_save_deal']);
  });
  it('a failed business-date read saves nothing', async () => {
    billing = null;
    const res = await run('2026-10-25');
    expect(res.ok).toBe(false);
    expect(calls.map((c) => c.fn)).toEqual(['admin_get_org_billing']);
  });
});

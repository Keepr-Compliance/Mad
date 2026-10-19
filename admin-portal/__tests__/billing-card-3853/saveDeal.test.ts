/**
 * BACKLOG-3853 PR-2A — the save action takes the Stripe mode from this deployment
 * (STRIPE_MODE, strict like broker-portal/lib/billing/mode.ts) and refuses to save without
 * it; the price readout mirrors admin_save_deal's cap rule at the list-price boundary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: unknown } = { data: { success: true, version: 1 }, error: null };

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    user: { id: 'u1' },
    supabase: { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return rpcResult; } },
  }),
}));

const INPUT = {
  organizationId: 'o1', seats: 5, unitPriceCents: 2000, billingContactName: 'B', billingContactEmail: 'b@example.test',
  accountManagerId: null, reason: 'signed', expectedVersion: null,
};

describe('saveDealAction mode (BACKLOG-3853 PR-2A)', () => {
  const saved = process.env.STRIPE_MODE;
  beforeEach(() => { calls.length = 0; rpcResult = { data: { success: true, version: 1 }, error: null }; });
  afterEach(() => { if (saved === undefined) delete process.env.STRIPE_MODE; else process.env.STRIPE_MODE = saved; });

  it('refuses to save, and calls nothing, when STRIPE_MODE is missing', async () => {
    delete process.env.STRIPE_MODE;
    const { saveDealAction } = await import('@/lib/actions/brokerageBilling');
    const res = await saveDealAction(INPUT);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/STRIPE_MODE/);
    expect(calls).toHaveLength(0);
  });

  it('refuses an unrecognised value instead of guessing', async () => {
    process.env.STRIPE_MODE = 'sk_test_x';
    const { saveDealAction } = await import('@/lib/actions/brokerageBilling');
    const res = await saveDealAction(INPUT);
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each(['test', 'live'] as const)('passes STRIPE_MODE=%s to admin_save_deal', async (mode) => {
    process.env.STRIPE_MODE = mode;
    const { saveDealAction } = await import('@/lib/actions/brokerageBilling');
    const res = await saveDealAction(INPUT);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('admin_save_deal');
    expect(calls[0].args.p_stripe_mode).toBe(mode);
    expect(calls[0].args.p_reason).toBe('signed');
  });

  it('turns the database cap refusal into a sentence', async () => {
    process.env.STRIPE_MODE = 'test';
    rpcResult = { data: { success: false, error: 'discount_needs_approval', pct_off: 20.01, cap_pct: 20 }, error: null };
    const { saveDealAction } = await import('@/lib/actions/brokerageBilling');
    const res = await saveDealAction({ ...INPUT, unitPriceCents: 1999 });
    expect(res).toEqual({ ok: false, error: 'This price is 20.01% below list, deeper than the Sales cap of 20%. A Super Admin has to save it.' });
  });

  it('maps a permission refusal (42501)', async () => {
    process.env.STRIPE_MODE = 'test';
    rpcResult = { data: null, error: { code: '42501', message: 'Not authorized' } };
    const { saveDealAction } = await import('@/lib/actions/brokerageBilling');
    const res = await saveDealAction(INPUT);
    expect(res).toEqual({ ok: false, error: 'You do not have permission to do this.' });
  });
});

describe('checkPrice mirrors the cap (list 2499, cap 20)', () => {
  it('sweeps the boundary', async () => {
    const { checkPrice } = await import('@/lib/billing/dealRules');
    const c = (priceCents: number, canApprove = false, currentCents: number | null = null) =>
      checkPrice({ listCents: 2499, priceCents, capPct: 20, canApprove, currentCents }).kind;
    expect(c(2499)).toBe('at_list');
    expect(c(2600)).toBe('above_list');
    expect(c(2001)).toBe('within_cap');
    expect(c(2000)).toBe('within_cap');   // 19.97%
    expect(c(1999)).toBe('needs_approval'); // 20.01%
    expect(c(1999, true)).toBe('approver');
    expect(c(1999, false, 1999)).toBe('kept');
    expect(c(1998, false, 1999)).toBe('needs_approval');
  });

  it('parses dollar input', async () => {
    const { centsFromDollars } = await import('@/lib/billing/dealRules');
    expect(centsFromDollars('24.99')).toBe(2499);
    expect(centsFromDollars('$20')).toBe(2000);
    expect(centsFromDollars('19.9')).toBe(1990);
    expect(centsFromDollars('19.999')).toBeNull();
    expect(centsFromDollars('-1')).toBeNull();
  });
});

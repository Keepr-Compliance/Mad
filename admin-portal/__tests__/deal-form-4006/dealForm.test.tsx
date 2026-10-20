/**
 * BACKLOG-4006 (UI only): a NEW deal needs no typed reason (the log gets "Deal created"),
 * edits still do; the change log shows the latest 5 with "Show more"; a large modal's footer
 * carries its own padding and top border while small modals are unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Modal, ModalFooter } from '@keepr/design-system';
import {
  CHANGE_LOG_PAGE,
  NEW_DEAL_REASON,
  resolveDealReason,
  visibleChangeLog,
  type OrgBilling,
  type OrgDeal,
} from '@/lib/billing/dealRules';

const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    user: { id: 'u1' },
    supabase: { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: { success: true }, error: null }; } },
  }),
}));

const INPUT = {
  organizationId: 'o1', seats: 5, unitPriceCents: 2000, billingContactName: 'B', billingContactEmail: 'b@example.test',
  accountManagerId: null, reason: '', expectedVersion: 3,
};

// Shape of admin_get_org_billing (supabase/migrations/20261019030000_*), as in billing-card-3853/cardVisibility.test.tsx.
const DEAL: OrgDeal = {
  organization_id: 'o1', stripe_mode: 'test', status: 'active', seats: 5, start_date: '2026-10-01',
  account_manager_id: null, billing_contact_name: 'B', billing_contact_email: 'b@example.test',
  suspended_at: null, suspended_reason: null, suspended_note: null, version: 3,
};
const BILLING: OrgBilling = {
  billing_live: false, is_test: true, list_price_cents: 2499, cap_pct: 20,
  can_manage: true, can_approve: false, can_suspend: true, assigned_seats: 0,
  deal: null, seat_line: null, stripe: null, account_managers: [], log: [],
};

describe('Part 1: reason on a new deal', () => {
  it('blank reason on a NEW deal is saved as "Deal created"', () => {
    expect(resolveDealReason(false, '')).toBe('Deal created');
    expect(resolveDealReason(false, '   ')).toBe(NEW_DEAL_REASON);
  });
  it('blank reason on an EXISTING deal is refused (also a canceled deal being restarted)', () => {
    expect(resolveDealReason(true, '')).toBeNull();
    expect(resolveDealReason(true, '  ')).toBeNull();
    expect(resolveDealReason(true, 'repriced')).toBe('repriced');
  });
  it('the save action still refuses a blank reason and calls nothing', async () => {
    process.env.STRIPE_MODE = 'test';
    calls.length = 0;
    const { saveDealAction } = await import('@/lib/actions/brokerageBilling');
    const res = await saveDealAction(INPUT);
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('the form shows Reason for an existing deal (active or canceled) and hides it for a new one', async () => {
    const { DealEditor } = await import('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard');
    const html = (deal: OrgDeal | null) => renderToStaticMarkup(
      <DealEditor organizationId="o1" organizationName="Org" planName="Plan" billing={{ ...BILLING, deal }} onClose={() => {}} onSaved={() => {}} />
    );
    expect(html(null)).not.toContain('deal-reason');
    expect(html(DEAL)).toContain('deal-reason');
    expect(html({ ...DEAL, status: 'canceled' })).toContain('deal-reason');
  });
});

describe('Part 3: modal footer', () => {
  const footer = (size: 'sm' | 'lg') => {
    const html = renderToStaticMarkup(<Modal open onClose={() => {}} size={size} title="T"><ModalFooter>x</ModalFooter></Modal>);
    return /<div class="([^"]*justify-end[^"]*)"/.exec(html)![1];
  };
  it('large modal footer has px-6 py-4 and a top border', () => {
    const c = footer('lg');
    expect(c).toContain('px-6');
    expect(c).toContain('py-4');
    expect(c).toContain('border-t');
  });
  it('small modal footer is unchanged', () => {
    expect(footer('sm')).toBe('mt-6 flex justify-end gap-3');
  });
});

describe('Part 4: change log shows the latest 5', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => i);
  it.each([
    [0, 0, 0], [4, 4, 0], [5, 5, 0], [6, 5, 1], [20, 5, 15],
  ])('%i entries: %i shown, %i hidden', (n, shown, hidden) => {
    const r = visibleChangeLog(mk(n), false);
    expect(r.visible).toEqual(mk(n).slice(0, shown));
    expect(r.hidden).toBe(hidden);
  });
  it('expanded shows every entry', () => {
    expect(visibleChangeLog(mk(20), true)).toEqual({ visible: mk(20), hidden: 0 });
  });
  it('page size is 5', () => { expect(CHANGE_LOG_PAGE).toBe(5); });
});

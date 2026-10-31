/**
 * BACKLOG-3860 PR-3 — the Plans page reads the trial setting and its last audit row and hands them to
 * the card; Edit follows can_edit from admin_get_solo_trial_setting (controls b, d, e).
 * Drives the real server page with a fake Supabase client (pattern of billing-card-3853/cardVisibility).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ABSENT, AUDIT_ROW, PRESENT_OFF, PRESENT_ON } from './fixtures';

vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('@keepr/design-system', () => ({ PageHeader: () => null }));
vi.mock('@/app/dashboard/plans/components/PlansPageClient', () => ({ PlansPageClient: () => null }));
function FreeTrialCardStub() { return null; }
vi.mock('@/app/dashboard/plans/components/FreeTrialCard', () => ({ FreeTrialCard: FreeTrialCardStub }));

type Reply = { data: unknown; error: unknown };
const state: { trial: Reply; logs: Reply; calls: Array<{ fn: string; args?: Record<string, unknown> }> } = {
  trial: { data: PRESENT_OFF, error: null }, logs: { data: { logs: [], total: 0 }, error: null }, calls: [],
};

function table(name: string) {
  const rows: Record<string, unknown> = { internal_roles: { role_id: 'r1' }, plans: [] };
  const result = { data: rows[name] ?? null, error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'single']) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    user: { id: 'u1' },
    supabase: {
      from: (n: string) => table(n),
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        state.calls.push({ fn, args });
        if (fn === 'has_permission') return { data: true, error: null };
        if (fn === 'admin_get_solo_trial_setting') return state.trial;
        if (fn === 'admin_get_audit_logs') return state.logs;
        return { data: null, error: null };
      },
    },
  }),
}));

function cardProps(node: ReactNode): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) { const p = cardProps(n); if (p) return p; }
    return null;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === FreeTrialCardStub) return el.props ?? null;
  return el.props ? cardProps(el.props.children as ReactNode) : null;
}

async function render() {
  const { default: Page } = await import('@/app/dashboard/plans/page');
  return cardProps((await Page()) as ReactNode);
}

describe('Plans page Free trial card', () => {
  beforeEach(() => {
    state.calls.length = 0;
    state.trial = { data: PRESENT_OFF, error: null };
    state.logs = { data: { logs: [], total: 0 }, error: null };
  });

  it('(b) passes canEdit true when can_edit is true', async () => {
    expect((await render())?.canEdit).toBe(true);
  });
  it('(b) passes canEdit false when can_edit is false', async () => {
    state.trial = { data: { ...PRESENT_ON, can_edit: false }, error: null };
    const p = await render();
    expect(p?.canEdit).toBe(false);
    expect(p?.setting).toEqual({ ...PRESENT_ON, can_edit: false });
  });
  it('(e) hands an absent-row read to the card unchanged', async () => {
    state.trial = { data: ABSENT, error: null };
    expect((await render())?.setting).toEqual(ABSENT);
  });
  it('a refused read gives the card no setting and no Edit', async () => {
    state.trial = { data: null, error: { code: '42501', message: 'Not authorized' } };
    const p = await render();
    expect(p?.setting).toBeNull();
    expect(p?.canEdit).toBe(false);
  });
  it('(d) reads the newest solo-trial audit row and hands it to the card', async () => {
    state.logs = { data: { logs: [AUDIT_ROW], total: 1 }, error: null };
    const p = await render();
    expect(p?.lastChange).toEqual(AUDIT_ROW);
    const read = state.calls.find((c) => c.fn === 'admin_get_audit_logs');
    expect(read?.args).toMatchObject({ p_limit: 1, p_offset: 0, p_action: 'billing.solo_trial_updated' });
  });
  it('(d) no audit row gives lastChange null', async () => {
    expect((await render())?.lastChange).toBeNull();
  });
});
